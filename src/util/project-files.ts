import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Files larger than this are treated as unreadable. Detection only needs small config files. */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Read-only access to files inside one project directory.
 *
 * Every path is resolved against the project root, and anything that would land outside it
 * (`../` segments, absolute paths, or symlinks pointing elsewhere) is refused. Repo contents are
 * untrusted input, so nothing here throws on odd files: missing, oversized or unreadable files
 * come back as `null`.
 */
export class ProjectFiles {
  readonly root: string;

  constructor(root: string) {
    const resolved = path.resolve(root);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(resolved);
    } catch {
      throw new Error(`Project directory not found: ${resolved}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }
    this.root = realpathSync(resolved);
  }

  /**
   * Resolve a project-relative path to an absolute one, or return `null` if it escapes the root.
   * Symlinks are followed and must also stay inside the root.
   */
  resolve(relativePath: string): string | null {
    if (path.isAbsolute(relativePath)) return null;
    const candidate = path.resolve(this.root, relativePath);
    if (!isInside(this.root, candidate)) return null;
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      // Missing files are fine to report as missing, as long as the lexical path stays inside.
      return candidate;
    }
    return isInside(this.root, real) ? real : null;
  }

  exists(relativePath: string): boolean {
    const resolved = this.resolve(relativePath);
    if (resolved === null) return false;
    try {
      lstatSync(resolved);
      return true;
    } catch {
      return false;
    }
  }

  /** The first of `candidates` that exists, or `null`. */
  firstExisting(candidates: readonly string[]): string | null {
    return candidates.find((candidate) => this.exists(candidate)) ?? null;
  }

  readText(relativePath: string): string | null {
    const resolved = this.resolve(relativePath);
    if (resolved === null) return null;
    try {
      const stats = statSync(resolved);
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
      return readFileSync(resolved, "utf8");
    } catch {
      return null;
    }
  }

  /** Names of entries directly inside a project directory (not recursive). */
  list(relativeDir = "."): string[] {
    const resolved = this.resolve(relativeDir);
    if (resolved === null) return [];
    try {
      return readdirSync(resolved);
    } catch {
      return [];
    }
  }
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
