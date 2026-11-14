import path from "node:path";
import type { HollowConfig } from "../config/schema.js";
import type { Detection, Language, MigrationTool, PackageManager } from "../detect/types.js";
import type { ProjectFiles } from "../util/project-files.js";
import type { DeployPlan, EnvironmentName } from "./deploy.js";

/** How the project's migrations are applied and checked. */
export interface MigrationPlan {
  tool: MigrationTool;
  /** Applies every migration to DATABASE_URL. */
  apply: string;
  /** Django only: fails when models changed without a migration. */
  missingCheck: string | null;
  /** Patterns (fnmatch, relative to the repo root) for the safety check's migration files. */
  paths: string[];
  /** PR label that lets a destructive migration merge. */
  label: string;
  /** Whether CI has a database to apply them to. */
  appliesInCi: boolean;
  /** Extra env for applying them in CI (a throwaway SQLite file, for example). */
  ciEnv: Record<string, string>;
  /** How deploys migrate each environment's database, or null when nothing deploys them. */
  deploy: DeployMigrations | null;
}

/**
 * Deploys migrate an environment's database before its new code goes live.
 *
 * - runner: the deploy job checks out the release, installs, and applies the migrations with the
 *   environment's database URL secret (Docker, Vercel, Cloudflare).
 * - image: VPS. The server backs the database up, then applies the migrations inside the new
 *   release image, with the environment's .env, before starting it.
 */
export interface DeployMigrations {
  where: "runner" | "image";
  /** Environment secret with the database URL (runner only). */
  secret: string;
  /** Environments whose deploy migrates. */
  environments: EnvironmentName[];
  /** VPS: the command that applies the migrations inside the release image. */
  imageCommand: string;
  /** VPS: the dump tool that backs the database up first, or null when there is none to use. */
  backup: "postgres" | "mysql" | null;
}

const NODE_EXEC: Record<string, string> = {
  npm: "npm exec --no -- ",
  pnpm: "pnpm exec ",
  yarn: "yarn run ",
  bun: "bun run ",
};
const PYTHON_PREFIX: Record<string, string> = {
  uv: "uv run --no-sync ",
  poetry: "poetry run ",
  pip: "",
};

interface MigrationInput {
  detection: Detection;
  files: ProjectFiles;
  config: HollowConfig | null;
  language: Language;
  packageManager: PackageManager;
  /** Engines CI starts a service container for. */
  serviceEngines: string[];
  deploy: DeployPlan | null;
  notes: string[];
}

export function planMigrations(input: MigrationInput): MigrationPlan | null {
  const { detection, files, config, notes } = input;
  const setting = config?.database.migrations ?? "auto";
  if (setting === "none") return null;
  const tool = setting === "auto" ? (detection.database.migrationTool?.value ?? null) : setting;
  if (tool === null) return null;

  const run =
    input.language === "node"
      ? (NODE_EXEC[input.packageManager] ?? "npm exec --no -- ")
      : (PYTHON_PREFIX[input.packageManager] ?? "");
  const label = config?.database.destructiveChangeLabel ?? "allow-destructive-migration";

  // The tool's own words, run through the package manager in CI and as-is inside the image.
  let args: string[];
  let paths: string[];
  let missingCheck: string | null = null;
  switch (tool) {
    case "prisma": {
      const source = detection.database.migrationTool?.source ?? "";
      const dir = source.endsWith(".prisma") ? path.posix.dirname(source) : "prisma";
      args = ["prisma", "migrate", "deploy"];
      paths = [`${dir === "." ? "" : `${dir}/`}migrations/*/migration.sql`];
      break;
    }
    case "drizzle": {
      args = ["drizzle-kit", "migrate"];
      paths = [`${drizzleOut(files)}/*.sql`];
      break;
    }
    case "alembic": {
      args = ["alembic", "upgrade", "head"];
      paths = [`${alembicLocation(files)}/versions/*.py`];
      break;
    }
    case "django": {
      args = ["python", "manage.py", "migrate", "--noinput"];
      missingCheck = `${run}python manage.py makemigrations --check --dry-run`;
      paths = ["*migrations/[0-9]*.py"];
      break;
    }
  }
  const apply = `${run}${args.join(" ")}`;

  const engines = detection.database.engines.map((engine) => engine.value);
  const server = input.serviceEngines.some((engine) => engine === "postgres" || engine === "mysql");
  const sqlite = engines.includes("sqlite");
  let appliesInCi = server || sqlite || tool === "django";
  const ciEnv: Record<string, string> = {};
  if (!server && sqlite && (tool === "prisma" || tool === "drizzle")) {
    ciEnv.DATABASE_URL = "file:./hollow-ci.db";
  }
  if (!appliesInCi) {
    notes.push(
      `CI cannot apply the ${tool} migrations: it found no database engine to start for them. Add the database driver to the project's dependencies, then run \`hollow upgrade\`.`,
    );
    appliesInCi = false;
  }
  const deploy =
    input.deploy === null
      ? null
      : planDeployMigrations(input, tool, args, input.deploy, config?.database.urlSecret);
  return { tool, apply, missingCheck, paths, label, appliesInCi, ciEnv, deploy };
}

/** The CLI each Node tool needs at deploy time, which the image may have pruned. */
const NODE_CLI: Partial<Record<MigrationTool, string>> = {
  prisma: "prisma",
  drizzle: "drizzle-kit",
};

function planDeployMigrations(
  input: MigrationInput,
  tool: MigrationTool,
  args: string[],
  deploy: DeployPlan,
  urlSecret: string | undefined,
): DeployMigrations | null {
  const { notes } = input;
  const engines = input.detection.database.engines.map((engine) => engine.value);
  const server = engines.find((engine) => engine === "postgres" || engine === "mysql") ?? null;
  const names = deploy.environments.map((environment) => environment.name);
  const secret = urlSecret ?? "DATABASE_URL";

  if (deploy.vps !== null) {
    const backup = server === "postgres" || server === "mysql" ? server : null;
    if (backup === null) {
      notes.push(
        engines.includes("sqlite")
          ? "VPS deploys apply migrations without a backup first: The Hollow backs up PostgreSQL and MySQL, not SQLite files. Back the database file up yourself."
          : "VPS deploys apply migrations without a backup first, since The Hollow could not tell which database the app uses. Add the PostgreSQL or MySQL driver to the dependencies and run `hollow upgrade` to get one.",
      );
    }
    const cli = NODE_CLI[tool];
    if (input.language === "node" && cli !== undefined && onlyDevDependency(input.files, cli)) {
      notes.push(
        `VPS deploys apply migrations inside the release image, but ${cli} is only in devDependencies. Move it to dependencies: the starter Dockerfile leaves dev dependencies out of the image.`,
      );
    }
    return {
      where: "image",
      secret,
      environments: names,
      // The image runs the tool directly: Node images always have npm, Python images have the venv on PATH.
      imageCommand: (input.language === "node"
        ? ["npm", "exec", "--no", "--", ...args]
        : args
      ).join(" "),
      backup,
    };
  }

  if (server === null && engines.includes("sqlite")) {
    notes.push(
      `Deploys do not apply the ${tool} migrations: the app uses SQLite, which the pipeline cannot reach. Apply them where the database file lives.`,
    );
    return null;
  }
  // Which environments have their own database:
  // - Vercel's staging is a staged production deployment, so it shares production's database and
  //   migrates on release. Preprod serves that deployment too, so it migrates first.
  // - A Workers Version URL uses the production Worker's bindings, so only production migrates.
  // - Docker and Pages environments each have their own settings and database.
  const environments =
    deploy.target === "vercel"
      ? names.filter((name) => name !== "staging")
      : deploy.target === "cloudflare-workers"
        ? names.filter((name) => name === "production")
        : names;
  return { where: "runner", secret, environments, imageCommand: "", backup: null };
}

function onlyDevDependency(files: ProjectFiles, name: string): boolean {
  try {
    const manifest = JSON.parse(files.readText("package.json") ?? "{}") as Record<
      string,
      Record<string, unknown> | undefined
    >;
    return (
      manifest.devDependencies?.[name] !== undefined && manifest.dependencies?.[name] === undefined
    );
  } catch {
    return false;
  }
}

const SAFE_DIR = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function cleanDir(value: string | undefined, fallback: string): string {
  const dir = value?.replace(/^\.\//, "").replace(/\/+$/, "");
  return dir !== undefined && SAFE_DIR.test(dir) && !dir.split("/").includes("..") ? dir : fallback;
}

/** Drizzle writes migrations to `out` in drizzle.config (default `drizzle`). */
function drizzleOut(files: ProjectFiles): string {
  for (const name of [
    "drizzle.config.ts",
    "drizzle.config.js",
    "drizzle.config.mjs",
    "drizzle.config.json",
  ]) {
    const text = files.readText(name);
    if (text === null) continue;
    const match = /["']?out["']?\s*:\s*["']([^"']+)["']/.exec(text);
    return cleanDir(match?.[1], "drizzle");
  }
  return "drizzle";
}

/** Alembic's `script_location` in alembic.ini (default `migrations`). */
function alembicLocation(files: ProjectFiles): string {
  const text = files.readText("alembic.ini") ?? "";
  const match = /^\s*script_location\s*=\s*(.+?)\s*$/m.exec(text);
  return cleanDir(match?.[1]?.replace("%(here)s/", ""), "migrations");
}
