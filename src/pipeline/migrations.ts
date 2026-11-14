import path from "node:path";
import type { HollowConfig } from "../config/schema.js";
import type { Detection, Language, MigrationTool, PackageManager } from "../detect/types.js";
import type { ProjectFiles } from "../util/project-files.js";

/** How the project's migrations are applied and checked. */
export interface MigrationPlan {
  tool: MigrationTool;
  /** Applies every migration to DATABASE_URL. */
  apply: string;
  /** Django only: fails when models changed without a migration. */
  missingCheck: string | null;
  /** Patterns (fnmatch, relative to the repo root) for the safety check's migration files. */
  paths: string[];
  /** PR label that lets a destructive migration merge. */
  label: string;
  /** Whether CI has a database to apply them to. */
  appliesInCi: boolean;
  /** Extra env for applying them in CI (a throwaway SQLite file, for example). */
  ciEnv: Record<string, string>;
}

const NODE_EXEC: Record<string, string> = {
  npm: "npm exec --no -- ",
  pnpm: "pnpm exec ",
  yarn: "yarn run ",
  bun: "bun run ",
};
const PYTHON_PREFIX: Record<string, string> = {
  uv: "uv run --no-sync ",
  poetry: "poetry run ",
  pip: "",
};

interface MigrationInput {
  detection: Detection;
  files: ProjectFiles;
  config: HollowConfig | null;
  language: Language;
  packageManager: PackageManager;
  /** Engines CI starts a service container for. */
  serviceEngines: string[];
  notes: string[];
}

export function planMigrations(input: MigrationInput): MigrationPlan | null {
  const { detection, files, config, notes } = input;
  const setting = config?.database.migrations ?? "auto";
  if (setting === "none") return null;
  const tool = setting === "auto" ? (detection.database.migrationTool?.value ?? null) : setting;
  if (tool === null) return null;

  const run =
    input.language === "node"
      ? (NODE_EXEC[input.packageManager] ?? "npm exec --no -- ")
      : (PYTHON_PREFIX[input.packageManager] ?? "");
  const label = config?.database.destructiveChangeLabel ?? "allow-destructive-migration";

  let apply: string;
  let paths: string[];
  let missingCheck: string | null = null;
  switch (tool) {
    case "prisma": {
      const source = detection.database.migrationTool?.source ?? "";
      const dir = source.endsWith(".prisma") ? path.posix.dirname(source) : "prisma";
      apply = `${run}prisma migrate deploy`;
      paths = [`${dir === "." ? "" : `${dir}/`}migrations/*/migration.sql`];
      break;
    }
    case "drizzle": {
      apply = `${run}drizzle-kit migrate`;
      paths = [`${drizzleOut(files)}/*.sql`];
      break;
    }
    case "alembic": {
      apply = `${run}alembic upgrade head`;
      paths = [`${alembicLocation(files)}/versions/*.py`];
      break;
    }
    case "django": {
      apply = `${run}python manage.py migrate --noinput`;
      missingCheck = `${run}python manage.py makemigrations --check --dry-run`;
      paths = ["*migrations/[0-9]*.py"];
      break;
    }
  }

  const engines = detection.database.engines.map((engine) => engine.value);
  const server = input.serviceEngines.some((engine) => engine === "postgres" || engine === "mysql");
  const sqlite = engines.includes("sqlite");
  let appliesInCi = server || sqlite || tool === "django";
  const ciEnv: Record<string, string> = {};
  if (!server && sqlite && (tool === "prisma" || tool === "drizzle")) {
    ciEnv.DATABASE_URL = "file:./hollow-ci.db";
  }
  if (!appliesInCi) {
    notes.push(
      `CI cannot apply the ${tool} migrations: it found no database engine to start for them. Add the database driver to the project's dependencies, then run \`hollow upgrade\`.`,
    );
    appliesInCi = false;
  }
  return { tool, apply, missingCheck, paths, label, appliesInCi, ciEnv };
}

const SAFE_DIR = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function cleanDir(value: string | undefined, fallback: string): string {
  const dir = value?.replace(/^\.\//, "").replace(/\/+$/, "");
  return dir !== undefined && SAFE_DIR.test(dir) && !dir.split("/").includes("..") ? dir : fallback;
}

/** Drizzle writes migrations to `out` in drizzle.config (default `drizzle`). */
function drizzleOut(files: ProjectFiles): string {
  for (const name of [
    "drizzle.config.ts",
    "drizzle.config.js",
    "drizzle.config.mjs",
    "drizzle.config.json",
  ]) {
    const text = files.readText(name);
    if (text === null) continue;
    const match = /["']?out["']?\s*:\s*["']([^"']+)["']/.exec(text);
    return cleanDir(match?.[1], "drizzle");
  }
  return "drizzle";
}

/** Alembic's `script_location` in alembic.ini (default `migrations`). */
function alembicLocation(files: ProjectFiles): string {
  const text = files.readText("alembic.ini") ?? "";
  const match = /^\s*script_location\s*=\s*(.+?)\s*$/m.exec(text);
  return cleanDir(match?.[1]?.replace("%(here)s/", ""), "migrations");
}
