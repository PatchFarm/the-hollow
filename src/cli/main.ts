import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
import { detectProject } from "../detect/index.js";
import { planPipeline } from "../pipeline/plan.js";
import { formatPlan } from "./format.js";
import { init, upgrade } from "./generate-command.js";
import type { Ask } from "./interview.js";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  /** Prompt the person at the keyboard. Absent when input is not a terminal. */
  ask?: Ask;
}

/** Commands from docs/SCOPE.md that are planned but not built yet, with the milestone that ships them. */
const PLANNED: Record<string, { milestone: string; summary: string }> = {
  check: { milestone: "M1", summary: "Run the pipeline's CI checks locally" },
  secrets: { milestone: "M2", summary: "List and set the secrets each environment needs" },
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
${Object.entries(PLANNED)
  .map(
    ([name, { milestone, summary }]) => `  ${name.padEnd(10)}  ${summary} (coming in ${milestone})`,
  )
  .join("\n")}

Options:
  --cwd <dir>        Project directory (default: current directory)
  --json             Machine-readable output (plan)
  --dry-run          Show what would change without writing anything (init, upgrade)
  --force            Replace existing files The Hollow did not write (init, upgrade)
  --target <name>    Deploy target: vercel, cloudflare-workers, cloudflare-pages, docker, vps (init)
  --yes              Accept every suggested answer without asking (init)
  --no-ai            Never call a model. This release makes no AI calls, so it is the default.
  -h, --help         Show this help
  -v, --version
`;

export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  plan: ["json"],
  init: ["dry-run", "force", "target", "yes"],
  upgrade: ["dry-run", "force"],
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
  if (extra.length > 0) {
    io.stderr(`Unexpected argument: ${extra[0]}\n`);
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
