import path from "node:path";
import { OWNER_LABEL } from "../agent/diagnose.js";
import { localSecretValues } from "../agent/redact.js";
import {
  explainFailures,
  type FailedJob,
  failed,
  type Run,
  type WatchOptions,
  watch,
} from "../agent/runs.js";
import { CONFIG_FILE } from "../config/load.js";
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
 * it. It never edits a file: repairs come with the AI repair loop.
 */
export async function fix(options: FixOptions): Promise<number> {
  const loaded = loadPlan(options.dir, options.stderr);
  if (loaded === null) return 1;
  const { detection, plan } = loaded;
  try {
    return await run(options, detection.root, plan);
  } catch (error) {
    if (error instanceof GitError || error instanceof GitHubError) {
      options.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function run(options: FixOptions, root: string, plan: PipelinePlan): Promise<number> {
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
  if (options.run === undefined) {
    const ours = [...new Set([CONFIG_FILE, ...generateFiles(plan).map((file) => file.path)])];
    const changed = await changedPaths(root, ours);
    if (changed.length > 0) {
      const outcome = await publish(options, api, repo, root, plan, changed);
      if (outcome === null) return 1;
      if (!options.wait) return 0;
      sha = outcome;
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
  return explain(options, api, repo, root, sha);
}

/** Commit The Hollow's files to a hollow/ branch, push it and open (or find) its pull request. */
async function publish(
  options: FixOptions,
  api: GitHubApi,
  repo: string,
  root: string,
  plan: PipelinePlan,
  changed: string[],
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
): Promise<{ number: number; url: string } | null> {
  const owner = repo.split("/")[0];
  const response = await api.request(
    "GET",
    `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open&per_page=1`,
  );
  if (response.status >= 400 || !Array.isArray(response.data)) return null;
  const first = response.data[0] as { number?: unknown; html_url?: unknown } | undefined;
  return typeof first?.number === "number"
    ? { number: first.number, url: String(first.html_url ?? "") }
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

/** Watch the commit's runs (or one run), then explain each failed job. */
async function explain(
  options: FixOptions,
  api: GitHubApi,
  repo: string,
  root: string,
  sha: string | null,
): Promise<number> {
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
    options.stderr(
      `\nNo workflow started for ${sha?.slice(0, 7)} within ${Math.round(clock.startTimeoutMs / 60_000)} minutes. If the workflows are not on this branch yet, commit them (\`hollow fix\` does that), and check that Actions is turned on in the repo's settings.\n`,
    );
    return 1;
  }
  if (result.status === "timeout") {
    options.stderr("\nThe checks are still running. Run `hollow fix` again once they finish.\n");
    return 1;
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
    return 0;
  }
  options.stdout(`\n${failures.map(formatFailure).join("\n\n")}\n`);
  return 1;
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
