import { spawn } from "node:child_process";

export interface GitResult {
  code: number | null;
  missing: boolean;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {}

/** Run git with no shell, in the developer's own setup (identity, hooks, credentials). */
export function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    let settled = false;
    const done = (code: number | null, missing: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ code, missing, stdout, stderr });
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") stderr += `${error.message}\n`;
      done(null, error.code === "ENOENT");
    });
    child.on("close", (code) => done(code, false));
  });
}

/** Run git and return stdout, or throw GitError with git's own message. */
async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.missing) throw new GitError("This needs git. Install it, then run again.");
  if (result.code !== 0) {
    throw new GitError(
      `git ${args[0]} failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`,
    );
  }
  return result.stdout;
}

/** The working tree's top folder, or null when this is not a git repo. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.missing) throw new GitError("This needs git. Install it, then run again.");
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The checked-out branch, or null on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], cwd)).trim();
}

/** The commit the branch's upstream points at, or null when it has none. */
export async function upstreamSha(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", "@{upstream}"], cwd);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Which of `paths` have changes not yet committed (new, modified or deleted), from
 * `git status --porcelain -z`, which quotes nothing and so handles any file name.
 */
export async function changedPaths(cwd: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const out = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths],
    cwd,
  );
  const entries = out.split("\0");
  const changed: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as string;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    changed.push(entry.slice(3));
    // A rename or copy is followed by its old path, which is not a change of its own here.
    if (status.includes("R") || status.includes("C")) i++;
  }
  return [...new Set(changed)].sort();
}

/** True when a branch of this name exists here or on the remote. */
export async function branchExists(cwd: string, branch: string, remote: string): Promise<boolean> {
  const local = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  if (local.code === 0) return true;
  const remoteRef = await runGit(["ls-remote", "--exit-code", "--heads", remote, branch], cwd);
  return remoteRef.code === 0;
}

export async function hasRemote(cwd: string, remote: string): Promise<boolean> {
  const result = await runGit(["remote", "get-url", remote], cwd);
  return result.code === 0;
}

/** Create a branch at HEAD and switch to it. Uncommitted changes come along, untouched. */
export async function createBranch(cwd: string, branch: string): Promise<void> {
  await git(["switch", "--create", branch], cwd);
}

/**
 * Commit exactly these paths and nothing else: anything else already staged stays staged and
 * out of this commit.
 */
export async function commitPaths(cwd: string, paths: readonly string[], message: string) {
  await git(["add", "--all", "--", ...paths], cwd);
  await git(["commit", "--quiet", "--message", message, "--only", "--", ...paths], cwd);
}

export async function push(cwd: string, remote: string, branch: string): Promise<void> {
  await git(["push", "--quiet", "--set-upstream", remote, `refs/heads/${branch}`], cwd);
}

/** True when the file is in the commit HEAD points at. */
export async function existsAtHead(cwd: string, file: string): Promise<boolean> {
  const result = await runGit(["cat-file", "-e", `HEAD:${file}`], cwd);
  return result.code === 0;
}
