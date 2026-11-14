#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { run } from "./cli/main.js";

// Prompts only when a person is at the keyboard; piped or CI runs never block on input.
const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
let prompt: Interface | undefined;

/**
 * Read one line without echoing it, for secret values. Raw mode, so nothing typed or pasted is
 * shown or kept in terminal history; Ctrl+C stops the program.
 */
function askSecret(question: string): Promise<string> {
  prompt?.pause();
  process.stdout.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      prompt?.resume();
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Everything piped to stdin, for `hollow secrets set NAME < value`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    ...(interactive
      ? {
          ask: (question: string) => {
            prompt ??= createInterface({ input: process.stdin, output: process.stdout });
            return prompt.question(question);
          },
          askSecret,
        }
      : {}),
    ...(process.stdin.isTTY === true ? {} : { readStdin }),
  });
} finally {
  prompt?.close();
}
