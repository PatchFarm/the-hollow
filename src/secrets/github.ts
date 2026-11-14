import { spawn } from "node:child_process";
import { errorMessage, GH_MISSING, type GitHubApi, GitHubError, runGh } from "../github/api.js";
import type { Setting } from "./catalog.js";

export type Status = "set" | "set-in-repo" | "missing" | "no-environment";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Names in a `{ secrets: [...] }` or `{ variables: [...] }` page. Values are never read. */
function names(data: unknown, key: "secrets" | "variables"): string[] {
  const list = isObject(data) ? data[key] : undefined;
  return Array.isArray(list)
    ? list.flatMap((item) => (isObject(item) && typeof item.name === "string" ? [item.name] : []))
    : [];
}

async function list(
  api: GitHubApi,
  path: string,
  key: "secrets" | "variables",
): Promise<Set<string>> {
  // Variables come at most 30 to a page; secrets up to 100.
  const perPage = key === "variables" ? 30 : 100;
  const found = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const response = await api.request("GET", `${path}?per_page=${perPage}&page=${page}`);
    if (response.status === 403) {
      const permission = key === "secrets" ? "Secrets" : "Variables";
      throw new GitHubError(
        `Your gh login cannot read this repo's ${key} (${errorMessage(response)}). A fine-grained token needs the "${permission}" repository permission (read, or read and write to set them); a classic token needs the repo scope.`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubError(`Could not list ${key} (${path}): ${errorMessage(response)}`);
    }
    const batch = names(response.data, key);
    for (const name of batch) found.add(name);
    if (batch.length < perPage) break;
  }
  return found;
}

/**
 * Which settings are already set, by name only: GitHub never returns secret values, and The
 * Hollow does not read variable values. An environment setting also counts as set when the repo
 * has one with that name, since jobs fall back to repo-level values.
 */
export async function readStatus(
  api: GitHubApi,
  repo: string,
  settings: Setting[],
): Promise<Map<Setting, Status>> {
  const base = `repos/${repo}`;
  const repoSecrets = await list(api, `${base}/actions/secrets`, "secrets");
  const repoVariables = await list(api, `${base}/actions/variables`, "variables");
  const environments = new Map<string, { secrets: Set<string>; variables: Set<string> } | null>();
  for (const setting of settings) {
    const name = setting.environment;
    if (name === null || environments.has(name)) continue;
    const exists = await api.request("GET", `${base}/environments/${name}`);
    if (exists.status === 404) {
      environments.set(name, null);
      continue;
    }
    environments.set(name, {
      secrets: await list(api, `${base}/environments/${name}/secrets`, "secrets"),
      variables: await list(api, `${base}/environments/${name}/variables`, "variables"),
    });
  }

  const status = new Map<Setting, Status>();
  for (const setting of settings) {
    const atRepo = (setting.kind === "secret" ? repoSecrets : repoVariables).has(setting.name);
    if (setting.environment === null) {
      status.set(setting, atRepo ? "set" : "missing");
      continue;
    }
    const environment = environments.get(setting.environment);
    if (environment === null || environment === undefined) {
      status.set(setting, atRepo ? "set-in-repo" : "no-environment");
      continue;
    }
    const here = (setting.kind === "secret" ? environment.secrets : environment.variables).has(
      setting.name,
    );
    status.set(setting, here ? "set" : atRepo ? "set-in-repo" : "missing");
  }
  return status;
}

/** Store a value. Throws with gh's message when it fails. */
export type Writer = (repo: string, setting: Setting, value: string) => Promise<void>;

/** Sets values with `gh secret set` / `gh variable set`, passing the value on stdin only. */
export function ghWriter(cwd: string): Writer {
  return async (repo, setting, value) => {
    const args = [
      setting.kind === "secret" ? "secret" : "variable",
      "set",
      setting.name,
      "--repo",
      repo,
      ...(setting.environment === null ? [] : ["--env", setting.environment]),
    ];
    const result = await runGh(args, cwd, value);
    if (result.missing) throw new GitHubError(GH_MISSING);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `gh ${args.slice(0, 2).join(" ")} failed`);
    }
  };
}

/** Local tools `hollow secrets` uses for host keys. Tests swap in fakes. */
export interface HostKeyTools {
  /** `ssh-keyscan` output for the server, or null when it cannot be scanned. */
  scan(host: string, port: number): Promise<string | null>;
  /** One fingerprint line per key, from `ssh-keygen -lf -`. */
  fingerprints(keys: string): Promise<string>;
}

function capture(
  file: string,
  args: string[],
  input = "",
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { shell: false, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.on("error", () => resolve({ code: null, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export const systemHostKeyTools: HostKeyTools = {
  async scan(host, port) {
    const result = await capture("ssh-keyscan", ["-T", "10", "-p", String(port), host]);
    const keys = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"))
      .join("\n");
    return result.code === 0 && keys !== "" ? `${keys}\n` : null;
  },
  async fingerprints(keys) {
    const result = await capture("ssh-keygen", ["-l", "-f", "-"], keys);
    return result.stdout.trim();
  },
};
