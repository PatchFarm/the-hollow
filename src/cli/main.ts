import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
import { detectProject } from "../detect/index.js";
import { isRepoName } from "../github/api.js";
import { planPipeline } from "../pipeline/plan.js";
import { ghWriter, type HostKeyTools, systemHostKeyTools, type Writer } from "../secrets/github.js";
import { CHECK_IDS, type CheckStepId, check } from "./check-command.js";
import { formatPlan } from "./format.js";
import { init, upgrade } from "./generate-command.js";
import type { Ask } from "./interview.js";
import { type Connect, ghConnect, protect } from "./protect-command.js";
import { secrets } from "./secrets-command.js";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  /** Prompt the person at the keyboard. Absent when input is not a terminal. */
  ask?: Ask;
  /** Prompt without echoing what is typed, for secret values. Absent when not a terminal. */
  askSecret?: Ask;
  /** Read everything piped to stdin. Present only when stdin is not a terminal. */
  readStdin?: () => Promise<string>;
  /** How `hollow protect` and `hollow secrets` reach GitHub. Defaults to gh; tests pass fakes. */
  connect?: Connect;
  secretsWriter?: (cwd: string) => Writer;
  hostKeys?: HostKeyTools;
}

/** Commands from docs/SCOPE.md that are planned but not built yet, with the milestone that ships them. */
const PLANNED: Record<string, { milestone: string; summary: string }> = {
  fix: { milestone: "M5", summary: "Repair the latest failed pipeline run" },
  doctor: {
    milestone: "M6",
    summary: "Audit an existing pipeline against The Hollow's principles",
  },
};

const HELP = `hollow: set up a secure CI/CD pipeline on GitHub Actions

Usage:
  hollow <command> [options]

Commands:
  plan        Show what The Hollow detects and the CI it would generate (read-only)
  init        Create hollow.yml and generate the CI workflow and Dependabot config
  upgrade     Regenerate the files The Hollow owns from hollow.yml
  check       Run the CI checks on this machine, using the dependencies already installed
  protect     Apply branch rules, environments and security settings on GitHub (asks first)
  secrets     List the secrets and variables the pipeline needs, set or missing, and set them
              (\`hollow secrets set NAME [--env ENV]\` sets one, reading the value from stdin)
${Object.entries(PLANNED)
  .map(
    ([name, { milestone, summary }]) => `  ${name.padEnd(10)}  ${summary} (coming in ${milestone})`,
  )
  .join("\n")}

Options:
  --cwd <dir>        Project directory (default: current directory)
  --json             Machine-readable output (plan)
  --dry-run          Show what would change without changing anything (init, upgrade, protect)
  --force            Replace existing files The Hollow did not write (init, upgrade)
  --target <name>    Deploy target: vercel, cloudflare-workers, cloudflare-pages, docker, vps (init)
  --yes              Accept every suggested answer without asking (init), or apply without
                     confirming (protect)
  --repo <owner/name>  GitHub repo to use, if not the one this folder's git remote points at (protect, secrets)
  --env <name>       Environment a value belongs to (secrets set)
  --install          Run the locked install CI uses before checking (check)
  --only <ids>       Run only some checks, comma-separated: ${CHECK_IDS.join(", ")} (check)
  --no-ai            Never call a model. This release makes no AI calls, so it is the default.
  -h, --help         Show this help
  -v, --version
`;

export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  plan: ["json"],
  init: ["dry-run", "force", "target", "yes"],
  upgrade: ["dry-run", "force"],
  check: ["install", "only"],
  protect: ["dry-run", "yes", "repo"],
  secrets: ["repo", "env"],
};
const GLOBAL_OPTIONS = ["cwd", "help", "version", "no-ai"];

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\nRun \`hollow --help\` for usage.\n`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    io.stdout(`${version()}\n`);
    return EXIT.ok;
  }
  const [command, ...extra] = positionals;
  if (values.help || command === undefined || command === "help") {
    io.stdout(HELP);
    return EXIT.ok;
  }
  const secretsSet = command === "secrets" && extra[0] === "set" && extra.length === 2;
  if (extra.length > 0 && !secretsSet) {
    io.stderr(
      command === "secrets" && extra[0] === "set"
        ? "Usage: hollow secrets set NAME [--env ENV]\n"
        : `Unexpected argument: ${extra[0]}\n`,
    );
    return EXIT.usage;
  }
  if (values.env !== undefined && !secretsSet) {
    io.stderr("--env only applies to `hollow secrets set`.\n");
    return EXIT.usage;
  }

  const allowed = COMMAND_OPTIONS[command];
  if (allowed !== undefined) {
    const misplaced = Object.keys(values).find(
      (name) => !GLOBAL_OPTIONS.includes(name) && !allowed.includes(name),
    );
    if (misplaced !== undefined) {
      io.stderr(`--${misplaced} does not apply to \`hollow ${command}\`.\n`);
      return EXIT.usage;
    }
  }

  const dir = values.cwd ?? io.cwd;
  const output = { stdout: io.stdout, stderr: io.stderr };
  switch (command) {
    case "plan":
      return plan(dir, values.json ?? false, io);
    case "init":
      return init({
        dir,
        force: values.force ?? false,
        dryRun: values["dry-run"] ?? false,
        target: values.target,
        yes: values.yes ?? false,
        ask: io.ask,
        ...output,
      });
    case "check": {
      const only = values.only
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const unknown = only?.find((id) => !(CHECK_IDS as readonly string[]).includes(id));
      if (unknown !== undefined || (only !== undefined && only.length === 0)) {
        io.stderr(`--only takes a comma-separated list of: ${CHECK_IDS.join(", ")}.\n`);
        return EXIT.usage;
      }
      return check({
        dir,
        install: values.install ?? false,
        only: only as CheckStepId[] | undefined,
        ...output,
      });
    }
    case "protect":
      if (values.repo !== undefined && !isRepoName(values.repo)) {
        io.stderr("--repo takes a GitHub repo as owner/name.\n");
        return EXIT.usage;
      }
      return protect({
        dir,
        repo: values.repo,
        dryRun: values["dry-run"] ?? false,
        yes: values.yes ?? false,
        ask: io.ask,
        connect: io.connect ?? ghConnect,
        ...output,
      });
    case "secrets":
      if (values.repo !== undefined && !isRepoName(values.repo)) {
        io.stderr("--repo takes a GitHub repo as owner/name.\n");
        return EXIT.usage;
      }
      return secrets({
        dir,
        repo: values.repo,
        set: secretsSet ? { name: extra[1] as string, environment: values.env } : undefined,
        ask: io.ask,
        askSecret: io.askSecret,
        readStdin: io.readStdin,
        connect: io.connect ?? ghConnect,
        writer: io.secretsWriter ?? ghWriter,
        hostKeys: io.hostKeys ?? systemHostKeyTools,
        ...output,
      });
    case "upgrade":
      return upgrade({
        dir,
        force: values.force ?? false,
        dryRun: values["dry-run"] ?? false,
        ...output,
      });
  }

  const planned = PLANNED[command];
  if (planned !== undefined) {
    io.stderr(
      `\`hollow ${command}\` is not built yet. It ships in milestone ${planned.milestone} (see docs/SCOPE.md).\n`,
    );
    return EXIT.failure;
  }
  io.stderr(`Unknown command: ${command}\n\nRun \`hollow --help\` for usage.\n`);
  return EXIT.usage;
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      target: { type: "string" },
      yes: { type: "boolean", short: "y" },
      install: { type: "boolean" },
      only: { type: "string" },
      repo: { type: "string" },
      env: { type: "string" },
      "no-ai": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

function plan(dir: string, json: boolean, io: Io): number {
  let detection: ReturnType<typeof detectProject>;
  try {
    detection = detectProject(dir);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return EXIT.failure;
  }
  const config = loadConfig(detection.root);
  const pipeline = planPipeline(detection, config.status === "ok" ? config.config : null);

  if (json) {
    io.stdout(
      `${JSON.stringify({ detection, config, pipeline: pipeline.status === "ok" ? pipeline.plan : null }, null, 2)}\n`,
    );
  } else {
    io.stdout(formatPlan(detection, config, pipeline));
  }
  return config.status === "invalid" ? EXIT.failure : EXIT.ok;
}

function version(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}
