import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG_FILE, loadConfig } from "../config/load.js";
import { detectProject } from "../detect/index.js";
import { type PipelinePlan, planPipeline } from "../pipeline/plan.js";
import { osvFindings } from "../pipeline/severity.js";
import { type Command, exec } from "../util/exec.js";
import { ProjectFiles } from "../util/project-files.js";

export const CHECK_IDS = [
  "lint",
  "format",
  "typecheck",
  "test",
  "build",
  "secrets",
  "dependencies",
] as const;
export type CheckStepId = (typeof CHECK_IDS)[number];

export interface CheckOptions {
  dir: string;
  install: boolean;
  /** Run only these checks. */
  only?: CheckStepId[] | undefined;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type Outcome =
  | { status: "passed" | "failed"; durationMs: number; detail?: string }
  | { status: "skipped"; detail: string };

interface Row {
  name: string;
  outcome: Outcome;
}

/**
 * `hollow check`: run the same checks as the generated CI, on this machine, against the
 * dependencies already installed. It runs the project's own scripts, the same way `npm run` does.
 */
export async function check(options: CheckOptions): Promise<number> {
  const { stdout, stderr } = options;
  let plan: PipelinePlan;
  let root: string;
  try {
    const detection = detectProject(options.dir);
    root = detection.root;
    const config = loadConfig(root);
    if (config.status === "invalid") {
      stderr(`${CONFIG_FILE} is invalid:\n${config.errors.map((e) => `  - ${e}`).join("\n")}\n`);
      return 1;
    }
    const result = planPipeline(detection, config.status === "ok" ? config.config : null);
    if (result.status === "error") {
      stderr(`${result.error}\n`);
      return 1;
    }
    plan = result.plan;
  } catch (error) {
    stderr(`${(error as Error).message}\n`);
    return 1;
  }

  const env = localEnv(root, plan);
  const wanted = (id: CheckStepId) => options.only === undefined || options.only.includes(id);
  const rows: Row[] = [];
  const run = async (name: string, command: Command): Promise<Outcome> => {
    stdout(
      `\n==> ${name}: ${"shell" in command ? command.shell : [command.file, ...command.args].join(" ")}\n`,
    );
    const result = await exec(command, { cwd: root, env, stdout, stderr });
    if (result.missing) return { status: "skipped", detail: "not installed" };
    return { status: result.code === 0 ? "passed" : "failed", durationMs: result.durationMs };
  };

  stdout(`Running the CI checks for ${root}\n`);
  if (plan.services.length > 0) {
    const services = plan.services.map((s) => s.engine).join(", ");
    const vars = [...new Set(plan.services.flatMap((s) => Object.keys(s.env)))];
    const unset = vars.filter((v) => process.env[v] === undefined);
    stdout(
      `CI starts ${services} for the tests. Here they use your own environment${
        unset.length > 0 ? ` (${unset.join(", ")} not set)` : ""
      }.\n`,
    );
  }

  if (options.install) {
    const outcome = await run("Install dependencies", { shell: plan.install.join(" && ") });
    rows.push({ name: "Install dependencies", outcome });
    if (outcome.status !== "passed") {
      stderr("\nInstalling dependencies failed, so the checks did not run.\n");
      return summarize(rows, stdout);
    }
  }

  for (const step of plan.checks) {
    if (!wanted(step.id)) continue;
    if (step.placeholder) {
      rows.push({
        name: "Test",
        outcome: { status: "skipped", detail: "no tests found (CI warns too)" },
      });
      continue;
    }
    rows.push({ name: step.name, outcome: await run(step.name, { shell: step.run }) });
  }

  if (wanted("secrets")) {
    const gitleaks = process.env.HOLLOW_GITLEAKS ?? "gitleaks";
    const mode = new ProjectFiles(root).exists(".git") ? "git" : "dir";
    const outcome = await run("Secret scan (Gitleaks)", {
      file: gitleaks,
      args: [mode, "--redact", "--exit-code", "1", "."],
    });
    rows.push({ name: "Secret scan (Gitleaks)", outcome: notInstalled(outcome, "gitleaks") });
  }

  if (wanted("dependencies")) {
    rows.push({
      name: "Dependency scan (OSV-Scanner)",
      outcome: await dependencyScan(root, plan, env, options),
    });
  }

  return summarize(rows, stdout);
}

async function dependencyScan(
  root: string,
  plan: PipelinePlan,
  env: NodeJS.ProcessEnv,
  { stdout, stderr }: CheckOptions,
): Promise<Outcome> {
  const scanner = process.env.HOLLOW_OSV_SCANNER ?? "osv-scanner";
  const dir = mkdtempSync(path.join(tmpdir(), "hollow-osv-"));
  const report = path.join(dir, "osv.json");
  try {
    stdout(`\n==> Dependency scan (OSV-Scanner): ${scanner} scan source --recursive .\n`);
    const result = await exec(
      {
        file: scanner,
        args: ["scan", "source", "--recursive", "--format", "json", "--output", report, "."],
      },
      { cwd: root, env, stdout: () => {}, stderr },
    );
    if (result.missing) return notInstalled({ status: "skipped", detail: "" }, "osv-scanner");
    if (result.code === 128) {
      stdout("No lockfiles or manifests found to scan.\n");
      return { status: "passed", durationMs: result.durationMs };
    }
    if (result.code !== 0 && result.code !== 1) {
      return {
        status: "failed",
        durationMs: result.durationMs,
        detail: `scanner exited with ${result.code}`,
      };
    }
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(readFileSync(report, "utf8"));
    } catch {
      if (result.code === 1) {
        return {
          status: "failed",
          durationMs: result.durationMs,
          detail: "could not read the report",
        };
      }
    }
    const findings = osvFindings(parsed, plan.security.failOn);
    for (const f of findings) {
      stdout(
        `  ${f.blocking ? "BLOCKS" : "note  "}  ${f.ecosystem} ${f.pkg} (${f.ids.join(", ")}), CVSS ${f.cvss ?? "unknown"}\n`,
      );
    }
    const blocking = findings.filter((f) => f.blocking).length;
    if (findings.length === 0) stdout("No known vulnerabilities in dependencies.\n");
    return blocking > 0
      ? {
          status: "failed",
          durationMs: result.durationMs,
          detail: `${blocking} at ${plan.security.failOn} or worse`,
        }
      : { status: "passed", durationMs: result.durationMs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function notInstalled(outcome: Outcome, tool: string): Outcome {
  return outcome.status === "skipped"
    ? { status: "skipped", detail: `${tool} is not installed; CI runs it` }
    : outcome;
}

/**
 * The environment for local runs. For pip projects the virtualenv's bin directory goes first on
 * PATH, so `ruff` and `pytest` resolve the same way they would inside an activated venv.
 */
function localEnv(root: string, plan: PipelinePlan): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (plan.packageManager === "pip") {
    const files = new ProjectFiles(root);
    const bin = process.platform === "win32" ? ".venv/Scripts" : ".venv/bin";
    const resolved = files.exists(bin) ? files.resolve(bin) : null;
    if (resolved !== null) env.PATH = `${resolved}${path.delimiter}${env.PATH ?? ""}`;
  }
  return env;
}

function summarize(rows: Row[], stdout: (text: string) => void): number {
  const width = Math.max(...rows.map((r) => r.name.length), 10);
  stdout("\nSummary\n");
  for (const { name, outcome } of rows) {
    const time = "durationMs" in outcome ? `${(outcome.durationMs / 1000).toFixed(1)}s` : "";
    const detail = outcome.detail === undefined ? "" : `  ${outcome.detail}`;
    stdout(
      `  ${outcome.status.padEnd(8)} ${name.padEnd(width)}  ${time}${detail}\n`.replace(
        / +\n$/,
        "\n",
      ),
    );
  }
  const failed = rows.filter((r) => r.outcome.status === "failed").length;
  const ran = rows.filter((r) => r.outcome.status !== "skipped").length;
  const skipped = rows.length - ran;
  const note = skipped > 0 ? ` (${skipped} skipped)` : "";
  if (ran === 0) stdout(`\nNo checks ran${note}.\n`);
  else if (failed === 0) stdout(`\nAll checks passed: ${ran} ran${note}.\n`);
  else stdout(`\n${failed} of ${ran} checks failed${note}.\n`);
  return failed === 0 ? 0 : 1;
}
