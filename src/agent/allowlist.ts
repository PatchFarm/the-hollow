import { lstatSync } from "node:fs";
import path from "node:path";

/**
 * The only files the agent may change: the pipeline and deploy config (SECURITY.md, "Prompt
 * injection ... makes the agent write a malicious pipeline"). Application code is never edited;
 * the agent can only suggest changes to it in the pull request.
 */
const EDITABLE_DIRS = [".github/", "deploy/"];
const EDITABLE_FILES = new Set([
  "hollow.yml",
  ".pre-commit-config.yaml",
  "Dockerfile",
  ".dockerignore",
  "vercel.json",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
]);

export type EditCheck = { ok: true; path: string } | { ok: false; reason: string };

/** Human-readable list of what the agent may edit, for prompts and messages. */
export const EDITABLE_SUMMARY = `${EDITABLE_DIRS.join(", ")} and ${[...EDITABLE_FILES].join(", ")}`;

/**
 * Check a path the agent wants to write, relative to the repo root. The path must be a plain
 * relative path inside an allowed place, and nothing along it may be a symlink: a link inside
 * `.github/` could otherwise point at application code.
 */
export function checkEditablePath(root: string, requested: string): EditCheck {
  if (requested.length === 0 || requested.length > 300) {
    return { ok: false, reason: "The path is empty or too long." };
  }
  const control = [...requested].some((char) => (char.codePointAt(0) ?? 0) < 0x20);
  if (control || requested.includes("\\")) {
    return { ok: false, reason: "The path has a backslash or control character in it." };
  }
  if (requested.startsWith("/") || /^[A-Za-z]:/.test(requested)) {
    return { ok: false, reason: "Paths must be relative to the repo root." };
  }
  const segments = requested.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    return { ok: false, reason: "The path must not contain empty, `.` or `..` segments." };
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    return { ok: false, reason: "The agent never touches .git." };
  }
  const normalized = segments.join("/");
  const allowed =
    EDITABLE_FILES.has(normalized) ||
    EDITABLE_DIRS.some((dir) => normalized.startsWith(dir) && normalized.length > dir.length);
  if (!allowed) {
    return {
      ok: false,
      reason: `The agent may only edit ${EDITABLE_SUMMARY}. Suggest changes to ${normalized} in the pull request instead.`,
    };
  }
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return {
          ok: false,
          reason: `${normalized} goes through a symlink, so it could land anywhere.`,
        };
      }
    } catch {
      break; // The rest of the path does not exist yet: a new file, which is fine.
    }
  }
  return { ok: true, path: normalized };
}
