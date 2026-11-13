import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load.js";
import { detectProject } from "../detect/index.js";
import { formatPlan } from "./format.js";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

/** Commands from docs/SCOPE.md that are planned but not built yet, with the milestone that ships them. */
const PLANNED: Record<string, { milestone: string; summary: string }> = {
  init: {
    milestone: "M1",
    summary: "Detect, interview, and generate a pipeline as a pull request",
  },
  check: { milestone: "M1", summary: "Run the pipeline's CI checks locally" },
  upgrade: { milestone: "M1", summary: "Regenerate workflows from hollow.yml" },
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
  plan        Show what The Hollow detects in this project and validate hollow.yml (read-only)
${Object.entries(PLANNED)
  .map(
    ([name, { milestone, summary }]) => `  ${name.padEnd(10)}  ${summary} (coming in ${milestone})`,
  )
  .join("\n")}

Options:
  --cwd <dir>  Project directory (default: current directory)
  --json       Machine-readable output (plan only)
  -h, --help   Show this help
  -v, --version
`;

export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export function run(argv: readonly string[], io: Io): number {
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

  if (command === "plan") {
    return plan(values.cwd ?? io.cwd, values.json ?? false, io);
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

  if (json) {
    io.stdout(`${JSON.stringify({ detection, config }, null, 2)}\n`);
  } else {
    io.stdout(formatPlan(detection, config));
  }
  return config.status === "invalid" ? EXIT.failure : EXIT.ok;
}

function version(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}
