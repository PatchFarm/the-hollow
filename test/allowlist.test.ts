import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkEditablePath } from "../src/agent/allowlist.js";
import { tempProject } from "./helpers.js";

describe("what the agent may edit", () => {
  const root = tempProject({ "src/app.ts": "export {};\n", ".github/workflows/ci.yml": "x\n" });

  it("allows the pipeline and deploy config", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      ".github/workflows/new.yml",
      ".github/hollow/check-migrations.py",
      ".github/dependabot.yml",
      "hollow.yml",
      ".pre-commit-config.yaml",
      "Dockerfile",
      ".dockerignore",
      "deploy/compose.yaml",
      "vercel.json",
      "wrangler.toml",
      "wrangler.jsonc",
    ]) {
      expect(checkEditablePath(root, file), file).toEqual({ ok: true, path: file });
    }
  });

  it("refuses application code and everything else, and says to suggest it instead", () => {
    for (const file of ["src/app.ts", "package.json", "README.md", "compose.yaml", ".github"]) {
      const result = checkEditablePath(root, file);
      expect(result.ok, file).toBe(false);
    }
    const app = checkEditablePath(root, "src/app.ts");
    expect(!app.ok && app.reason).toContain("Suggest changes to src/app.ts in the pull request");
  });

  it("refuses paths that could escape or confuse the check", () => {
    for (const file of [
      "",
      "/etc/passwd",
      "C:/x/hollow.yml",
      ".github/../src/app.ts",
      "./hollow.yml",
      ".github//ci.yml",
      ".github\\workflows\\ci.yml",
      ".github/workflows/ci.yml\n",
      ".github/.git/config",
      ".git/config",
      `.github/${"a".repeat(400)}`,
    ]) {
      expect(checkEditablePath(root, file).ok, JSON.stringify(file)).toBe(false);
    }
  });

  it("refuses any path through a symlink, even one that stays in the repo", () => {
    const dir = tempProject({ "src/app.ts": "export {};\n" });
    mkdirSync(path.join(dir, ".github"));
    symlinkSync(path.join(dir, "src"), path.join(dir, ".github", "linked"));
    symlinkSync(path.join(dir, "src", "app.ts"), path.join(dir, "Dockerfile"));
    const linked = checkEditablePath(dir, ".github/linked/app.ts");
    expect(linked.ok).toBe(false);
    expect(!linked.ok && linked.reason).toContain("symlink");
    expect(checkEditablePath(dir, "Dockerfile").ok).toBe(false);
  });
});
