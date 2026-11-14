import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../src/cli/main.js";
import { osvFindings } from "../src/pipeline/severity.js";
import { runCli, tempProject } from "./helpers.js";

const ok = (message: string) => `node -e "console.log('${message}')"`;
const fail = (message: string) => `node -e "console.error('${message}'); process.exit(1)"`;

function nodeProject(scripts: Record<string, string>, extra: Record<string, string> = {}): string {
  return tempProject({
    "package.json": JSON.stringify({ name: "demo", scripts }),
    "package-lock.json": "{}",
    ...extra,
  });
}

function fakeTool(script: string): string {
  const bin = path.join(tempProject({}), "tool");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A fake osv-scanner that writes `report` to its --output path and exits with `code`. */
function fakeOsv(report: unknown, code: number): string {
  return fakeTool(
    [
      'while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done',
      `cat > "$out" <<'JSON'`,
      JSON.stringify(report),
      "JSON",
      `exit ${code}`,
    ].join("\n"),
  );
}

const report = (severity: string) => ({
  results: [
    {
      packages: [
        {
          package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
          groups: [{ ids: ["GHSA-xxxx"], max_severity: severity }],
        },
      ],
    },
  ],
});

beforeEach(() => {
  process.env.HOLLOW_GITLEAKS = "/nonexistent/gitleaks";
  process.env.HOLLOW_OSV_SCANNER = "/nonexistent/osv-scanner";
});
afterEach(() => {
  delete process.env.HOLLOW_GITLEAKS;
  delete process.env.HOLLOW_OSV_SCANNER;
});

describe("hollow check", () => {
  it("runs the project's checks and passes when they pass", async () => {
    const dir = nodeProject({ lint: ok("lint ran"), test: ok("tests ran"), build: ok("built") });
    const result = await runCli(["check", "--cwd", dir]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("==> Lint: npm run lint");
    expect(result.stdout).toContain("tests ran");
    expect(result.stdout).toMatch(/passed +Build/);
    expect(result.stdout).toContain("gitleaks is not installed; CI runs it");
    expect(result.stdout).toContain("All checks passed: 3 ran (2 skipped).");
  });

  it("keeps going after a failure and fails at the end", async () => {
    const dir = nodeProject({ lint: fail("lint broke"), test: ok("tests ran") });
    const result = await runCli(["check", "--cwd", dir]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toContain("lint broke");
    expect(result.stdout).toContain("tests ran");
    expect(result.stdout).toMatch(/failed +Lint/);
    expect(result.stdout).toContain("1 of 2 checks failed");
  });

  it("--only runs just the named checks", async () => {
    const dir = nodeProject({ lint: ok("lint ran"), test: fail("should not run") });
    const result = await runCli(["check", "--only", "lint", "--cwd", dir]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stderr).not.toContain("should not run");
    expect(result.stdout).not.toContain("Gitleaks");
  });

  it("rejects unknown --only names", async () => {
    expect((await runCli(["check", "--only", "lint,deploy"])).code).toBe(EXIT.usage);
    expect((await runCli(["check", "--only", ","])).code).toBe(EXIT.usage);
  });

  it("skips the test placeholder instead of pretending tests passed", async () => {
    const result = await runCli(["check", "--only", "test", "--cwd", nodeProject({})]);
    expect(result.stdout).toMatch(/skipped +Test +no tests found/);
    expect(result.stdout).toContain("No checks ran (1 skipped).");
  });

  it("--install runs the locked install first", async () => {
    const dir = nodeProject({ lint: ok("lint ran") });
    const result = await runCli(["check", "--install", "--only", "lint", "--cwd", dir]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("==> Install dependencies: npm ci");
    expect(result.stdout).toMatch(/passed +Install dependencies/);
    expect(result.stdout).toContain("lint ran");
  });

  it("--install stops before the checks when the install fails", async () => {
    // npm ci refuses a corrupt lockfile without touching the network.
    const dir = nodeProject({ lint: ok("lint ran") }, { "package-lock.json": "not json" });
    const result = await runCli(["check", "--install", "--cwd", dir]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toContain("the checks did not run");
    expect(result.stdout).not.toContain("lint ran");
  });

  it("puts a pip project's .venv first on PATH", async () => {
    const dir = tempProject({ "requirements.txt": "pytest\n", "pytest.ini": "" });
    mkdirSync(path.join(dir, ".venv/bin"), { recursive: true });
    writeFileSync(path.join(dir, ".venv/bin/pytest"), '#!/bin/sh\necho "venv pytest ran"\n');
    chmodSync(path.join(dir, ".venv/bin/pytest"), 0o755);
    const result = await runCli(["check", "--only", "test", "--cwd", dir]);
    expect(result.stdout).toContain("venv pytest ran");
    expect(result.code).toBe(EXIT.ok);
  });

  it("mentions the database services CI starts", async () => {
    const dir = nodeProject({}, {});
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { pg: "8" }, scripts: { test: ok("t") } }),
    );
    const result = await runCli(["check", "--only", "test", "--cwd", dir]);
    expect(result.stdout).toContain("CI starts postgres for the tests");
  });

  it("runs Gitleaks when installed and fails on a finding", async () => {
    process.env.HOLLOW_GITLEAKS = fakeTool('echo "gitleaks $*"\nexit 1');
    const dir = nodeProject({});
    const result = await runCli(["check", "--only", "secrets", "--cwd", dir]);
    expect(result.stdout).toContain("gitleaks dir --redact --exit-code 1 .");
    expect(result.code).toBe(EXIT.failure);
  });

  it("applies security.failOn to OSV-Scanner findings", async () => {
    const dir = nodeProject({});
    process.env.HOLLOW_OSV_SCANNER = fakeOsv(report("7.5"), 1);
    const high = await runCli(["check", "--only", "dependencies", "--cwd", dir]);
    expect(high.code).toBe(EXIT.failure);
    expect(high.stdout).toContain("BLOCKS  npm lodash@4.17.20 (GHSA-xxxx), CVSS 7.5");

    writeFileSync(
      path.join(dir, "hollow.yml"),
      "version: 1\ndeploy:\n  target: docker\nsecurity:\n  failOn: critical\n",
    );
    const critical = await runCli(["check", "--only", "dependencies", "--cwd", dir]);
    expect(critical.code).toBe(EXIT.ok);
    expect(critical.stdout).toContain("note    npm lodash@4.17.20");
  });

  it("treats a scanner crash as a failure", async () => {
    process.env.HOLLOW_OSV_SCANNER = fakeTool("exit 3");
    const result = await runCli(["check", "--only", "dependencies", "--cwd", nodeProject({})]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stdout).toContain("scanner exited with 3");
  });

  it("refuses an invalid hollow.yml", async () => {
    const dir = nodeProject({}, { "hollow.yml": "version: 1\ndeploy:\n  target: nope\n" });
    const result = await runCli(["check", "--cwd", dir]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toContain("hollow.yml is invalid");
  });
});

describe("osvFindings", () => {
  it("blocks at or above the threshold", () => {
    expect(osvFindings(report("7.0"), "high")[0]?.blocking).toBe(true);
    expect(osvFindings(report("6.9"), "high")[0]?.blocking).toBe(false);
    expect(osvFindings(report("9.8"), "critical")[0]?.blocking).toBe(true);
  });

  it("only blocks unscored advisories at low", () => {
    expect(osvFindings(report(""), "high")[0]).toMatchObject({ cvss: null, blocking: false });
    expect(osvFindings(report(""), "low")[0]?.blocking).toBe(true);
  });

  it("ignores malformed reports", () => {
    expect(osvFindings(null, "high")).toEqual([]);
    expect(osvFindings({ results: "nope" }, "high")).toEqual([]);
  });
});
