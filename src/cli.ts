#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { run } from "./cli/main.js";

// Prompts only when a person is at the keyboard; piped or CI runs never block on input.
const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
let prompt: Interface | undefined;

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
        }
      : {}),
  });
} finally {
  prompt?.close();
}
