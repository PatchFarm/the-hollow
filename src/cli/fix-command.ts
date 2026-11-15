import path from "node:path";
import { Budget } from "../agent/budget.js";
import { OWNER_LABEL } from "../agent/diagnose.js";
import { type Fetch, type ModelClient, modelClient } from "../agent/model.js";
import { editableFiles } from "../agent/prompt.js";
import { localSecretValues } from "../agent/redact.js";
import { type RepairResult, repair } from "../agent/repair.js";
import {
  explainFailures,
  type FailedJob,
  failed,
  type Run,
  type WatchOptions,
  watch,
} from "../agent/runs.js";
import { CONFIG_FILE } from "../config/load.js";
import type { HollowConfig } from "../config/schema.js";
import { generateFiles } from "../generate/index.js";
import { errorMessage, type GitHubApi, GitHubError } from "../github/api.js";
import type { PipelinePlan } from "../pipeline/plan.js";
import {
  branchExists,
  changedPaths,
  commitPaths,
  createBranch,
  currentBranch,
  existsAtHead,
  GitError,
  hasRemote,
  headSha,
  push,
  repoRoot,
  upstreamSha,
} from "../util/git.js";
import { ProjectFiles } from "../util/project-files.js";
import { upgrade } from "./generate-command.js";
import type { Ask } from "./interview.js";
import { loadPlan } from "./load-plan.js";
import type { Connect } from "./protect-command.js";

export const REMOTE = "origin";
export const BRANCH = "hollow/pipeline";

export interface FixOptions {
  dir: string;
  repo?: string | undefined;
  yes: boolean;
  /** Read this run instead of the current commit's. */
  run?: number | undefined;
  /** Stop after opening the pull request instead of watching the checks. */
  wait: boolean;
  ask?: Ask | undefined;
  connect: Connect;
  /** Timing for watching runs; tests make it instant. */
  clock?: Partial<WatchOptions> | undefined;
  /** --no-ai: explain failures, never call a model. */
  noAi: boolean;
  /** Where the API key's environment variable is read from. */
  env: NodeJS.ProcessEnv;
  fetch: Fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_CLOCK: Omit<WatchOptions, "report"> = {
  startTimeoutMs: 3 * 60_000,
  finishTimeoutMs: 45 * 60_000,
  intervalMs: 15_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * `hollow fix`: get the pipeline running and explain what fails.
 *
 * With uncommitted pipeline files, it commits only those to a hollow/ branch, pushes and opens the
 * pull request (after showing all of that and getting a yes). Then it watches the checks for the
 * commit, reads the logs of failed jobs (redacted first) and says what went wrong and who can fix
 * it. With a model configured, on a hollow/ branch, it then lets the model repair what is the
 * pipeline's to fix (after one yes), within the retry and spend caps, and ends with the pull
 * request either passing or turned into a draft with its findings.
 */
export async function fix(options: FixOptions): Promise<number> {
  const loaded = loadPlan(options.dir, options.stderr);
  if (loaded === null) return 1;
  const { detection, plan, config } = loaded;
  const client = modelClient(config.agent, options.env, options.fetch, options.noAi);
  try {
    return await run(options, detection.root, plan, config, client);
  } catch (error) {
    if (error instanceof GitError || error instanceof GitHubError) {
      options.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

type Client = ReturnType<typeof modelClient>;

async function run(
  options: FixOptions,
  root: string,
  plan: PipelinePlan,
  config: HollowConfig,
  client: Client,
): Promise<number> {
  const top = await repoRoot(root);
  if (top === null) {
    options.stderr(
      "This folder is not a git repository. Run `git init` and add a GitHub remote first.\n",
    );
    return 1;
  }
  if (path.resolve(top) !== path.resolve(root)) {
    options.stderr(`Run \`hollow fix\` from the repo's top folder (${top}).\n`);
    return 1;
  }
  const { api, repo } = await options.connect(root, options.repo);

  let sha: string | null = null;
  let approved = false;
  const budget = new Budget(config.agent);
  if (options.run === undefined) {
    const ours = [...new Set([CONFIG_FILE, ...generateFiles(plan).map((file) => file.path)])];
    const changed = await changedPaths(root, ours);
    if (changed.length > 0) {
      const note =
        client.status === "ok" && options.wait
          ? repairPlan(client.client, budget, config, root, "      ")
          : [];
      const outcome = await publish(options, api, repo, root, plan, changed, note);
      if (outcome === null) return 1;
      if (!options.wait) return 0;
      sha = outcome;
      approved = note.length > 0;
    } else {
      sha = await headSha(root);
      if ((await upstreamSha(root)) !== sha) {
        options.stderr(
          "Nothing of The Hollow's to commit, and this commit is not pushed, so no checks have run on it. Push your branch, then run `hollow fix` again.\n",
        );
        return 1;
      }
    }
  }
  const result = await explain(options, api, repo, root, sha);
  if (result.status !== "failed") return result.status === "passed" ? 0 : 1;

  // Repairs happen on The Hollow's own branch only, for the current commit's checks.
  const branch = await currentBranch(root);
  const ownBranch = branch?.startsWith("hollow/") && branch !== plan.defaultBranch;
  const worthTrying = result.failures.some(
    (f) =>
      f.diagnosis === null || f.diagnosis.owner === "pipeline" || f.diagnosis.owner === "retry",
  );
  if (options.run !== undefined || !worthTrying) return 1;
  if (client.status === "off") {
    options.stdout(`\n${client.reason}\n`);
    return 1;
  }
  if (!ownBranch) {
    options.stdout(
      "\nThe model only repairs on a hollow/ branch, so its changes arrive as a pull request. Run `hollow fix` on the branch it opened.\n",
    );
    return 1;
  }
  if (!approved && !options.yes) {
    options.stdout(`\n${repairPlan(client.client, budget, config, root, "  ").join("\n")}\n`);
    if (options.ask === undefined) {
      options.stderr(
        "\nNo terminal to ask for a go-ahead. Run again with --yes to let the model repair it.\n",
      );
      return 1;
    }
    const answer = (await options.ask("\nLet the model repair it? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") return 1;
  }
  return repairAndReport(
    options,
    api,
    repo,
    root,
    branch as string,
    config,
    client.client,
    budget,
    result.failures,
  );
}

/** What the repair loop will do and send, shown before it starts. */
function repairPlan(
  client: ModelClient,
  budget: Budget,
  config: HollowConfig,
  root: string,
  indent: string,
): string[] {
  const files = new ProjectFiles(root);
  const editable = editableFiles(files);
  const manifests = ["package.json", "pyproject.toml"].filter((file) => files.exists(file));
  return [
    "If checks fail, the model can try to repair the pipeline:",
    `${indent}model: ${client.label}`,
    `${indent}up to ${config.agent.maxRepairAttempts} attempts, spend cap ${budget.describeCap()}`,
    `${indent}it sees, after redaction: the failed jobs' logs, ${[...editable, ...manifests].join(", ")}, the failing workflows and the hollow.yml schema`,
    `${indent}it may change: ${editable.join(", ")} (The Hollow then regenerates the workflows and checks them against its policy)`,
    `${indent}each repair is committed and pushed to this branch, then checked again`,
  ];
}

async function repairAndReport(
  options: FixOptions,
  api: GitHubApi,
  repo: string,
  root: string,
  branch: string,
  config: HollowConfig,
  client: ModelClient,
  budget: Budget,
  failures: FailedJob[],
): Promise<number> {
  const clock = { ...DEFAULT_CLOCK, ...options.clock };
  const secretValues = localSecretValues(new ProjectFiles(root));
  const quiet = () => {};
  const result = await repair(
    {
      api,
      repo,
      root,
      client,
      budget,
      maxAttempts: config.agent.maxRepairAttempts,
      secretValues,
      loadPlan: () => loadPlan(root, quiet)?.plan ?? null,
      regenerate: () => {
        let error = "";
        const code = upgrade({
          dir: root,
          force: false,
          dryRun: false,
          stdout: quiet,
          stderr: (text) => {
            error += text;
          },
        });
        return code === 0 ? null : error.trim() || "regenerating failed";
      },
      commit: async (plan, extra, message) => {
        const ours = [
          ...new Set([CONFIG_FILE, ...generateFiles(plan).map((f) => f.path), ...extra]),
        ];
        const changed = await changedPaths(root, ours);
        if (changed.length === 0) return null;
        await commitPaths(root, changed, message);
        await push(root, REMOTE, branch);
        return headSha(root);
      },
      check: async () => {
        const outcome = await explain(options, api, repo, root, await headSha(root));
        if (outcome.status === "stopped") return { stopped: outcome.message };
        return { failures: outcome.status === "passed" ? [] : outcome.failures };
      },
      rerun: async (passing) => {
        for (const id of new Set(passing.map((f) => f.run.id))) {
          await api.request("POST", `repos/${repo}/actions/runs/${id}/rerun-failed-jobs`);
        }
        // Give GitHub a moment to mark the runs as queued again before watching them.
        await clock.sleep(clock.intervalMs);
      },
      say: options.stdout,
    },
    failures,
  );
  options.stdout(
    `\n${result.passed ? "The checks pass now." : `Stopped: ${result.reason}`} Attempts: ${result.attempts.length} of ${config.agent.maxRepairAttempts}. Spent: ${budget.describeSpent()}.\n`,
  );
  for (const suggestion of result.suggestions)
    options.stdout(`  Suggestion for the project's code: ${suggestion}\n`);
  for (const bug of result.templateBugs) {
    options.stdout(`  Not fixable through hollow.yml (please report it to The Hollow): ${bug}\n`);
  }

  const pull = await findPull(api, repo, branch);
  if (pull !== null) {
    await api.request("POST", `repos/${repo}/issues/${pull.number}/comments`, {
      body: repairComment(result, client.label, budget),
    });
    if (!result.passed && pull.nodeId !== null) {
      const draft = await api.request("POST", "graphql", {
        query:
          "mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
        variables: { id: pull.nodeId },
      });
      options.stdout(
        draft.status < 400
          ? `Pull request #${pull.number} is now a draft, with the findings in a comment: ${pull.url}\n`
          : `Left the findings on pull request #${pull.number}, but could not mark it as a draft: ${pull.url}\n`,
      );
    } else {
      options.stdout(`Summarised the repairs on pull request #${pull.number}: ${pull.url}\n`);
    }
  }
  return result.passed ? 0 : 1;
}

/** The pull request comment: what the agent did, what is left, and what to do next. */
export function repairComment(result: RepairResult, label: string, budget: Budget): string {
  const lines = [
    result.passed
      ? "### Repaired by hollow fix"
      : "### hollow fix could not get the checks to pass",
    "",
    `Model: ${label}. Attempts: ${result.attempts.length}. Spent: ${budget.describeSpent()}.`,
  ];
  if (!result.passed) lines.push("", `**Why it stopped:** ${result.reason}`);
  if (result.attempts.length > 0) {
    lines.push("", "**What it tried:**");
    for (const attempt of result.attempts) {
      lines.push(
        `${attempt.number}. ${attempt.summary}${attempt.files.length > 0 ? ` (${attempt.files.map((f) => `\`${f}\``).join(", ")})` : ""}: ${attempt.result}`,
      );
    }
  }
  if (!result.passed && result.remaining.length > 0) {
    lines.push("", "**Still failing:**");
    for (const failure of result.remaining) {
      const where = `${failure.run.name} / ${failure.job}${failure.step === null ? "" : `, at "${failure.step}"`}`;
      lines.push(
        failure.diagnosis === null
          ? `- ${where}: not a known failure. [Log](${failure.url})`
          : `- ${where}: ${failure.diagnosis.cause} (${OWNER_LABEL[failure.diagnosis.owner]}) ${failure.diagnosis.fix}`,
      );
    }
  }
  if (result.suggestions.length > 0) {
    lines.push("", "**Suggested changes to the project's code** (the agent never edits it):");
    for (const suggestion of result.suggestions) lines.push(`- ${suggestion}`);
  }
  if (result.templateBugs.length > 0) {
    lines.push(
      "",
      "**Not fixable through hollow.yml.** This looks like a bug in The Hollow's templates; please report it at https://github.com/PatchFarm/the-hollow/issues:",
    );
    for (const bug of result.templateBugs) lines.push(`- ${bug}`);
  }
  lines.push(
    "",
    result.passed
      ? "Review the changes like any other code before merging."
      : "Next: fix what is listed above, push, and run `hollow fix` again. This pull request stays a draft until then.",
  );
  return lines.join("\n");
}

/** Commit The Hollow's files to a hollow/ branch, push it and open (or find) its pull request. */
async function publish(
  options: FixOptions,
  api: GitHubApi,
  repo: string,
  root: string,
  plan: PipelinePlan,
  changed: string[],
  repairNote: string[],
): Promise<string | null> {
  const current = await currentBranch(root);
  if (current === null) {
    options.stderr("HEAD is detached. Switch to a branch, then run `hollow fix` again.\n");
    return null;
  }
  if (!(await hasRemote(root, REMOTE))) {
    options.stderr(
      `This repo has no "${REMOTE}" remote to push to. Add the GitHub repo as ${REMOTE} first.\n`,
    );
    return null;
  }
  // Never commit straight onto the default branch, whatever it is called.
  const reuse = current.startsWith("hollow/") && current !== plan.defaultBranch;
  let branch = current;
  if (!reuse) {
    branch = BRANCH;
    for (let n = 2; await branchExists(root, branch, REMOTE); n++) branch = `${BRANCH}-${n}`;
  }
  const fresh = !(await existsAtHead(root, ".github/workflows/ci.yml"));
  const message = fresh ? "ci: add The Hollow pipeline" : "ci: update The Hollow pipeline";
  const pull = await findPull(api, repo, branch);

  const lines = [
    "hollow fix will:",
    reuse
      ? `  1. commit on this branch, ${branch}`
      : `  1. create the branch ${branch} from ${current} (your other uncommitted changes come along and stay uncommitted)`,
    `  2. commit ${changed.length === 1 ? "this file" : `these ${changed.length} files`} as "${message}":`,
    ...changed.map((file) => `       ${file}`),
    `  3. push ${branch} to ${REMOTE} (${repo})`,
    pull === null
      ? `  4. open a pull request from ${branch} into ${plan.defaultBranch}`
      : `  4. update pull request #${pull.number}`,
    options.wait ? "  5. watch its checks and explain anything that fails" : "",
    ...(repairNote.length > 0
      ? [`  6. ${repairNote[0]?.replace(/^I/, "i")}`, ...repairNote.slice(1)]
      : []),
  ].filter(Boolean);
  options.stdout(`${lines.join("\n")}\n`);
  if (!options.yes) {
    if (options.ask === undefined) {
      options.stderr("\nNo terminal to ask for a go-ahead. Run again with --yes to do this.\n");
      return null;
    }
    const answer = (await options.ask("\nGo ahead? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      options.stdout("Nothing changed.\n");
      return null;
    }
  }

  if (!reuse) await createBranch(root, branch);
  await commitPaths(root, changed, message);
  await push(root, REMOTE, branch);
  const sha = await headSha(root);
  options.stdout(`\nPushed ${branch} (${sha.slice(0, 7)}).\n`);

  if (pull === null) {
    const response = await api.request("POST", `repos/${repo}/pulls`, {
      title: message,
      head: branch,
      base: plan.defaultBranch,
      body: pullBody(changed),
    });
    if (response.status >= 400) {
      options.stderr(
        `Pushed, but GitHub would not open the pull request: ${errorMessage(response)}\n`,
      );
      return null;
    }
    const opened = response.data as { number?: number; html_url?: string };
    options.stdout(`Opened pull request #${opened.number}: ${opened.html_url}\n`);
  } else {
    options.stdout(`Updated pull request #${pull.number}: ${pull.url}\n`);
  }
  return sha;
}

async function findPull(
  api: GitHubApi,
  repo: string,
  branch: string,
): Promise<{ number: number; url: string; nodeId: string | null } | null> {
  const owner = repo.split("/")[0];
  const response = await api.request(
    "GET",
    `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&per_page=1`,
  );
  if (response.status >= 400 || !Array.isArray(response.data)) return null;
  const first = response.data[0] as
    | { number?: unknown; html_url?: unknown; node_id?: unknown }
    | undefined;
  return typeof first?.number === "number"
    ? {
        number: first.number,
        url: String(first.html_url ?? ""),
        nodeId: typeof first.node_id === "string" ? first.node_id : null,
      }
    : null;
}

function pullBody(files: string[]): string {
  return [
    "The CI/CD pipeline generated by [The Hollow](https://github.com/PatchFarm/the-hollow) from `hollow.yml`.",
    "",
    "Files:",
    ...files.map((file) => `- \`${file}\``),
    "",
    "Review the workflows like any other code. After merging, run `hollow protect` to protect the default branch and set up the environments, and `hollow secrets` to add what the deploys need.",
  ].join("\n");
}

type Explained =
  | { status: "passed" }
  | { status: "failed"; failures: FailedJob[] }
  | { status: "stopped"; message: string };

/** Watch the commit's runs (or one run), then explain each failed job. */
async function explain(
  options: FixOptions,
  api: GitHubApi,
  repo: string,
  root: string,
  sha: string | null,
): Promise<Explained> {
  const clock = { ...DEFAULT_CLOCK, ...options.clock };
  const target =
    options.run === undefined ? `the checks on ${sha?.slice(0, 7)}` : `run ${options.run}`;
  options.stdout(`\nWatching ${target}...\n`);
  const result = await watch(
    api,
    repo,
    sha ?? "",
    { ...clock, report: (r) => options.stdout(`  ${r.name}: ${describe(r)}\n`) },
    options.run,
  );
  if (result.status === "none") {
    const message = `No workflow started for ${sha?.slice(0, 7)} within ${Math.round(clock.startTimeoutMs / 60_000)} minutes. If the workflows are not on this branch yet, commit them (\`hollow fix\` does that), and check that Actions is turned on in the repo's settings.`;
    options.stderr(`\n${message}\n`);
    return { status: "stopped", message };
  }
  if (result.status === "timeout") {
    const message = "The checks are still running. Run `hollow fix` again once they finish.";
    options.stderr(`\n${message}\n`);
    return { status: "stopped", message };
  }
  const failures = await explainFailures(
    api,
    repo,
    result.runs,
    localSecretValues(new ProjectFiles(root)),
  );
  if (failures.length === 0 && !result.runs.some(failed)) {
    options.stdout(
      `\nAll ${result.runs.length} check${result.runs.length === 1 ? "" : "s"} passed.\n`,
    );
    return { status: "passed" };
  }
  options.stdout(`\n${failures.map(formatFailure).join("\n\n")}\n`);
  return { status: "failed", failures };
}

function describe(run: Run): string {
  if (run.status !== "completed") return run.status.replaceAll("_", " ");
  return run.conclusion === "success"
    ? "passed"
    : (run.conclusion ?? "finished").replaceAll("_", " ");
}

export function formatFailure(failure: FailedJob): string {
  const where = `${failure.run.name} / ${failure.job}${failure.step === null ? "" : `, at "${failure.step}"`}`;
  const lines = [`Failed: ${where}`];
  if (failure.diagnosis !== null) {
    lines.push(
      `  ${failure.diagnosis.cause} (${OWNER_LABEL[failure.diagnosis.owner]})`,
      `  Fix: ${failure.diagnosis.fix}`,
    );
  } else {
    lines.push("  The Hollow does not recognise this failure.");
    for (const error of failure.errors.slice(0, 5)) lines.push(`  Error: ${error}`);
    const tail = failure.excerpt.slice(-15);
    if (tail.length > 0)
      lines.push("  Last lines of the log:", ...tail.map((line) => `    ${line}`));
  }
  if (failure.url) lines.push(`  ${failure.url}`);
  return lines.join("\n");
}
