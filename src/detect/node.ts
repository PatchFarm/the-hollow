import type { ProjectFiles } from "../util/project-files.js";
import { isRecord, parseJson, stringRecord } from "./common.js";
import {
  addFinding,
  type DatabaseEngine,
  type Detection,
  type NodePackageManager,
} from "./types.js";

/** Dependency name -> framework label. Order matters: meta-frameworks before the tools they wrap. */
const FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ["next", "next"],
  ["nuxt", "nuxt"],
  ["@remix-run/node", "remix"],
  ["@react-router/dev", "react-router"],
  ["@sveltejs/kit", "sveltekit"],
  ["astro", "astro"],
  ["@nestjs/core", "nestjs"],
  ["hono", "hono"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["vite", "vite"],
];

const LOCKFILES: ReadonlyArray<readonly [string, NodePackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const DB_DRIVERS: ReadonlyArray<readonly [string, DatabaseEngine]> = [
  ["pg", "postgres"],
  ["postgres", "postgres"],
  ["@neondatabase/serverless", "postgres"],
  ["mysql2", "mysql"],
  ["better-sqlite3", "sqlite"],
  ["@libsql/client", "sqlite"],
  ["ioredis", "redis"],
  ["redis", "redis"],
];

const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintrc",
];
const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.mjs",
  ".prettierrc.cjs",
  "prettier.config.js",
  "prettier.config.mjs",
];
const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];
const DRIZZLE_CONFIGS = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs"];

export function detectNode(files: ProjectFiles, result: Detection): void {
  const text = files.readText("package.json");
  const manifest = text === null ? undefined : parseJson(text);
  if (!isRecord(manifest)) {
    result.warnings.push("package.json exists but could not be parsed as a JSON object.");
    return;
  }

  const deps: Record<string, string> = {
    ...stringRecord(manifest.dependencies),
    ...stringRecord(manifest.devDependencies),
    ...stringRecord(manifest.optionalDependencies),
  };
  const has = (name: string) => Object.hasOwn(deps, name);
  const source = "package.json";

  detectPackageManager(files, manifest, result);
  detectRuntime(files, manifest, result);

  for (const [dep, label] of FRAMEWORKS) {
    if (has(dep)) addFinding(result.frameworks, label, source);
  }

  result.typescript = has("typescript") || files.exists("tsconfig.json");

  const eslintConfig = files.firstExisting(ESLINT_CONFIGS);
  if (eslintConfig !== null) addFinding(result.quality.linters, "eslint", eslintConfig);
  else if (has("eslint")) addFinding(result.quality.linters, "eslint", source);

  const biomeConfig = files.firstExisting(BIOME_CONFIGS);
  if (biomeConfig !== null || has("@biomejs/biome")) {
    const where = biomeConfig ?? source;
    addFinding(result.quality.linters, "biome", where);
    addFinding(result.quality.formatters, "biome", where);
  }

  const prettierConfig = files.firstExisting(PRETTIER_CONFIGS);
  if (prettierConfig !== null) addFinding(result.quality.formatters, "prettier", prettierConfig);
  else if (has("prettier") || isRecord(manifest.prettier)) {
    addFinding(result.quality.formatters, "prettier", source);
  }

  if (result.typescript) {
    addFinding(
      result.quality.typeCheckers,
      "tsc",
      files.exists("tsconfig.json") ? "tsconfig.json" : source,
    );
  }

  for (const runner of ["vitest", "jest", "mocha"]) {
    if (has(runner)) addFinding(result.tests.runners, runner, source);
  }
  if (has("@playwright/test")) addFinding(result.tests.e2e, "playwright", source);
  if (has("cypress")) addFinding(result.tests.e2e, "cypress", source);

  detectDatabase(files, has, result);

  const scripts = stringRecord(manifest.scripts);
  result.scripts = {
    build: Object.hasOwn(scripts, "build"),
    test: Object.hasOwn(scripts, "test") && !isNpmInitTestStub(scripts.test),
    lint: Object.hasOwn(scripts, "lint"),
    typecheck: Object.hasOwn(scripts, "typecheck") || Object.hasOwn(scripts, "type-check"),
  };
}

function detectPackageManager(
  files: ProjectFiles,
  manifest: Record<string, unknown>,
  result: Detection,
): void {
  // Corepack's `packageManager` field is the most explicit signal ("pnpm@9.12.0").
  if (typeof manifest.packageManager === "string") {
    const name = manifest.packageManager.split("@")[0];
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
      result.packageManager = { value: name, source: "package.json#packageManager" };
      return;
    }
  }

  const found = LOCKFILES.filter(([file]) => files.exists(file));
  const first = found[0];
  if (first === undefined) {
    result.packageManager = { value: "npm", source: "default (no lockfile found)" };
    result.warnings.push(
      "No lockfile found. CI installs must come from a committed lockfile, so commit one before the pipeline runs.",
    );
    return;
  }
  result.packageManager = { value: first[1], source: first[0] };
  const managers = new Set(found.map(([, manager]) => manager));
  if (managers.size > 1) {
    result.warnings.push(
      `Lockfiles for more than one package manager found (${found.map(([file]) => file).join(", ")}). Using ${first[1]}; delete the others or set project.packageManager in hollow.yml.`,
    );
  }
}

function detectRuntime(
  files: ProjectFiles,
  manifest: Record<string, unknown>,
  result: Detection,
): void {
  for (const file of [".nvmrc", ".node-version"]) {
    const value = files.readText(file)?.trim().replace(/^v/, "");
    if (value) {
      result.runtimeVersion = { value, source: file };
      return;
    }
  }
  const engines = stringRecord(manifest.engines);
  if (engines.node) {
    result.runtimeVersion = { value: engines.node, source: "package.json#engines.node" };
  }
}

function detectDatabase(
  files: ProjectFiles,
  has: (name: string) => boolean,
  result: Detection,
): void {
  const prismaSchema = files.firstExisting(["prisma/schema.prisma", "schema.prisma"]);
  if (prismaSchema !== null || has("prisma") || has("@prisma/client")) {
    const where = prismaSchema ?? "package.json";
    result.database.migrationTool = { value: "prisma", source: where };
    const provider = prismaSchema === null ? null : prismaProvider(files.readText(prismaSchema));
    if (provider !== null) addFinding(result.database.engines, provider, where);
  } else {
    const drizzleConfig = files.firstExisting(DRIZZLE_CONFIGS);
    if (drizzleConfig !== null || has("drizzle-kit")) {
      const where = drizzleConfig ?? "package.json";
      result.database.migrationTool = { value: "drizzle", source: where };
      const dialect = drizzleConfig === null ? null : drizzleDialect(files.readText(drizzleConfig));
      if (dialect !== null) addFinding(result.database.engines, dialect, where);
    }
  }

  for (const [dep, engine] of DB_DRIVERS) {
    if (has(dep)) addFinding(result.database.engines, engine, "package.json");
  }
}

/** Read `provider = "postgresql"` from the datasource block of a Prisma schema. */
export function prismaProvider(schema: string | null): DatabaseEngine | null {
  if (schema === null) return null;
  const datasource = /datasource\s+\w+\s*\{([^}]*)\}/.exec(schema)?.[1];
  const provider =
    datasource === undefined ? undefined : /provider\s*=\s*"([^"]+)"/.exec(datasource)?.[1];
  return engineFromName(provider);
}

/** Read `dialect: "postgresql"` from a drizzle config file. */
export function drizzleDialect(config: string | null): DatabaseEngine | null {
  if (config === null) return null;
  return engineFromName(/dialect\s*:\s*["'`]([\w-]+)["'`]/.exec(config)?.[1]);
}

function engineFromName(name: string | undefined): DatabaseEngine | null {
  switch (name) {
    case "postgresql":
    case "postgres":
    case "cockroachdb":
      return "postgres";
    case "mysql":
    case "singlestore":
      return "mysql";
    case "sqlite":
    case "turso":
      return "sqlite";
    default:
      return null;
  }
}

/** `npm init` writes a test script that always fails; it is not a real test suite. */
function isNpmInitTestStub(script: string | undefined): boolean {
  return script !== undefined && /no test specified/.test(script);
}
