import { spawn } from "node:child_process";

export type Command =
  /** A shell line The Hollow built itself (from detected scripts and tools, never from repo text). */
  | { shell: string }
  /** A program run directly, with no shell. */
  | { file: string; args: string[] };

export interface ExecResult {
  /** Exit code, or null when the program could not be started. */
  code: number | null;
  /** Set when the program does not exist. */
  missing: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Run a command, streaming its output as it arrives. Never throws; stdin is closed. */
export function exec(command: Command, options: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child =
      "shell" in command
        ? spawn(command.shell, {
            cwd: options.cwd,
            env: options.env,
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(command.file, command.args, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });
    child.stdout.setEncoding("utf8").on("data", options.stdout);
    child.stderr.setEncoding("utf8").on("data", options.stderr);
    let settled = false;
    const done = (code: number | null, missing: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ code, missing, durationMs: Date.now() - started });
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") options.stderr(`${error.message}\n`);
      done(null, error.code === "ENOENT");
    });
    child.on("close", (code, signal) => done(code ?? (signal === null ? 1 : 128), false));
  });
}
