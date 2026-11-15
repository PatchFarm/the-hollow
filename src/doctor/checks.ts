import { CONFIG_FILE, loadConfig } from "../config/load.js";
import type { HollowConfig } from "../config/schema.js";
import type { Detection } from "../detect/index.js";
import { generateFiles } from "../generate/index.js";
import { isGenerated } from "../generate/render.js";
import { errorMessage, type GitHubApi } from "../github/api.js";
import { type PipelinePlan, planPipeline } from "../pipeline/plan.js";
import { type ProtectInput, planProtection } from "../protect/plan.js";
import { label, settingsFor } from "../secrets/catalog.js";
import { readStatus } from "../secrets/github.js";
import type { ProjectFiles } from "../util/project-files.js";
import { checkWorkflow } from "../verify/policy.js";

export type Severity = "error" | "warning" | "info";
export type Area = "workflows" | "config" | "generated" | "github";

export interface Finding {
  severity: Severity;
  area: Area;
  message: string;
  /** The command or change that fixes it. */
  fix?: string;
}

const WORKFLOW_DIR = ".github/workflows";

export interface LocalResult {
  findings: Finding[];
  /** The pipeline plan, when hollow.yml is there and valid. */
  plan: PipelinePlan | null;
  config: HollowConfig | null;
}

/**
 * Everything doctor can tell from the repo alone: every workflow against the policy (whoever wrote
 * it), hollow.yml, and The Hollow's files that are missing, out of date or edited by hand.
 */
export function localChecks(detection: Detection, files: ProjectFiles): LocalResult {
  const findings: Finding[] = [];
  const workflows = files
    .list(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => `${WORKFLOW_DIR}/${name}`);

  const loaded = loadConfig(detection.root);
  let plan: PipelinePlan | null = null;
  let config: HollowConfig | null = null;
  if (loaded.status === "missing") {
    findings.push({
      severity: "info",
      area: "config",
      message: `There is no ${CONFIG_FILE}, so the pipeline is not managed by The Hollow. Only the workflow policy was checked.`,
      fix: "Run `hollow init` to generate a pipeline that follows these rules.",
    });
  } else if (loaded.status === "invalid") {
    for (const error of loaded.errors) {
      findings.push({
        severity: "error",
        area: "config",
        message: `${CONFIG_FILE}: ${error}`,
        fix: `Fix ${CONFIG_FILE}; its schema is in the file's first line.`,
      });
    }
  } else {
    config = loaded.config;
    const result = planPipeline(detection, config);
    if (result.status === "error") {
      findings.push({ severity: "error", area: "config", message: result.error });
    } else {
      plan = result.plan;
    }
  }

  // Which workflows The Hollow writes, so a finding can point at the right fix.
  const ours = new Set(
    plan === null
      ? []
      : generateFiles(plan)
          .filter((f) => f.workflow)
          .map((f) => f.path),
  );
  if (workflows.length === 0) {
    findings.push({
      severity: "warning",
      area: "workflows",
      message: `There are no workflows in ${WORKFLOW_DIR}, so nothing checks a change before it ships.`,
      fix: "Run `hollow init`.",
    });
  }
  for (const path of workflows) {
    const text = files.readText(path);
    if (text === null) continue;
    for (const violation of checkWorkflow(text)) {
      findings.push({
        severity: "error",
        area: "workflows",
        message: `${path}: ${violation.where}: ${violation.message}`,
        fix:
          ours.has(path) && isGenerated(text)
            ? "Run `hollow upgrade`: The Hollow's current template passes."
            : `Edit ${path} (rule: ${violation.rule}).`,
      });
    }
  }

  if (plan !== null) {
    for (const file of generateFiles(plan)) {
      const current = files.readText(file.path);
      if (current === null) {
        if (file.kind === "scaffold") {
          findings.push({
            severity: "info",
            area: "generated",
            message: `${file.path} is missing. It is a starting point you own.`,
            fix: "Run `hollow init` to add the missing starting points.",
          });
        } else {
          findings.push({
            severity: file.kind === "generated" ? "warning" : "info",
            area: "generated",
            message: `${file.path} is missing.`,
            fix: "Run `hollow upgrade`.",
          });
        }
        continue;
      }
      if (file.kind === "scaffold" || current === file.content) continue;
      if (!isGenerated(current)) {
        if (file.kind === "generated") {
          findings.push({
            severity: "warning",
            area: "generated",
            message: `${file.path} was not written by The Hollow, so \`hollow upgrade\` will not update it.`,
            fix: "Move what you need into hollow.yml, then replace it with `hollow upgrade --force`.",
          });
        }
        continue;
      }
      findings.push({
        severity: "warning",
        area: "generated",
        message: `${file.path} is not what hollow.yml generates: it was edited by hand, or hollow.yml or The Hollow changed since.`,
        fix: "Move any hand edits into hollow.yml, then run `hollow upgrade` (`--dry-run` shows what it would change).",
      });
    }
    for (const note of plan.notes) {
      findings.push({ severity: "info", area: "config", message: note });
    }
  }
  return { findings, plan, config };
}

/**
 * What doctor reads from GitHub, all read-only: the settings `hollow protect` would change,
 * missing secrets, and the default branch's latest runs.
 */
export async function githubChecks(
  api: GitHubApi,
  repo: string,
  plan: PipelinePlan | null,
  protect: ProtectInput | null,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  if (plan !== null && protect !== null) {
    const result = await planProtection(api, protect);
    if (result.status === "error") {
      findings.push({
        severity: "info",
        area: "github",
        message: `Branch rules were not checked: ${result.error}`,
      });
    } else {
      for (const step of result.plan.steps) {
        if (step.status !== "change") continue;
        findings.push({
          severity: "warning",
          area: "github",
          message: `${step.title}: ${step.changes.join("; ")}`,
          fix: "Run `hollow protect` (it shows each change and asks first).",
        });
      }
      for (const step of result.plan.steps.filter((s) => s.status === "skip")) {
        findings.push({
          severity: "info",
          area: "github",
          message: `${step.title}: ${step.reason ?? "skipped"}`,
        });
      }
    }

    const settings = settingsFor(plan);
    if (settings.length > 0) {
      const status = await readStatus(api, repo, settings);
      for (const setting of settings) {
        const state = status.get(setting);
        if (state === "set" || state === "set-in-repo") continue;
        findings.push({
          severity: setting.required ? "error" : "info",
          area: "github",
          message: `${setting.kind === "secret" ? "Secret" : "Variable"} ${label(setting)} is not set${setting.required ? "" : " (optional)"}: ${setting.purpose}.`,
          fix: "Run `hollow secrets`.",
        });
      }
    }
  }

  const branch = plan?.defaultBranch ?? (await defaultBranch(api, repo));
  if (branch !== null) {
    const response = await api.request(
      "GET",
      `repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=50`,
    );
    if (response.status >= 400) {
      findings.push({
        severity: "info",
        area: "github",
        message: `Recent runs were not checked: ${errorMessage(response)}`,
      });
    } else {
      const seen = new Set<string>();
      const runs = ((response.data as { workflow_runs?: unknown[] }).workflow_runs ?? []) as Record<
        string,
        unknown
      >[];
      for (const run of runs) {
        const name = String(run.name ?? "");
        if (seen.has(name) || run.status !== "completed") continue;
        seen.add(name);
        if (
          run.conclusion === "failure" ||
          run.conclusion === "timed_out" ||
          run.conclusion === "startup_failure"
        ) {
          findings.push({
            severity: "warning",
            area: "github",
            message: `The latest ${name} run on ${branch} failed: ${String(run.html_url ?? "")}`,
            fix: `Run \`hollow fix --run ${String(run.id)}\` to see why.`,
          });
        }
      }
    }
  }
  return findings;
}

async function defaultBranch(api: GitHubApi, repo: string): Promise<string | null> {
  const response = await api.request("GET", `repos/${repo}`);
  const branch = (response.data as { default_branch?: unknown } | null)?.default_branch;
  return response.status < 400 && typeof branch === "string" ? branch : null;
}
