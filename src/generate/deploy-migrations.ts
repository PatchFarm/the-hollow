import type { MigrationPlan } from "../pipeline/migrations.js";
import type { PipelinePlan } from "../pipeline/plan.js";
import { checkout, lines, setupSteps } from "./ci.js";
import type { ReleaseSource } from "./gate.js";
import { IMAGES } from "./pins.js";
import { expr } from "./render.js";

type Step = Record<string, unknown>;

/** True when this environment's deploy job migrates its database from the runner. */
export function migratesFromRunner(plan: PipelinePlan, environment: string): boolean {
  const deploy = plan.migrations?.deploy;
  return deploy?.where === "runner" && deploy.environments.some((name) => name === environment);
}

/**
 * Apply the migrations to the environment's database, with the URL from its environment secret.
 * Runs after the install and before anything goes live, so a failed migration stops the deploy.
 */
export function migrateStep(plan: PipelinePlan, environment: string, hint = ""): Step {
  const migrations = plan.migrations as MigrationPlan;
  const secret = migrations.deploy?.secret ?? "DATABASE_URL";
  return {
    name: `Apply the ${migrations.tool} migrations to the ${environment} database`,
    env: { DATABASE_URL: expr(`secrets.${secret}`) },
    run: lines([
      'if [ -z "$DATABASE_URL" ]; then',
      `  echo "::error title=Missing secret::Add the ${secret} secret${hint} to the ${environment} environment (Settings > Environments > ${environment}), so its database is migrated before the new code goes live. If the app applies its own migrations, set database.migrations to none in hollow.yml."`,
      "  exit 1",
      "fi",
      migrations.apply,
    ]),
  };
}

/** For jobs that do not build: check out the release, install, then migrate. */
export function migrateFromRunner(
  plan: PipelinePlan,
  environment: string,
  source: ReleaseSource,
  hint = "",
): Step[] {
  return [
    // A manual run deploys an older release, so it migrates with that release's migrations.
    source.manual ? checkout({ ref: source.tag }) : checkout(),
    ...setupSteps(plan),
    { name: "Install dependencies", run: lines(plan.install) },
    migrateStep(plan, environment, hint),
  ];
}

/**
 * Runs on the server, inside the backup container: dump the database named by DATABASE_URL (from
 * the environment's .env) to backups/, and keep the newest seven.
 */
function backupScript(engine: "postgres" | "mysql"): string[] {
  const start = [
    "set -eu",
    "umask 077",
    'url="$(printenv DATABASE_URL || true)"',
    'if [ -z "$url" ]; then',
    `  echo "DATABASE_URL is not set in this environment's .env, so there is nothing to back up." >&2`,
    "  exit 1",
    "fi",
    'stamp="$(date -u +%Y%m%dT%H%M%SZ)"',
  ];
  const dump =
    engine === "postgres"
      ? [
          // pg_dump wants a plain postgresql:// URL: drop a driver suffix (postgresql+psycopg)
          // and options other tools add (?schema=public), but keep sslmode.
          "ssl=\"$(printf '%s' \"$url\" | sed -nE 's/.*[?&](sslmode=[a-z-]+).*/\\1/p')\"",
          "url=\"$(printf '%s' \"$url\" | sed -E 's#^postgres(ql)?(\\+[A-Za-z0-9_]+)?://#postgresql://#; s#\\?.*$##')\"",
          'if [ -n "$ssl" ]; then url="$url?$ssl"; fi',
          'file="/backups/$stamp.dump"',
          "trap 'rm -f -- \"$file.partial\"' EXIT",
          'pg_dump --format=custom --no-owner --dbname="$url" --file="$file.partial"',
        ]
      : [
          // mysqldump takes the parts of mysql://user:password@host:port/database, not the URL.
          // Plain shell and awk only: the MySQL image is a slim Oracle Linux.
          `rest="\${url#*://}"`,
          `rest="\${rest%%\\?*}"`,
          'case "$rest" in',
          `  *@*) creds="\${rest%@*}"; rest="\${rest##*@}" ;;`,
          '  *) creds="" ;;',
          "esac",
          `user="\${creds%%:*}"`,
          `case "$creds" in *:*) password="\${creds#*:}" ;; *) password="" ;; esac`,
          `hostport="\${rest%%/*}"`,
          `case "$rest" in */*) database="\${rest#*/}" ;; *) database="" ;; esac`,
          `host="\${hostport%%:*}"`,
          `case "$hostport" in *:*) port="\${hostport#*:}" ;; *) port=3306 ;; esac`,
          // URLs percent-encode special characters in passwords.
          "decode() {",
          "  printf '%s' \"$1\" | LC_ALL=C awk '",
          '    function hex(c) { return index("0123456789abcdef", tolower(c)) - 1 }',
          "    {",
          '      s = $0; out = ""',
          "      while (match(s, /%[0-9A-Fa-f][0-9A-Fa-f]/)) {",
          '        out = out substr(s, 1, RSTART - 1) sprintf("%c", hex(substr(s, RSTART + 1, 1)) * 16 + hex(substr(s, RSTART + 2, 1)))',
          "        s = substr(s, RSTART + 3)",
          "      }",
          '      printf "%s", out s',
          "    }'",
          "}",
          'MYSQL_PWD="$(decode "$password")"',
          "export MYSQL_PWD",
          'user="$(decode "$user")"',
          'file="/backups/$stamp.sql"',
          "trap 'rm -f -- \"$file.partial\"' EXIT",
          'mysqldump --single-transaction --routines --triggers --no-tablespaces --host="$host" --port="$port" --user="$user" --result-file="$file.partial" "$database"',
        ];
  const extension = engine === "postgres" ? "dump" : "sql";
  return [
    ...start,
    ...dump,
    'mv -- "$file.partial" "$file"',
    'echo "Backed up the database to backups/$(basename "$file")."',
    `ls -1t /backups/*.${extension} | tail -n +8 | while IFS= read -r old; do rm -f -- "$old"; done`,
  ];
}

/** The backup container, added next to the project's compose.yaml for one `compose run`. */
function backupService(engine: "postgres" | "mysql"): string[] {
  return [
    "services:",
    "  hollow-backup:",
    `    image: ${IMAGES[engine].image}`,
    "    profiles: [hollow-backup]",
    "    env_file:",
    "      - path: .env",
    "        required: false",
    "    volumes:",
    "      - ./backups:/backups",
    "      - ./.hollow-backup.sh:/hollow-backup.sh:ro",
    '    entrypoint: ["sh", "/hollow-backup.sh"]',
  ];
}

/**
 * VPS: runs on the server after the new image is pulled and before it starts. The server shell
 * reads this script from stdin, so every `compose run` gets /dev/null instead (it attaches stdin
 * by default and would swallow the rest of the script).
 *
 * Back the database up (a failed backup stops everything, except on the first deploy, when there
 * is no earlier version to protect), then apply the migrations inside the new image. Either
 * failing keeps the previous version running.
 */
export function vpsMigrationLines(migrations: MigrationPlan): string[] {
  const deploy = migrations.deploy;
  if (deploy === null || deploy.where !== "image") return [];
  const keep = [
    "keep_previous() {",
    "  if [ -f .hollow.env.previous ]; then cp .hollow.env.previous .hollow.env; else rm -f .hollow.env; fi",
    "}",
  ];
  const backup =
    deploy.backup === null
      ? []
      : [
          "mkdir -p backups",
          "chmod 700 backups",
          "cat > .hollow-backup.yaml << 'YAML'",
          ...backupService(deploy.backup),
          "YAML",
          "cat > .hollow-backup.sh << 'SCRIPT'",
          ...backupScript(deploy.backup),
          "SCRIPT",
          'if compose --file compose.yaml --file .hollow-backup.yaml --profile hollow-backup run --rm -T --user "$(id -u):$(id -g)" hollow-backup < /dev/null; then',
          "  :",
          "elif [ -f .hollow.env.previous ]; then",
          "  keep_previous",
          '  echo "The database backup failed, so nothing was migrated or deployed." >&2',
          "  exit 1",
          "else",
          '  echo "The database backup failed. This is the first deploy, so it goes ahead without one." >&2',
          "fi",
        ];
  return [
    ...keep,
    ...backup,
    `if ! compose run --rm -T app ${deploy.imageCommand} < /dev/null; then`,
    "  keep_previous",
    `  echo "The ${migrations.tool} migrations failed, so the new version was not started and the previous one keeps running.${deploy.backup === null ? "" : " The backup from just before is in backups/."}" >&2`,
    "  exit 1",
    "fi",
  ];
}

/** Said whenever code is rolled back after its migrations ran. */
export const SCHEMA_STAYS =
  "The database stays migrated: a rollback restores the previous code, not the schema.";
