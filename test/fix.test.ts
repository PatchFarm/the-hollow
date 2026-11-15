import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/cli/main.js";
import { FakeGitHub, type FakeRun, fakeState } from "./fake-github.js";
import { copyFixture, runCli } from "./helpers.js";

/** git with a throwaway identity, no signing and no hooks from the machine's own config. */
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

/**
 * A pushed repo of the FastAPI sample with `hollow init` run on top, so The Hollow's files are
 * uncommitted, like right after init. Its origin is a local bare repo.
 */
async function project(): Promise<{ dir: string; origin: string }> {
  const dir = copyFixture("python-fastapi");
  const origin = mkdtempSync(path.join(tmpdir(), "hollow-origin-"));
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(dir, "init", "--quiet", "--initial-branch=main");
  // hollow fix runs git with the machine's own config, like it would for a developer. CI runners
  // have no identity, so the repo gets one, and signing stays off whatever the machine says.
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--message", "feat: the app");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "--quiet", "origin", "main");
  const init = await runCli(["init", "--yes", "--target", "docker", "--cwd", dir]);
  expect(init.code).toBe(EXIT.ok);
  return { dir, origin };
}

const LOG = [
  "2026-11-15T10:00:00.0000000Z ##[group]Run uv sync --locked",
  "2026-11-15T10:00:00.1000000Z uv sync --locked",
  "2026-11-15T10:00:00.2000000Z ##[endgroup]",
  "2026-11-15T10:00:01.0000000Z Using DATABASE_URL=postgresql://app:very-secret-pw@db/app",
  "2026-11-15T10:00:01.1000000Z token local-env-value-123 was read",
  "2026-11-15T10:00:01.2000000Z error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.",
  "2026-11-15T10:00:01.3000000Z ##[error]Process completed with exit code 2.",
].join("\n");

const failingCi = (): FakeRun => ({
  id: 501,
  name: "CI",
  head_sha: "*",
  states: [
    { status: "queued", conclusion: null },
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
  ],
  jobs: [
    {
      id: 9001,
      name: "Build and test",
      conclusion: "failure",
      steps: [
        { name: "Set up job", conclusion: "success" },
        { name: "Install dependencies", conclusion: "failure" },
      ],
      log: LOG,
    },
    { id: 9002, name: "Secret scan (Gitleaks)", conclusion: "success", steps: [], log: "" },
  ],
});

const passing = (id: number, name: string): FakeRun => ({
  id,
  name,
  head_sha: "*",
  states: [{ status: "completed", conclusion: "success" }],
  jobs: [],
});

/** No waiting: each poll moves the clock on by one tick. */
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

function connect(fake: FakeGitHub) {
  return async () => ({ api: fake, repo: "octocat/demo" });
}

describe("hollow fix: publishing the pipeline", () => {
  it("commits only The Hollow's files to hollow/pipeline, pushes, opens the PR, then explains the failure", async () => {
    const { dir, origin } = await project();
    // Unrelated work: a new file and a staged edit, which must stay out of the commit.
    writeFileSync(path.join(dir, "notes.txt"), "mine\n");
    writeFileSync(path.join(dir, "README.md"), "edited\n");
    git(dir, "add", "README.md");
    // A local secret, which must never reach the output even though the log prints it.
    writeFileSync(path.join(dir, ".env"), "API_TOKEN=local-env-value-123\n");

    const fake = new FakeGitHub(fakeState({ runs: [failingCi(), passing(502, "PR title")] }));
    const result = await runCli(["fix", "--cwd", dir], {
      connect: connect(fake),
      answers: ["y"],
      io: { clock: instantClock() },
    });

    expect(result.stdout).toContain("hollow fix will:");
    expect(result.stdout).toContain("create the branch hollow/pipeline from main");
    expect(result.stdout).toContain('as "ci: add The Hollow pipeline"');
    expect(result.stdout).toContain(".github/workflows/ci.yml");
    expect(result.stdout).toContain("Go ahead? [y/N]");

    // The commit holds The Hollow's files and nothing else.
    expect(git(dir, "branch", "--show-current")).toBe("hollow/pipeline");
    const committed = git(dir, "show", "--name-only", "--format=", "HEAD").split("\n");
    expect(committed).toContain(".github/workflows/ci.yml");
    expect(committed).toContain("hollow.yml");
    expect(committed).not.toContain("README.md");
    expect(committed).not.toContain("notes.txt");
    expect(committed).not.toContain(".env");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("ci: add The Hollow pipeline");
    expect(git(dir, "status", "--porcelain")).toContain("A  README.md");
    expect(git(dir, "status", "--porcelain")).toContain("?? notes.txt");
    // Pushed to origin.
    expect(git(origin, "rev-parse", "hollow/pipeline")).toBe(git(dir, "rev-parse", "HEAD"));

    // The pull request.
    expect(fake.state.pulls).toHaveLength(1);
    expect(fake.state.pulls[0]).toMatchObject({
      head: "hollow/pipeline",
      base: "main",
      title: "ci: add The Hollow pipeline",
    });
    expect(result.stdout).toContain("Opened pull request #");

    // Watching, then the explanation.
    expect(result.stdout).toContain("CI: queued");
    expect(result.stdout).toContain("CI: in progress");
    expect(result.stdout).toContain("CI: failure");
    expect(result.stdout).toContain("PR title: passed");
    expect(result.stdout).toContain('Failed: CI / Build and test, at "Install dependencies"');
    expect(result.stdout).toContain("uv.lock is out of date");
    expect(result.stdout).toContain("Run `uv lock`");
    expect(result.stdout).not.toContain("Secret scan");
    expect(result.stdout).not.toContain("very-secret-pw");
    expect(result.stdout).not.toContain("local-env-value-123");
    expect(result.code).toBe(EXIT.failure);
  });

  it("changes nothing without a yes", async () => {
    const { dir } = await project();
    const before = git(dir, "rev-parse", "HEAD");
    const fake = new FakeGitHub(fakeState());

    const declined = await runCli(["fix", "--cwd", dir], {
      connect: connect(fake),
      answers: ["n"],
    });
    expect(declined.stdout).toContain("Nothing changed.");
    expect(declined.code).toBe(EXIT.failure);

    // No terminal and no --yes: it refuses rather than guess.
    const noTerminal = await runCli(["fix", "--cwd", dir], { connect: connect(fake) });
    expect(noTerminal.stderr).toContain("Run again with --yes");

    expect(git(dir, "branch", "--show-current")).toBe("main");
    expect(git(dir, "rev-parse", "HEAD")).toBe(before);
    expect(fake.writes).toEqual([]);
  });

  it("stops after opening the pull request with --no-wait", async () => {
    const { dir } = await project();
    const fake = new FakeGitHub(fakeState({ runs: [failingCi()] }));
    const result = await runCli(["fix", "--yes", "--no-wait", "--cwd", dir], {
      connect: connect(fake),
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Opened pull request #");
    expect(result.stdout).not.toContain("Watching");
  });

  it("picks a free branch name, and reuses a hollow/ branch and its pull request", async () => {
    const { dir } = await project();
    git(dir, "branch", "hollow/pipeline");
    const fake = new FakeGitHub(fakeState({ runs: [passing(601, "CI")] }));
    const first = await runCli(["fix", "--yes", "--cwd", dir], {
      connect: connect(fake),
      io: { clock: instantClock() },
    });
    expect(first.stdout).toContain("create the branch hollow/pipeline-2 from main");
    expect(git(dir, "branch", "--show-current")).toBe("hollow/pipeline-2");
    expect(first.stdout).toContain("All 1 check passed.");
    expect(first.code).toBe(EXIT.ok);

    // Change a file The Hollow owns, then run again on the same branch.
    writeFileSync(
      path.join(dir, "hollow.yml"),
      `${git(dir, "show", "HEAD:hollow.yml")}\n# edited\n`,
    );
    const second = await runCli(["fix", "--yes", "--cwd", dir], {
      connect: connect(fake),
      io: { clock: instantClock() },
    });
    expect(second.stdout).toContain("commit on this branch, hollow/pipeline-2");
    expect(second.stdout).toContain('as "ci: update The Hollow pipeline"');
    expect(second.stdout).toContain(`update pull request #${fake.state.pulls[0]?.number}`);
    expect(fake.state.pulls).toHaveLength(1);
  });
});

describe("hollow fix: explaining runs", () => {
  it("watches the pushed commit when there is nothing to commit", async () => {
    const { dir } = await project();
    const fake = new FakeGitHub(fakeState({ runs: [passing(701, "CI")] }));
    await runCli(["fix", "--yes", "--no-wait", "--cwd", dir], { connect: connect(fake) });
    const again = await runCli(["fix", "--cwd", dir], {
      connect: connect(fake),
      io: { clock: instantClock() },
    });
    expect(again.stdout).not.toContain("hollow fix will:");
    expect(again.stdout).toContain("Watching the checks on");
    expect(again.code).toBe(EXIT.ok);
  });

  it("asks for a push when the commit never reached GitHub", async () => {
    const { dir } = await project();
    git(dir, "add", "--all");
    git(dir, "commit", "--quiet", "--message", "ci: by hand");
    const result = await runCli(["fix", "--cwd", dir], {
      connect: connect(new FakeGitHub(fakeState())),
    });
    expect(result.stderr).toContain("this commit is not pushed");
    expect(result.code).toBe(EXIT.failure);
  });

  it("explains one run by ID, including a workflow GitHub could not start", async () => {
    const { dir } = await project();
    const fake = new FakeGitHub(
      fakeState({
        runs: [
          {
            id: 801,
            name: "Release",
            head_sha: "abc",
            states: [{ status: "completed", conclusion: "startup_failure" }],
            jobs: [],
          },
        ],
      }),
    );
    const result = await runCli(["fix", "--run", "801", "--cwd", dir], {
      connect: connect(fake),
      io: { clock: instantClock() },
    });
    expect(result.stdout).toContain("Watching run 801...");
    expect(result.stdout).toContain("Failed: Release / Release");
    expect(result.stdout).toContain("GitHub could not start the workflow");
    expect(result.stdout).toContain("(in the pipeline)");
    // Explaining a run never commits anything.
    expect(git(dir, "branch", "--show-current")).toBe("main");
  });

  it("shows the errors and the end of the log for a failure it does not recognise", async () => {
    const { dir } = await project();
    const run = failingCi();
    (run.jobs[0] as FakeRun["jobs"][number]).log =
      "2026-11-15T10:00:00Z ##[group]Run ./deploy\n2026-11-15T10:00:01Z segfault in deploy\n2026-11-15T10:00:02Z ##[error]Process completed with exit code 139.";
    const fake = new FakeGitHub(fakeState({ runs: [run] }));
    const result = await runCli(["fix", "--run", "501", "--cwd", dir], {
      connect: connect(fake),
      io: { clock: instantClock() },
    });
    expect(result.stdout).toContain("The Hollow does not recognise this failure.");
    expect(result.stdout).toContain("Error: Process completed with exit code 139.");
    expect(result.stdout).toContain("    segfault in deploy");
  });

  it("says when no workflow starts", async () => {
    const { dir } = await project();
    const fake = new FakeGitHub(fakeState());
    const result = await runCli(["fix", "--yes", "--cwd", dir], {
      connect: connect(fake),
      io: { clock: instantClock() },
    });
    expect(result.stderr).toContain("No workflow started for");
    expect(result.code).toBe(EXIT.failure);
  });

  it("rejects a run ID that is not a number", async () => {
    const result = await runCli(["fix", "--run", "abc"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("--run takes a workflow run ID");
  });
});
