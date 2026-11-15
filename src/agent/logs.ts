/**
 * GitHub Actions job logs: every line starts with a timestamp, steps open with `##[group]`, and
 * errors are marked `##[error]`. These helpers turn a raw log into the part worth reading.
 */

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** Strip timestamps, colour codes and carriage-return progress lines. */
export function cleanLog(raw: string): string[] {
  return raw
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => {
      const bare = line.replace(TIMESTAMP, "").replace(ANSI, "");
      // Progress bars rewrite one line with \r; keep what it ended as.
      const last = bare.lastIndexOf("\r");
      return last === -1 ? bare : bare.slice(last + 1);
    });
}

/** The messages GitHub marked as errors, in order, without duplicates. */
export function errorLines(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const match = /##\[error\](.*)$/.exec(line);
    const message = match?.[1]?.trim();
    if (message && !found.includes(message)) found.push(message);
  }
  return found;
}

/**
 * The lines that explain a failure: everything from the start of the step that failed (the last
 * `##[group]Run` before the first error) up to that error, cut to `max` lines from the end.
 * Post-job cleanup after the error is left out.
 */
export function failureExcerpt(lines: readonly string[], max = 80): string[] {
  const firstError = lines.findIndex((line) => line.includes("##[error]"));
  const end = firstError === -1 ? lines.length : firstError + 1;
  let start = 0;
  for (let i = end - 1; i >= 0; i--) {
    if ((lines[i] as string).startsWith("##[group]Run ")) {
      start = i;
      break;
    }
  }
  const part = lines
    .slice(start, end)
    .filter((line) => !/^##\[(?:endgroup|group)\]/.test(line) || line.startsWith("##[group]Run "))
    .map((line) => line.replace(/^##\[group\]/, ""));
  return part.length > max ? part.slice(part.length - max) : part;
}
