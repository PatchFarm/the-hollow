import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { actionlint } from "../src/verify/actionlint.js";
import { tempProject } from "./helpers.js";

function fakeActionlint(script: string): string {
  const bin = path.join(tempProject({}), "actionlint");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("actionlint", () => {
  it("passes when actionlint exits 0", () => {
    const bin = fakeActionlint("cat > /dev/null\nexit 0");
    expect(actionlint("ci.yml", "name: CI\n", process.cwd(), bin)).toEqual({ status: "ok" });
  });

  it("is unavailable when the binary is missing", () => {
    expect(actionlint("ci.yml", "x", process.cwd(), "/nonexistent/actionlint")).toEqual({
      status: "unavailable",
    });
  });

  it("reports actionlint's findings even when it exits before reading all of stdin", () => {
    // A large input guarantees the pipe is still being written when the process exits (EPIPE).
    const bin = fakeActionlint('echo "ci.yml:3:5: simulated problem"\nexit 1');
    const result = actionlint("ci.yml", "x".repeat(5_000_000), process.cwd(), bin);
    expect(result).toEqual({ status: "failed", output: "ci.yml:3:5: simulated problem" });
  });
});
