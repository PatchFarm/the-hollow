import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeProjectFile } from "../src/util/project-writer.js";
import { tempProject } from "./helpers.js";

describe("writeProjectFile", () => {
  it("creates parent directories and leaves no temp files", () => {
    const dir = tempProject({});
    writeProjectFile(dir, ".github/workflows/ci.yml", "name: CI\n");
    expect(readFileSync(path.join(dir, ".github/workflows/ci.yml"), "utf8")).toBe("name: CI\n");
    expect(readdirSync(path.join(dir, ".github/workflows"))).toEqual(["ci.yml"]);
  });

  it("refuses paths outside the project", () => {
    const dir = tempProject({});
    expect(() => writeProjectFile(dir, "../escape.yml", "x")).toThrow(/outside the project/);
    expect(() => writeProjectFile(dir, "/tmp/escape.yml", "x")).toThrow(/absolute/);
  });

  it("refuses to write through a symlinked directory that leaves the project", () => {
    const outside = tempProject({});
    const dir = tempProject({});
    symlinkSync(outside, path.join(dir, ".github"));
    expect(() => writeProjectFile(dir, ".github/dependabot.yml", "x")).toThrow(/symlink/);
    expect(existsSync(path.join(outside, "dependabot.yml"))).toBe(false);
  });

  it("refuses to replace a symlink", () => {
    const outside = tempProject({ "target.yml": "original" });
    const dir = tempProject({});
    symlinkSync(path.join(outside, "target.yml"), path.join(dir, "hollow.yml"));
    expect(() => writeProjectFile(dir, "hollow.yml", "x")).toThrow(/symlink/);
    expect(readFileSync(path.join(outside, "target.yml"), "utf8")).toBe("original");
  });

  it("replaces an existing regular file", () => {
    const dir = tempProject({ "hollow.yml": "old" });
    writeProjectFile(dir, "hollow.yml", "new");
    expect(readFileSync(path.join(dir, "hollow.yml"), "utf8")).toBe("new");
  });
});
