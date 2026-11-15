import { errorMessage, type GitHubApi, GitHubError } from "../github/api.js";
import { type Diagnosis, diagnose } from "./diagnose.js";
import { cleanLog, errorLines, failureExcerpt } from "./logs.js";
import { redact } from "./redact.js";

export interface Run {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface FailedJob {
  run: Run;
  job: string;
  step: string | null;
  url: string;
  /** GitHub's `##[error]` messages, redacted. */
  errors: string[];
  /** The lines around the failure, redacted. */
  excerpt: string[];
  diagnosis: Diagnosis | null;
}

/** Conclusions that mean something went wrong. Skipped and neutral runs are fine. */
const BAD = new Set(["failure", "timed_out", "startup_failure", "action_required", "cancelled"]);

export function failed(run: Run): boolean {
  return run.conclusion !== null && BAD.has(run.conclusion);
}

function asRun(raw: unknown): Run | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number") return null;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : `run ${r.id}`,
    status: typeof r.status === "string" ? r.status : "unknown",
    conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
    url: typeof r.html_url === "string" ? r.html_url : "",
  };
}

async function get(api: GitHubApi, path: string): Promise<unknown> {
  const response = await api.request("GET", path);
  if (response.status >= 400) {
    throw new GitHubError(`GitHub refused GET ${path.split("?")[0]}: ${errorMessage(response)}`);
  }
  return response.data;
}

/** The latest run of each workflow for a commit. */
export async function runsFor(api: GitHubApi, repo: string, sha: string): Promise<Run[]> {
  const data = (await get(api, `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`)) as {
    workflow_runs?: unknown[];
  };
  const latest = new Map<string, Run>();
  for (const raw of data.workflow_runs ?? []) {
    const run = asRun(raw);
    if (run === null) continue;
    const seen = latest.get(run.name);
    // Runs come newest first; a re-run keeps the same id, so the first one per workflow wins.
    if (seen === undefined) latest.set(run.name, run);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function runById(api: GitHubApi, repo: string, id: number): Promise<Run> {
  const run = asRun(await get(api, `repos/${repo}/actions/runs/${id}`));
  if (run === null) throw new GitHubError(`GitHub returned no run ${id}.`);
  return run;
}

export interface WatchOptions {
  /** How long to wait for workflows to start, then to finish. */
  startTimeoutMs: number;
  finishTimeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Called whenever a run's state changes. */
  report: (run: Run) => void;
}

export type WatchResult =
  | { status: "done"; runs: Run[] }
  | { status: "none" }
  | { status: "timeout"; runs: Run[] };

/** Wait until every workflow run for the commit has finished, reporting each change of state. */
export async function watch(
  api: GitHubApi,
  repo: string,
  sha: string,
  options: WatchOptions,
  only?: number,
): Promise<WatchResult> {
  const started = options.now();
  const seen = new Map<number, string>();
  let appeared = false;
  for (;;) {
    const runs =
      only === undefined ? await runsFor(api, repo, sha) : [await runById(api, repo, only)];
    for (const run of runs) {
      const state = `${run.status}/${run.conclusion ?? ""}`;
      if (seen.get(run.id) !== state) {
        seen.set(run.id, state);
        options.report(run);
      }
    }
    if (runs.length > 0) appeared = true;
    if (appeared && runs.every((run) => run.status === "completed"))
      return { status: "done", runs };
    const elapsed = options.now() - started;
    if (!appeared && elapsed >= options.startTimeoutMs) return { status: "none" };
    if (elapsed >= options.startTimeoutMs + options.finishTimeoutMs)
      return { status: "timeout", runs };
    await options.sleep(options.intervalMs);
  }
}

interface RawJob {
  id: number;
  name: string;
  conclusion: string | null;
  url: string;
  step: string | null;
}

async function failedJobs(api: GitHubApi, repo: string, run: Run): Promise<RawJob[]> {
  const data = (await get(
    api,
    `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
  )) as {
    jobs?: unknown[];
  };
  const jobs: RawJob[] = [];
  for (const raw of data.jobs ?? []) {
    if (typeof raw !== "object" || raw === null) continue;
    const j = raw as Record<string, unknown>;
    if (typeof j.id !== "number" || typeof j.conclusion !== "string" || !BAD.has(j.conclusion))
      continue;
    const steps = Array.isArray(j.steps) ? (j.steps as Record<string, unknown>[]) : [];
    const step = steps.find((s) => typeof s.conclusion === "string" && BAD.has(s.conclusion));
    jobs.push({
      id: j.id,
      name: typeof j.name === "string" ? j.name : `job ${j.id}`,
      conclusion: j.conclusion,
      url: typeof j.html_url === "string" ? j.html_url : run.url,
      step: typeof step?.name === "string" ? step.name : null,
    });
  }
  return jobs;
}

/**
 * Read why each failed job failed: its log, redacted before anything else looks at it, cut to the
 * failing part, and matched against the known causes.
 */
export async function explainFailures(
  api: GitHubApi,
  repo: string,
  runs: Run[],
  secretValues: string[],
): Promise<FailedJob[]> {
  const explained: FailedJob[] = [];
  for (const run of runs.filter(failed)) {
    const jobs = await failedJobs(api, repo, run);
    if (jobs.length === 0) {
      // No job ran: the workflow file itself was rejected, or the run was cancelled before starting.
      explained.push({
        run,
        job: run.name,
        step: null,
        url: run.url,
        errors: [],
        excerpt: [],
        diagnosis:
          run.conclusion === "startup_failure"
            ? {
                id: "invalid-workflow",
                owner: "pipeline",
                cause: "GitHub could not start the workflow, usually because the file is invalid.",
                fix: "Open the run on GitHub to see the error, then fix the workflow (actionlint finds most of these).",
              }
            : null,
      });
      continue;
    }
    for (const job of jobs) {
      const response = await api.request("GET", `repos/${repo}/actions/jobs/${job.id}/logs`);
      const raw = response.status < 400 && typeof response.data === "string" ? response.data : "";
      // Clean first so values and keys match without timestamps in the way, then redact before
      // anything reads the text.
      const lines = redact(cleanLog(raw).join("\n"), { values: secretValues }).split("\n");
      const excerpt = failureExcerpt(lines);
      const errors = errorLines(lines);
      explained.push({
        run,
        job: job.name,
        step: job.step,
        url: job.url,
        errors,
        excerpt,
        diagnosis: diagnose({
          workflow: run.name,
          job: job.name,
          step: job.step,
          lines: [...excerpt, ...errors],
        }),
      });
    }
  }
  return explained;
}
