export type Language = "node" | "python";

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type PythonPackageManager = "pip" | "uv" | "poetry";
export type PackageManager = NodePackageManager | PythonPackageManager;

export type MigrationTool = "prisma" | "drizzle" | "alembic" | "django";
export type DatabaseEngine = "postgres" | "mysql" | "sqlite" | "redis";
export type DeployHint = "vercel" | "cloudflare-workers" | "cloudflare-pages" | "docker";

/** A detected value plus the file it came from, so every finding can be shown and checked. */
export interface Finding<T> {
  value: T;
  source: string;
}

export interface Detection {
  /** Absolute path of the project that was scanned. */
  root: string;
  language: Language | null;
  packageManager: Finding<PackageManager> | null;
  /** Runtime version constraint as written in the project (for example `22`, `>=3.12`). */
  runtimeVersion: Finding<string> | null;
  frameworks: Finding<string>[];
  typescript: boolean;
  quality: {
    linters: Finding<string>[];
    formatters: Finding<string>[];
    typeCheckers: Finding<string>[];
  };
  tests: {
    runners: Finding<string>[];
    e2e: Finding<string>[];
  };
  database: {
    migrationTool: Finding<MigrationTool> | null;
    engines: Finding<DatabaseEngine>[];
  };
  container: {
    dockerfile: string | null;
    compose: string | null;
  };
  deployHints: Finding<DeployHint>[];
  /** Node only: which of the common package.json scripts exist. */
  scripts: {
    build: boolean;
    test: boolean;
    lint: boolean;
    typecheck: boolean;
  };
  /** Things the developer should know about: ambiguities, missing lockfiles, unreadable files. */
  warnings: string[];
}

export function emptyDetection(root: string): Detection {
  return {
    root,
    language: null,
    packageManager: null,
    runtimeVersion: null,
    frameworks: [],
    typescript: false,
    quality: { linters: [], formatters: [], typeCheckers: [] },
    tests: { runners: [], e2e: [] },
    database: { migrationTool: null, engines: [] },
    container: { dockerfile: null, compose: null },
    deployHints: [],
    scripts: { build: false, test: false, lint: false, typecheck: false },
    warnings: [],
  };
}

/** Add a finding unless one with the same value is already there (first source wins). */
export function addFinding<T>(list: Finding<T>[], value: T, source: string): void {
  if (!list.some((finding) => finding.value === value)) {
    list.push({ value, source });
  }
}
