import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside } from "./project-files.js";

/**
 * Write one file inside a project root. Refuses absolute paths, `..` escapes, symlinked
 * directories that lead outside the root, and symlinks at the target itself, so a hostile repo
 * cannot redirect The Hollow's writes elsewhere on disk. Writes go to a temp file first and are
 * renamed into place, so a crash never leaves a half-written workflow.
 */
export function writeProjectFile(root: string, relativePath: string, content: string): void {
  const realRoot = realpathSync(root);
  if (path.isAbsolute(relativePath)) throw new Error(`Refusing absolute path: ${relativePath}`);
  const target = path.resolve(realRoot, relativePath);
  if (!isInside(realRoot, target) || target === realRoot) {
    throw new Error(`Refusing to write outside the project: ${relativePath}`);
  }

  // Walk the parent directories: existing ones must be real directories inside the root.
  const parts = path.relative(realRoot, path.dirname(target)).split(path.sep).filter(Boolean);
  let current = realRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch {
      mkdirSync(current);
      continue;
    }
    if (stats.isSymbolicLink()) {
      if (!isInside(realRoot, realpathSync(current))) {
        throw new Error(`Refusing to write through a symlink that leaves the project: ${current}`);
      }
    } else if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${current}`);
    }
  }

  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite a symlink: ${relativePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}
