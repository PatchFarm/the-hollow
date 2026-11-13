import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInside, MAX_FILE_BYTES, ProjectFiles } from "../src/util/project-files.js";
import { tempProject } from "./helpers.js";

describe("ProjectFiles", () => {
  it("reads files inside the root", () => {
    const files = new ProjectFiles(tempProject({ "a/b.txt": "hello" }));
    expect(files.readText("a/b.txt")).toBe("hello");
    expect(files.exists("a/b.txt")).toBe(true);
    expect(files.list("a")).toEqual(["b.txt"]);
  });

  it("refuses ../ escapes and absolute paths", () => {
    const outer = tempProject({ "secret.txt": "nope", "project/ok.txt": "ok" });
    const files = new ProjectFiles(path.join(outer, "project"));
    expect(files.readText("../secret.txt")).toBeNull();
    expect(files.exists("../secret.txt")).toBe(false);
    expect(files.readText(path.join(outer, "secret.txt"))).toBeNull();
    expect(files.list("..")).toEqual([]);
  });

  it("refuses symlinks that point outside the root", () => {
    const outer = tempProject({ "secret.txt": "nope", "project/ok.txt": "ok" });
    const project = path.join(outer, "project");
    symlinkSync(path.join(outer, "secret.txt"), path.join(project, "package.json"));
    const files = new ProjectFiles(project);
    expect(files.readText("package.json")).toBeNull();
    expect(files.exists("package.json")).toBe(false);
  });

  it("follows symlinks that stay inside the root", () => {
    const project = tempProject({ "real.txt": "inside" });
    symlinkSync(path.join(project, "real.txt"), path.join(project, "link.txt"));
    expect(new ProjectFiles(project).readText("link.txt")).toBe("inside");
  });

  it("returns null for directories and oversized files", () => {
    const project = tempProject({});
    mkdirSync(path.join(project, "dir"));
    writeFileSync(path.join(project, "big.json"), "x".repeat(MAX_FILE_BYTES + 1));
    const files = new ProjectFiles(project);
    expect(files.readText("dir")).toBeNull();
    expect(files.readText("big.json")).toBeNull();
    expect(files.readText("missing.txt")).toBeNull();
  });

  it("throws a clear error for a missing project directory", () => {
    expect(() => new ProjectFiles("/definitely/not/here")).toThrow("Project directory not found");
  });
});

describe("isInside", () => {
  it.each([
    ["/repo", "/repo", true],
    ["/repo", "/repo/a/b", true],
    ["/repo", "/repo/..hidden", true],
    ["/repo", "/repo-other", false],
    ["/repo", "/", false],
    ["/repo", "/repo/../etc", false],
  ])("isInside(%j, %j) is %j", (root, candidate, expected) => {
    expect(isInside(root, path.resolve(candidate))).toBe(expected);
  });
});
