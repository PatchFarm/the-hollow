import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export const fixture = (name: string) => path.join(import.meta.dirname, "fixtures", name);

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Create a throwaway project directory with the given files. Removed after each test. */
export function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hollow-test-"));
  created.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/** Just the values of a list of findings, for compact assertions. */
export const values = <T>(findings: ReadonlyArray<{ value: T }>) => findings.map((f) => f.value);
