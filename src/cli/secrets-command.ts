import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { GitHubError } from "../github/api.js";
import { label, type Setting, settingsFor } from "../secrets/catalog.js";
import { type HostKeyTools, readStatus, type Status, type Writer } from "../secrets/github.js";
import type { Ask } from "./interview.js";
import { loadPlan } from "./load-plan.js";
import type { Connect } from "./protect-command.js";

export interface SecretsOptions {
  dir: string;
  repo?: string | undefined;
  /** `hollow secrets set NAME [--env ENV]`: set one value instead of listing. */
  set?: { name: string; environment?: string | undefined } | undefined;
  /** Visible prompt, for variables and yes/no questions. Absent without a terminal. */
  ask?: Ask | undefined;
  /** Hidden prompt, for secret values. Absent without a terminal. */
  askSecret?: Ask | undefined;
  /** Everything piped to stdin, for `set` without a terminal. */
  readStdin?: (() => Promise<string>) | undefined;
  connect: Connect;
  writer: (cwd: string) => Writer;
  hostKeys: HostKeyTools;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const STATUS_LABEL: Record<Status, string> = {
  set: "set",
  "set-in-repo": "set (repo)",
  missing: "missing",
  "no-environment": "no env",
};

/**
 * `hollow secrets`: list every secret and variable the pipeline reads, per environment, as set or
 * missing (names only, never values), then offer to set the missing ones through gh.
 */
export async function secrets(options: SecretsOptions): Promise<number> {
  const loaded = loadPlan(options.dir, options.stderr);
  if (loaded === null) return 1;
  const settings = settingsFor(loaded.plan);
  if (settings.length === 0) {
    options.stdout(
      "This pipeline reads no secrets or variables of its own: it only uses the workflow's GitHub token.\n",
    );
    return 0;
  }

  try {
    const { api, repo } = await options.connect(loaded.detection.root, options.repo);
    const writer = options.writer(loaded.detection.root);
    if (options.set !== undefined) return await setOne(options, settings, repo, writer);

    let status = await readStatus(api, repo, settings);
    options.stdout(formatStatus(repo, settings, status));
    const missing = settings.filter((setting) => status.get(setting) === "missing");
    const noEnvironment = settings.filter((setting) => status.get(setting) === "no-environment");
    if (noEnvironment.length > 0) {
      options.stdout(
        `\nThe ${[...new Set(noEnvironment.map((s) => s.environment))].join(", ")} environment${noEnvironment.length === 1 ? " does" : "s do"} not exist yet. Run \`hollow protect\` to create ${noEnvironment.length === 1 ? "it" : "them"}, then run this again.\n`,
      );
    }
    if (missing.length === 0) return finish(settings, status, options);

    if (options.ask === undefined) {
      options.stdout("\nTo set the missing ones from a script, pipe each value in:\n");
      for (const setting of missing) options.stdout(`  ${setCommand(setting)}\n`);
      return finish(settings, status, options);
    }
    const answer = await options.ask(`\nSet the missing ones now? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) return finish(settings, status, options);

    for (const setting of missing) {
      const value = await promptFor(setting, options);
      if (value === null) {
        options.stdout(`  skipped  ${label(setting)}\n`);
        continue;
      }
      await writer(repo, setting, value);
      options.stdout(`  set      ${label(setting)}\n`);
    }
    status = await readStatus(api, repo, settings);
    return finish(settings, status, options);
  } catch (error) {
    if (error instanceof GitHubError || error instanceof Error) {
      options.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function finish(
  settings: Setting[],
  status: Map<Setting, Status>,
  options: SecretsOptions,
): number {
  const missing = settings.filter(
    (setting) => setting.required && !["set", "set-in-repo"].includes(status.get(setting) ?? ""),
  );
  if (missing.length === 0) {
    options.stdout("\nEverything the pipeline needs is set.\n");
    return 0;
  }
  options.stdout(
    `\n${missing.length} required ${missing.length === 1 ? "value is" : "values are"} still missing: ${missing.map(label).join(", ")}.\n`,
  );
  return 1;
}

export function formatStatus(
  repo: string,
  settings: Setting[],
  status: Map<Setting, Status>,
): string {
  const width = Math.max(...settings.map((setting) => label(setting).length));
  const lines = [`Secrets and variables the pipeline reads, on ${repo}:`, ""];
  for (const setting of settings) {
    const state = STATUS_LABEL[status.get(setting) ?? "missing"];
    const shown = !setting.required && state === "missing" ? "optional" : state;
    lines.push(
      `  ${shown.padEnd(10)} ${label(setting).padEnd(width)}  ${setting.kind.padEnd(8)}  ${setting.purpose}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function setCommand(setting: Setting): string {
  const env = setting.environment === null ? "" : ` --env ${setting.environment}`;
  const source =
    setting.input === "file" || setting.input === "keyscan"
      ? setting.input === "keyscan"
        ? `${setting.hint} |`
        : "cat <file> |"
      : "printf '%s' \"$VALUE\" |";
  return `${source} npx the-hollow secrets set ${setting.name}${env}`;
}

/** Ask for one value the way that suits it. Returns null to skip. */
async function promptFor(setting: Setting, options: SecretsOptions): Promise<string | null> {
  const ask = options.ask as Ask;
  options.stdout(
    `\n  ${label(setting)}: ${setting.purpose}${setting.hint ? `\n  (${setting.hint})` : ""}\n`,
  );
  switch (setting.input) {
    case "hidden": {
      const read = options.askSecret ?? ask;
      const value = (await read("  Value, not shown (Enter to skip): ")).trim();
      return value === "" ? null : value;
    }
    case "visible": {
      const value = (await ask("  Value (Enter to skip): ")).trim();
      return value === "" ? null : value;
    }
    case "file":
      return readValueFile(await ask("  Path to the file (Enter to skip): "), setting, options);
    case "keyscan": {
      const server = setting.server;
      const keys =
        server === undefined ? null : await options.hostKeys.scan(server.host, server.port);
      if (keys === null) {
        options.stdout(
          "  Could not scan the server from here. Save the ssh-keyscan output to a file instead.\n",
        );
        return readValueFile(await ask("  Path to the file (Enter to skip): "), setting, options);
      }
      const prints = await options.hostKeys.fingerprints(keys);
      options.stdout(`  ${server?.host} presented these host keys:\n${indent(prints)}\n`);
      const ok = await ask(
        "  Do they match the server's own fingerprints (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub on the server)? [y/N] ",
      );
      return /^y(es)?$/i.test(ok.trim()) ? keys : null;
    }
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function readValueFile(input: string, setting: Setting, options: SecretsOptions): string | null {
  const answer = input.trim();
  if (answer === "") return null;
  const file = answer.startsWith("~/")
    ? path.join(homedir(), answer.slice(2))
    : path.resolve(answer);
  let value: string;
  try {
    value = readFileSync(file, "utf8");
  } catch {
    options.stdout(`  Could not read ${file}.\n`);
    return null;
  }
  if (value.trim() === "") {
    options.stdout(`  ${file} is empty.\n`);
    return null;
  }
  if (setting.kind === "secret" && setting.input === "file" && !value.includes("PRIVATE KEY")) {
    options.stdout(`  ${file} does not look like a private key, so it was not used.\n`);
    return null;
  }
  return value;
}

/** `hollow secrets set NAME [--env ENV]`: one value, from stdin or a prompt. */
async function setOne(
  options: SecretsOptions,
  settings: Setting[],
  repo: string,
  writer: Writer,
): Promise<number> {
  const request = options.set as { name: string; environment?: string | undefined };
  const matches = settings.filter((setting) => setting.name === request.name);
  if (matches.length === 0) {
    options.stderr(
      `${request.name} is not something this pipeline reads. It reads: ${[...new Set(settings.map((s) => s.name))].join(", ")}.\n`,
    );
    return 2;
  }
  const environments = matches.map((setting) => setting.environment);
  const setting = matches.find(
    (candidate) => candidate.environment === (request.environment ?? null),
  );
  if (setting === undefined) {
    options.stderr(
      environments[0] === null
        ? `${request.name} is set for the whole repo, so it takes no --env.\n`
        : `${request.name} is set per environment. Pass --env with one of: ${environments.join(", ")}.\n`,
    );
    return 2;
  }
  let value: string | null;
  if (options.readStdin !== undefined) {
    value = await options.readStdin();
    if (setting.input !== "file" && setting.input !== "keyscan") value = value.trim();
    if (value.trim() === "") {
      options.stderr("Nothing came in on stdin, so nothing was set.\n");
      return 1;
    }
  } else if (options.ask !== undefined) {
    value = await promptFor(setting, options);
    if (value === null) {
      options.stdout("Nothing was set.\n");
      return 1;
    }
  } else {
    options.stderr("Pipe the value in on stdin, or run this in a terminal to be asked for it.\n");
    return 1;
  }
  await writer(repo, setting, value);
  options.stdout(`Set ${label(setting)} on ${repo}.\n`);
  return 0;
}
