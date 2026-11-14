import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli/main.js";
import { fixture, tempProject } from "./helpers.js";

async function cli(args: string[], cwd = process.cwd()) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd,
  });
  return { code, stdout, stderr };
}

describe("hollow CLI", () => {
  it("shows help with no arguments", async () => {
    const result = await cli([]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("plan");
  });

  it("prints the package version", async () => {
    expect((await cli(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects unknown options and commands with a usage error", async () => {
    expect((await cli(["plan", "--nope"])).code).toBe(EXIT.usage);
    expect((await cli(["deploy"])).code).toBe(EXIT.usage);
    expect((await cli(["plan", "extra"])).code).toBe(EXIT.usage);
  });

  it("says which milestone ships a planned command", async () => {
    const result = await cli(["check"]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toContain("milestone M1");
  });

  it("plan prints a readable report", async () => {
    const result = await cli(["plan", "--cwd", fixture("python-fastapi")]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Language         Python");
    expect(result.stdout).toContain("Package manager  uv  (uv.lock)");
    expect(result.stdout).toContain("Migrations       alembic  (alembic.ini)");
    expect(result.stdout).toContain("hollow.yml\n  Not found.");
  });

  it("plan uses the working directory by default", async () => {
    const result = await cli(["plan"], fixture("node-hono-workers"));
    expect(result.stdout).toContain("cloudflare-workers (wrangler.toml)");
  });

  it("plan --json returns detection and config", async () => {
    const result = await cli(["plan", "--json", "--cwd", fixture("node-next-prisma")]);
    const parsed = JSON.parse(result.stdout) as {
      detection: { language: string };
      config: { status: string };
    };
    expect(parsed.detection.language).toBe("node");
    expect(parsed.config.status).toBe("missing");
  });

  it("plan fails when hollow.yml is invalid", async () => {
    const dir = tempProject({ "package.json": "{}", "hollow.yml": "version: 2\n" });
    const result = await cli(["plan", "--cwd", dir]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stdout).toContain("Invalid:");
  });

  it("plan reports a valid hollow.yml", async () => {
    const dir = tempProject({
      "package.json": "{}",
      "package-lock.json": "{}",
      "hollow.yml": "version: 1\ndeploy:\n  target: cloudflare-workers\n",
    });
    expect((await cli(["plan", "--cwd", dir])).stdout).toContain(
      "Valid. Deploy target: cloudflare-workers.",
    );
  });

  it("plan fails clearly for a missing directory", async () => {
    const result = await cli(["plan", "--cwd", "/definitely/not/here"]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toContain("Project directory not found");
  });
});
