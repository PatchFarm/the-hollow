import { CONFIG_FILE, loadConfig } from "../config/load.js";
import { detectProject } from "../detect/index.js";
import { currentRepo, type GitHubApi, GitHubError, ghApi } from "../github/api.js";
import { planPipeline } from "../pipeline/plan.js";
import {
  applyProtection,
  type ProtectPlan,
  planProtection,
  type Step,
  type StepOutcome,
} from "../protect/plan.js";
import type { Ask } from "./interview.js";

/** Find the repo and a way to talk to GitHub. Throws GitHubError when gh cannot be used. */
export type Connect = (
  dir: string,
  repo: string | undefined,
) => Promise<{ api: GitHubApi; repo: string }>;

export const ghConnect: Connect = async (dir, repo) => ({
  api: ghApi(dir),
  repo: repo ?? (await currentRepo(dir)),
});

export interface ProtectOptions {
  dir: string;
  repo?: string | undefined;
  dryRun: boolean;
  yes: boolean;
  ask?: Ask | undefined;
  connect: Connect;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * `hollow protect`: apply branch rules, environments and security settings to the GitHub repo
 * through the developer's own gh login. Shows every change first and applies nothing without a
 * yes (or --yes).
 */
export async function protect(options: ProtectOptions): Promise<number> {
  let detection: ReturnType<typeof detectProject>;
  try {
    detection = detectProject(options.dir);
  } catch (error) {
    options.stderr(`${(error as Error).message}\n`);
    return 1;
  }
  const config = loadConfig(detection.root);
  if (config.status === "missing") {
    options.stderr(`No ${CONFIG_FILE} here. Run \`hollow init\` first.\n`);
    return 1;
  }
  if (config.status === "invalid") {
    options.stderr(
      `${CONFIG_FILE} is invalid:\n${config.errors.map((e) => `  - ${e}`).join("\n")}\n`,
    );
    return 1;
  }
  const pipeline = planPipeline(detection, config.config);
  if (pipeline.status === "error") {
    options.stderr(`${pipeline.error}\n`);
    return 1;
  }
  const { plan } = pipeline;
  const settings = config.config;

  let result: Awaited<ReturnType<typeof planProtection>>;
  let repo: string;
  try {
    const connection = await options.connect(detection.root, options.repo);
    repo = connection.repo;
    options.stdout(`Reading the current settings of ${repo} through gh...\n`);
    result = await planProtection(connection.api, {
      repo,
      defaultBranch: plan.defaultBranch,
      requiredApprovals: settings.protection.requiredApprovals,
      approvers: settings.environments.production.approvers,
      preventSelfReview: settings.environments.production.preventSelfReview,
      preprod: settings.environments.preprod.enabled,
      releaseTokenSecret: plan.release === null ? null : plan.release.tokenSecret,
    });
  } catch (error) {
    if (error instanceof GitHubError) {
      options.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  if (result.status === "error") {
    options.stderr(`${result.error}\n`);
    return 1;
  }
  const protection = result.plan;
  const changes = protection.steps.filter((step) => step.status === "change");
  options.stdout(formatProtectPlan(protection));

  if (changes.length === 0) {
    options.stdout("\nNothing to change: every setting is already in place.\n");
    printNotes(protection, options);
    return 0;
  }
  if (options.dryRun) {
    printNotes(protection, options);
    options.stdout("\nDry run: nothing was changed.\n");
    return 0;
  }
  if (!options.yes) {
    if (options.ask === undefined) {
      options.stderr(
        "\nNothing was changed. Run again in a terminal to confirm, or with --yes to apply without a prompt.\n",
      );
      return 1;
    }
    const answer = await options.ask(`\nApply these changes to ${repo}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      options.stdout("Nothing was changed.\n");
      return 1;
    }
  }

  options.stdout("\n");
  const outcomes = await applyProtection(protection, (outcome) =>
    options.stdout(formatOutcome(outcome)),
  );
  printNotes(protection, options);
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  if (failed.length > 0) {
    options.stderr(
      `\n${failed.length} change${failed.length === 1 ? "" : "s"} failed. Fix the cause above and run \`hollow protect\` again; settings already in place are left alone.\n`,
    );
    return 1;
  }
  options.stdout(
    `\n${repo} is protected. Run \`hollow protect\` again any time to check nothing has drifted.\n`,
  );
  return 0;
}

const TIER_LABEL: Record<ProtectPlan["tier"], string> = {
  public: "public",
  "private-free": "private, GitHub Free",
  "private-paid": "private",
  "private-enterprise": "private, GitHub Enterprise",
};

export function formatProtectPlan(plan: ProtectPlan): string {
  const changes = plan.steps.filter((step) => step.status === "change");
  const lines: string[] = [];
  if (changes.length > 0) {
    lines.push(`\nChanges to ${plan.repo} (${TIER_LABEL[plan.tier]}):`);
    for (const step of changes) {
      lines.push(`\n  ${step.title}`);
      for (const change of step.changes) lines.push(`    + ${change}`);
    }
  }
  const done = plan.steps.filter((step) => step.status === "ok");
  if (done.length > 0) {
    lines.push(`\nAlready set: ${done.map((step) => lower(step.title)).join(", ")}.`);
  }
  const skipped = plan.steps.filter(
    (step): step is Step & { reason: string } => step.status === "skip",
  );
  if (skipped.length > 0) {
    lines.push("\nSkipped:");
    for (const step of skipped) lines.push(`  - ${step.title}: ${step.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

function lower(title: string): string {
  // "Dependabot" and "GitHub" stay capitalised; generic titles read better in a sentence.
  return /^(Dependabot|GitHub|Environment)/.test(title)
    ? title
    : title[0]?.toLowerCase() + title.slice(1);
}

function formatOutcome(outcome: StepOutcome): string {
  if (outcome.status === "done") return `  done          ${outcome.step.title}\n`;
  if (outcome.status === "unavailable") {
    return `  not available ${outcome.step.title}: ${outcome.message}\n`;
  }
  return `  failed        ${outcome.step.title}: ${outcome.message}\n`;
}

function printNotes(plan: ProtectPlan, options: { stdout: (text: string) => void }): void {
  if (plan.notes.length === 0) return;
  options.stdout(`\nWorth knowing\n${plan.notes.map((note) => `  - ${note}`).join("\n")}\n`);
}
