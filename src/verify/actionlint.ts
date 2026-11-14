import { spawnSync } from "node:child_process";

export type LintResult =
  | { status: "ok" }
  | { status: "unavailable" }
  | { status: "failed"; output: string };

/**
 * Check one workflow with actionlint (https://github.com/rhysd/actionlint) when it is installed.
 * The workflow goes in on stdin, so nothing is written before it passes. No shell is involved and
 * the content is never interpolated into a command line.
 */
export function actionlint(
  workflowPath: string,
  content: string,
  cwd: string,
  binary = process.env.HOLLOW_ACTIONLINT ?? "actionlint",
): LintResult {
  const result = spawnSync(binary, ["-no-color", "-stdin-filename", workflowPath, "-"], {
    cwd,
    input: content,
    encoding: "utf8",
    timeout: 60_000,
    shell: false,
  });
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return { status: "unavailable" };
    return { status: "failed", output: result.error.message };
  }
  if (result.status === 0) return { status: "ok" };
  return { status: "failed", output: `${result.stdout}${result.stderr}`.trim() };
}
