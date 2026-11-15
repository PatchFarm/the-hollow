import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Real git in temp repos is slow when every test file runs at once, hence the longer timeouts.
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { Fetch } from "../src/agent/model.js";
import { EXIT } from "../src/cli/main.js";
import { FakeGitHub, type FakeRun, fakeState } from "./fake-github.js";
import { copyFixture, runCli } from "./helpers.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

const KEY = "test-key-not-real-0123456789";
const LOCAL_SECRET = "local-env-value-77";

/** The FastAPI sample, pushed, with `hollow init` run and a model configured in hollow.yml. */
async function project(agent: Record<string, unknown>): Promise<string> {
  const dir = copyFixture("python-fastapi");
  const origin = mkdtempSync(path.join(tmpdir(), "hollow-origin-"));
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--message", "feat: the app");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "--quiet", "origin", "main");
  expect((await runCli(["init", "--yes", "--target", "docker", "--cwd", dir])).code).toBe(EXIT.ok);
  const config = parse(readFileSync(path.join(dir, "hollow.yml"), "utf8")) as Record<
    string,
    unknown
  >;
  config.agent = {
    provider: "openai-compatible",
    model: "test-model",
    baseUrl: "https://llm.example/v1",
    maxRepairAttempts: 2,
    ...agent,
  };
  writeFileSync(path.join(dir, "hollow.yml"), stringify(config));
  writeFileSync(path.join(dir, ".env"), `APP_SECRET=${LOCAL_SECRET}\n`);
  return dir;
}

/** CI fails on a missing tool, then passes once the agent's change is pushed. */
function ciRun(states: FakeRun["states"]): FakeRun {
  return {
    id: 501,
    name: "CI",
    head_sha: "*",
    states,
    jobs: [
      {
        id: 9001,
        name: "Build and test",
        conclusion: "failure",
        steps: [{ name: "Test", conclusion: "failure" }],
        log: [
          "2026-11-15T10:00:00Z ##[group]Run uv run --no-sync pytst",
          `2026-11-15T10:00:01Z using ${LOCAL_SECRET}`,
          "2026-11-15T10:00:01Z error: Failed to spawn: `pytst`",
          "2026-11-15T10:00:02Z ##[error]Process completed with exit code 2.",
        ].join("\n"),
      },
    ],
  };
}

const FAIL = { status: "completed", conclusion: "failure" };
const PASS = { status: "completed", conclusion: "success" };

function instantClock() {
  let tick = 0;
  return {
    sleep: async () => {},
    now: () => tick++,
    intervalMs: 1,
    startTimeoutMs: 20,
    finishTimeoutMs: 200,
  };
}

/** A model endpoint that answers each call with the next reply the test gives it. */
function model(replies: ((dir: string) => unknown)[], dir: () => string) {
  const prompts: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetcher: Fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    prompts.push(body.messages.map((m) => m.content).join("\n"));
    headers.push(init.headers as Record<string, string>);
    const next = replies.shift();
    const content = next === undefined ? "{}" : JSON.stringify(next(dir()));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      }),
    );
  };
  return { fetcher, prompts, headers };
}

/** The agent's fix: tell hollow.yml the right test command. */
function fixTestCommand(dir: string) {
  const config = parse(readFileSync(path.join(dir, "hollow.yml"), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  config.project = { ...config.project, commands: { test: "uv run --no-sync pytest -q" } };
  return {
    summary: "Run pytest, not pytst, in CI",
    edits: [{ path: "hollow.yml", content: stringify(config) }],
    suggestions: ["Add a pytest.ini so @everyone gets the same options"],
  };
}

describe("hollow fix: the repair loop", { timeout: 30_000 }, () => {
  it("asks once, lets the model fix hollow.yml, regenerates, pushes, and passes", async () => {
    let dir = "";
    const llm = model([fixTestCommand], () => dir);
    dir = await project({});
    const fake = new FakeGitHub(fakeState({ runs: [ciRun([FAIL, PASS])] }));
    const result = await runCli(["fix", "--cwd", dir], {
      connect: async () => ({ api: fake, repo: "octocat/demo" }),
      answers: ["y"],
      io: { clock: instantClock(), fetch: llm.fetcher, env: { HOLLOW_AI_API_KEY: KEY } },
    });

    // One question covers publishing and repairing, and says what the model sees and may change.
    expect(result.stdout.match(/\? \[y\/N\]/g)).toHaveLength(1);
    expect(result.stdout).toContain("6. if checks fail, the model can try to repair the pipeline");
    expect(result.stdout).toContain("model: test-model (openai-compatible, llm.example)");
    expect(result.stdout).toContain("spend cap 300,000 tokens");
    expect(result.stdout).toContain("it may change: hollow.yml, Dockerfile");

    // The model got the key in the header, and a prompt with no local secret in it.
    expect(llm.headers[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(llm.prompts[0]).toContain("Failed to spawn: `pytst`");
    expect(llm.prompts[0]).not.toContain(LOCAL_SECRET);
    expect(llm.prompts[0]).not.toContain(KEY);

    // The fix went through hollow.yml and the regenerated workflow, in one commit, pushed.
    expect(git(dir, "log", "-1", "--format=%s")).toBe("ci: Run pytest, not pytst, in CI");
    const changed = git(dir, "show", "--name-only", "--format=", "HEAD").split("\n");
    expect(changed).toContain("hollow.yml");
    expect(changed).toContain(".github/workflows/ci.yml");
    expect(readFileSync(path.join(dir, ".github/workflows/ci.yml"), "utf8")).toContain(
      "uv run --no-sync pytest -q",
    );
    expect(git(dir, "status", "--porcelain")).toBe("?? .env");

    expect(result.stdout).toContain("Attempt 1: asking test-model");
    expect(result.stdout).toContain("The checks pass now. Attempts: 1 of 2. Spent: 1,200 tokens.");
    expect(result.stdout).toContain(
      "Suggestion for the project's code: Add a pytest.ini so @​everyone",
    );
    const comment = fake.state.comments[0];
    expect(comment?.body).toContain("### Repaired by hollow fix");
    expect(comment?.body).toContain(
      "1. Run pytest, not pytst, in CI (`hollow.yml`): the checks passed",
    );
    expect(fake.state.pulls[0]?.draft).toBeUndefined();
    expect(result.code).toBe(EXIT.ok);
  });

  it("refuses edits outside its files, then leaves a draft pull request with its findings", async () => {
    let dir = "";
    const editWorkflow = () => ({
      summary: "edit the workflow directly",
      edits: [{ path: ".github/workflows/ci.yml", content: "name: CI\n" }],
    });
    const llm = model([editWorkflow, editWorkflow], () => dir);
    dir = await project({});
    const fake = new FakeGitHub(fakeState({ runs: [ciRun([FAIL])] }));
    const before = git(dir, "status", "--porcelain");
    const result = await runCli(["fix", "--yes", "--cwd", dir], {
      connect: async () => ({ api: fake, repo: "octocat/demo" }),
      io: { clock: instantClock(), fetch: llm.fetcher, env: { HOLLOW_AI_API_KEY: KEY } },
    });
    expect(before).not.toBe("");
    expect(result.stdout).toContain(
      "Refused the change: .github/workflows/ci.yml is not one of the files it may change",
    );
    expect(result.stdout).toContain("Stopped: It used all 2 repair attempts.");
    expect(llm.prompts[1]).toContain("refused:");
    // Only the publishing commit: nothing the model proposed was committed.
    expect(git(dir, "log", "-1", "--format=%s")).toBe("ci: add The Hollow pipeline");
    expect(fake.state.pulls[0]?.draft).toBe(true);
    const comment = fake.state.comments[0]?.body ?? "";
    expect(comment).toContain("### hollow fix could not get the checks to pass");
    expect(comment).toContain("**Why it stopped:** It used all 2 repair attempts.");
    expect(comment).toContain("**Still failing:**");
    expect(result.stdout).toContain("is now a draft");
    expect(result.code).toBe(EXIT.failure);
  });

  it("never makes a call that could cross the spend cap", async () => {
    let dir = "";
    const llm = model([fixTestCommand], () => dir);
    dir = await project({
      maxSpendUsd: 0.0001,
      pricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
    });
    const fake = new FakeGitHub(fakeState({ runs: [ciRun([FAIL])] }));
    const result = await runCli(["fix", "--yes", "--cwd", dir], {
      connect: async () => ({ api: fake, repo: "octocat/demo" }),
      io: { clock: instantClock(), fetch: llm.fetcher, env: { HOLLOW_AI_API_KEY: KEY } },
    });
    expect(llm.prompts).toHaveLength(0);
    expect(result.stdout).toContain("Stopped: The next call could go over the spend cap");
    expect(fake.state.pulls[0]?.draft).toBe(true);
  });

  it("re-runs jobs that hit a passing problem instead of asking the model", async () => {
    let dir = "";
    const llm = model([], () => dir);
    dir = await project({});
    const flaky = ciRun([FAIL, PASS]);
    (flaky.jobs[0] as FakeRun["jobs"][number]).log =
      "2026-11-15T10:00:00Z ##[group]Run uv sync --locked\n2026-11-15T10:00:01Z error: ECONNRESET\n2026-11-15T10:00:02Z ##[error]Process completed with exit code 1.";
    const fake = new FakeGitHub(fakeState({ runs: [flaky] }));
    const result = await runCli(["fix", "--yes", "--cwd", dir], {
      connect: async () => ({ api: fake, repo: "octocat/demo" }),
      io: { clock: instantClock(), fetch: llm.fetcher, env: { HOLLOW_AI_API_KEY: KEY } },
    });
    expect(fake.state.reruns).toEqual([501]);
    expect(llm.prompts).toHaveLength(0);
    expect(result.stdout).toContain("The checks pass now.");
    expect(result.code).toBe(EXIT.ok);
  });

  it("explains without repairing when there is no key, or with --no-ai", async () => {
    let dir = "";
    const llm = model([fixTestCommand], () => dir);
    dir = await project({});
    const fake = new FakeGitHub(fakeState({ runs: [ciRun([FAIL])] }));
    const noKey = await runCli(["fix", "--yes", "--cwd", dir], {
      connect: async () => ({ api: fake, repo: "octocat/demo" }),
      io: { clock: instantClock(), fetch: llm.fetcher, env: {} },
    });
    expect(noKey.stdout).toContain("The HOLLOW_AI_API_KEY environment variable is empty");
    expect(noKey.stdout).not.toContain("6. if checks fail");

    const noAi = await runCli(["fix", "--no-ai", "--cwd", dir], {
      connect: async () => ({ api: fake, repo: "octocat/demo" }),
      io: { clock: instantClock(), fetch: llm.fetcher, env: { HOLLOW_AI_API_KEY: KEY } },
    });
    expect(noAi.stdout).toContain("AI is turned off");
    expect(llm.prompts).toHaveLength(0);
  });
});
