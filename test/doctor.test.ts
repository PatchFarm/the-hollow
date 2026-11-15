import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/cli/main.js";
import { GitHubError } from "../src/github/api.js";
import { FakeGitHub, fakeState } from "./fake-github.js";
import { copyFixture, runCli, tempProject } from "./helpers.js";

/** The FastAPI sample after `hollow init`, so every file is exactly what hollow.yml generates. */
async function initialised(): Promise<string> {
  const dir = copyFixture("python-fastapi");
  expect((await runCli(["init", "--yes", "--target", "docker", "--cwd", dir])).code).toBe(EXIT.ok);
  return dir;
}

const BAD_WORKFLOW = [
  "on: pull_request",
  "jobs:",
  "  greet:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  `      - run: echo "\${{ github.event.pull_request.title }}"`,
  "",
].join("\n");

describe("hollow doctor: the repo", () => {
  it("finds nothing wrong right after init", async () => {
    const dir = await initialised();
    const result = await runCli(["doctor", "--offline", "--cwd", dir]);
    expect(result.stdout).toContain("No problems found.");
    expect(result.stdout).toContain("GitHub was not checked (--offline).");
    expect(result.code).toBe(EXIT.ok);
  });

  it("holds workflows The Hollow did not write to the same policy, as errors", async () => {
    const dir = await initialised();
    writeFileSync(path.join(dir, ".github/workflows/greet.yml"), BAD_WORKFLOW);
    const result = await runCli(["doctor", "--offline", "--cwd", dir]);
    expect(result.stdout).toContain("error  .github/workflows/greet.yml: permissions:");
    expect(result.stdout).toContain(
      "error  .github/workflows/greet.yml: jobs.greet.steps[0]: actions/checkout@v4 is not pinned",
    );
    expect(result.stdout).toContain(
      "jobs.greet.steps[1].run: Pass values into scripts through `env:`",
    );
    expect(result.stdout).toContain("Edit .github/workflows/greet.yml (rule: script-injection).");
    expect(result.stdout).toMatch(/[45] errors, 0 warnings\./);
    expect(result.code).toBe(EXIT.failure);
  });

  it("spots The Hollow's files that are missing, edited by hand, or not its own", async () => {
    const dir = await initialised();
    const ci = path.join(dir, ".github/workflows/ci.yml");
    writeFileSync(ci, `${readFileSync(ci, "utf8")}\n# a hand edit\n`);
    rmSync(path.join(dir, "docs/PIPELINE.md"));
    writeFileSync(
      path.join(dir, ".github/workflows/pr-title.yml"),
      "name: mine\non: push\npermissions: {}\njobs: {}\n",
    );
    rmSync(path.join(dir, ".editorconfig"));

    const result = await runCli(["doctor", "--offline", "--cwd", dir]);
    expect(result.stdout).toContain(
      "warn   .github/workflows/ci.yml is not what hollow.yml generates: it was edited by hand",
    );
    expect(result.stdout).toContain("warn   docs/PIPELINE.md is missing.");
    expect(result.stdout).toContain(
      "warn   .github/workflows/pr-title.yml was not written by The Hollow, so `hollow upgrade` will not update it.",
    );
    expect(result.stdout).toContain(
      "info   .editorconfig is missing. It is a starting point you own.",
    );
    // Warnings alone do not fail the run.
    expect(result.code).toBe(EXIT.ok);
  });

  it("still audits workflows when the repo has no hollow.yml, and reports an invalid one", async () => {
    const plain = tempProject({
      "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest" } }),
      "package-lock.json": "{}",
      ".github/workflows/ci.yml": BAD_WORKFLOW,
    });
    const result = await runCli(["doctor", "--offline", "--cwd", plain]);
    expect(result.stdout).toContain("There is no hollow.yml");
    expect(result.stdout).toContain("error  .github/workflows/ci.yml");
    expect(result.code).toBe(EXIT.failure);

    writeFileSync(path.join(plain, "hollow.yml"), "version: 2\n");
    const invalid = await runCli(["doctor", "--offline", "--cwd", plain]);
    expect(invalid.stdout).toContain("error  hollow.yml: ");
  });

  it("says when there are no workflows at all", async () => {
    const dir = tempProject({
      "package.json": JSON.stringify({ name: "x" }),
      "package-lock.json": "{}",
    });
    mkdirSync(path.join(dir, ".github"));
    const result = await runCli(["doctor", "--offline", "--cwd", dir]);
    expect(result.stdout).toContain("There are no workflows in .github/workflows");
  });

  it("prints JSON for scripts", async () => {
    const dir = await initialised();
    writeFileSync(path.join(dir, ".github/workflows/greet.yml"), BAD_WORKFLOW);
    const result = await runCli(["doctor", "--offline", "--json", "--cwd", dir]);
    const report = JSON.parse(result.stdout) as {
      errors: number;
      findings: { severity: string; area: string }[];
    };
    expect(report.errors).toBeGreaterThan(0);
    expect(report.findings.some((f) => f.area === "workflows" && f.severity === "error")).toBe(
      true,
    );
    expect(result.code).toBe(EXIT.failure);
  });
});

describe("hollow doctor: GitHub, read-only", () => {
  it("reports settings protect would change, missing secrets and failing runs, without writing anything", async () => {
    const dir = await initialised();
    const fake = new FakeGitHub(
      fakeState({
        runs: [
          {
            id: 77,
            name: "CI",
            head_sha: "abc",
            branch: "main",
            states: [{ status: "completed", conclusion: "failure" }],
            jobs: [],
          },
          {
            id: 78,
            name: "Scheduled",
            head_sha: "abc",
            branch: "main",
            states: [{ status: "completed", conclusion: "success" }],
            jobs: [],
          },
        ],
      }),
    );
    const result = await runCli(["doctor", "--cwd", dir], {
      connect: async () => ({ api: fake, repo: "octocat/demo" }),
    });
    expect(result.stdout).toContain("GitHub");
    expect(result.stdout).toContain("Run `hollow protect` (it shows each change and asks first).");
    expect(result.stdout).toContain("The latest CI run on main failed");
    expect(result.stdout).toContain("Run `hollow fix --run 77` to see why.");
    expect(result.stdout).not.toContain("The latest Scheduled run");
    expect(fake.writes).toEqual([]);
  });

  it("errors on a missing required secret", async () => {
    const dir = copyFixture("python-django");
    writeFileSync(
      path.join(dir, "hollow.yml"),
      "version: 1\ndeploy:\n  target: vps\n  host: app.example.com\n",
    );
    expect((await runCli(["init", "--yes", "--cwd", dir])).code).toBe(EXIT.ok);
    const fake = new FakeGitHub(fakeState());
    const result = await runCli(["doctor", "--cwd", dir], {
      connect: async () => ({ api: fake, repo: "octocat/demo" }),
    });
    expect(result.stdout).toMatch(/error {2}Secret VPS_SSH_KEY \(staging\) is not set/);
    expect(result.stdout).toContain("Run `hollow secrets`.");
    expect(result.code).toBe(EXIT.failure);
  });

  it("skips GitHub with a note when gh cannot be used", async () => {
    const dir = await initialised();
    const result = await runCli(["doctor", "--cwd", dir], {
      connect: async () => {
        throw new GitHubError("This needs the GitHub CLI (gh).");
      },
    });
    expect(result.stdout).toContain("GitHub was not checked: This needs the GitHub CLI (gh).");
    expect(result.code).toBe(EXIT.ok);
  });
});
