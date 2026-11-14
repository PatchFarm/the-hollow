import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { run } from "../src/cli/main.js";

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

/** Copy a fixture into a throwaway directory so a test can write to it. Removed after each test. */
export function copyFixture(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hollow-test-"));
  created.push(dir);
  cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in-process. Pass `answers` to simulate a person typing at the prompts. */
export async function runCli(
  args: string[],
  options: { cwd?: string; answers?: string[] } = {},
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const answers = options.answers === undefined ? undefined : [...options.answers];
  const code = await run(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    cwd: options.cwd ?? process.cwd(),
    ...(answers === undefined
      ? {}
      : {
          ask: async (question: string) => {
            stdout += question;
            return answers.shift() ?? "";
          },
        }),
  });
  return { code, stdout, stderr };
}
