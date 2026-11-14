import { spawn } from "node:child_process";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiResponse {
  status: number;
  /** Parsed JSON body, or null for an empty body. */
  data: unknown;
}

/** The slice of the GitHub REST API The Hollow uses. Tests swap in a fake. */
export interface GitHubApi {
  request(method: Method, path: string, body?: unknown): Promise<ApiResponse>;
}

/** gh is missing, not signed in, or the request never reached GitHub. */
export class GitHubError extends Error {}

export const API_VERSION = "2022-11-28";

interface GhResult {
  code: number | null;
  missing: boolean;
  stdout: string;
  stderr: string;
}

/** Run gh with no shell. The body, when there is one, goes in on stdin so it never shows in `ps`. */
export function runGh(args: string[], cwd: string, input?: string): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, {
      cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.on("error", () => {
      // gh exited before reading stdin; its exit code and output say why.
    });
    child.stdin.end(input ?? "");
  });
}

/**
 * Parse `gh api --include` output: a status line and headers, a blank line, then the body.
 * Returns null when there is no status line (the request never got an HTTP response).
 */
export function parseIncluded(stdout: string): ApiResponse | null {
  const match = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  if (match === null) return null;
  const split = /\r?\n\r?\n/.exec(stdout);
  const body = split === null ? "" : stdout.slice(split.index + split[0].length).trim();
  let data: unknown = null;
  if (body !== "") {
    try {
      data = JSON.parse(body);
    } catch {
      data = body;
    }
  }
  return { status: Number(match[1]), data };
}

/** Talks to GitHub through the developer's own `gh` login, so The Hollow never handles a token. */
export function ghApi(cwd: string): GitHubApi {
  return {
    async request(method, path, body) {
      const args = [
        "api",
        "--include",
        "--method",
        method,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        `X-GitHub-Api-Version: ${API_VERSION}`,
        path,
      ];
      if (body !== undefined) args.push("--input", "-");
      const result = await runGh(args, cwd, body === undefined ? undefined : JSON.stringify(body));
      if (result.missing) throw new GitHubError(GH_MISSING);
      const response = parseIncluded(result.stdout);
      if (response === null) {
        throw new GitHubError(
          result.stderr.trim() || `gh api ${method} ${path} failed with no response from GitHub.`,
        );
      }
      return response;
    },
  };
}

export const GH_MISSING =
  "This needs the GitHub CLI (gh). Install it from https://cli.github.com, sign in with `gh auth login`, then run again.";

const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function isRepoName(value: string): boolean {
  return REPO_PATTERN.test(value);
}

/** The `owner/name` of the GitHub repo this folder's git remote points at, as gh sees it. */
export async function currentRepo(cwd: string): Promise<string> {
  const result = await runGh(
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    cwd,
  );
  if (result.missing) throw new GitHubError(GH_MISSING);
  const name = result.stdout.trim();
  if (result.code !== 0 || !isRepoName(name)) {
    throw new GitHubError(
      `Could not tell which GitHub repo this folder belongs to${result.stderr.trim() ? ` (${result.stderr.trim()})` : ""}. Pass --repo owner/name.`,
    );
  }
  return name;
}

/** GitHub's error message for a failed request, with any field errors. */
export function errorMessage(response: ApiResponse): string {
  const data = response.data;
  if (typeof data !== "object" || data === null) return `HTTP ${response.status}`;
  const record = data as { message?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof record.message === "string") parts.push(record.message);
  if (Array.isArray(record.errors)) {
    for (const error of record.errors) {
      if (typeof error === "string") parts.push(error);
      else if (typeof error === "object" && error !== null && "message" in error) {
        parts.push(String((error as { message: unknown }).message));
      }
    }
  }
  return parts.length > 0
    ? `${parts.join(": ")} (HTTP ${response.status})`
    : `HTTP ${response.status}`;
}
