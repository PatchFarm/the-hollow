import { parse as parseToml } from "smol-toml";
import type { HollowConfig } from "../config/schema.js";
import { isRecord, parseJson } from "../detect/common.js";
import { REQUIREMENTS_FILES } from "../detect/python.js";
import type {
  DatabaseEngine,
  Detection,
  Language,
  NodePackageManager,
  PackageManager,
  PythonPackageManager,
} from "../detect/types.js";
import { TOOL_VERSIONS } from "../generate/pins.js";
import { ProjectFiles } from "../util/project-files.js";

/**
 * The typed pipeline model: what CI runs for this project, worked out from detection plus the
 * overrides in hollow.yml. Generators render it; `hollow plan` prints it. No I/O beyond reading
 * project files, and no guessing: every command traces back to a detected tool or script.
 */
export interface PipelinePlan {
  language: Language;
  packageManager: PackageManager;
  defaultBranch: string;
  toolchain: NodeToolchain | PythonToolchain;
  /** Shell lines that install dependencies from the lockfile. */
  install: string[];
  checks: Check[];
  services: Service[];
  /** Dockerfile path when the project has one: CI builds and scans the image. */
  dockerfile: string | null;
  security: {
    failOn: HollowConfig["security"]["failOn"];
    sast: HollowConfig["security"]["sast"];
    codeqlLanguages: string[];
  };
  /** Another git hook manager the project already uses (Husky, Lefthook), or null. */
  existingHooks: string | null;
  /** Things the developer should know before merging the generated pipeline. */
  notes: string[];
}

export type CheckId = "lint" | "format" | "typecheck" | "test" | "build";

export interface Check {
  id: CheckId;
  name: string;
  run: string;
  /** Why this check exists, for `hollow plan` and the PR summary. */
  reason: string;
  /** A passing stand-in for a missing check (only for tests, see docs/SCOPE.md). */
  placeholder?: true;
}

export interface NodeToolchain {
  kind: "node";
  packageManager: NodePackageManager;
  version: { input: "node-version" | "node-version-file"; value: string };
  /** setup-node `cache` value, or null when there is no lockfile to key the cache on. */
  cache: "npm" | "pnpm" | "yarn" | null;
  /** pnpm version for pnpm/action-setup, or null to read package.json#packageManager. */
  pnpmVersion: string | null;
  /** Yarn 2+ needs Corepack. */
  corepack: boolean;
  /** setup-bun input, when the package manager is bun. */
  bunVersion: { input: "bun-version" | "bun-version-file"; value: string } | null;
}

export interface PythonToolchain {
  kind: "python";
  packageManager: PythonPackageManager;
  /** null means uv picks the version from .python-version or requires-python. */
  version: { input: "python-version" | "python-version-file"; value: string } | null;
  /** setup-python `cache` value, when setup-python is used. */
  cache: "pip" | "poetry" | null;
  /** Files setup-python hashes for its pip cache. */
  cacheDependencyPath: string[];
}

export interface Service {
  engine: DatabaseEngine;
  env: Record<string, string>;
}

export type PlanResult = { status: "ok"; plan: PipelinePlan } | { status: "error"; error: string };

export function planPipeline(detection: Detection, config: HollowConfig | null): PlanResult {
  const files = new ProjectFiles(detection.root);
  const overrides = config?.project ?? {};
  const language = overrides.language ?? detection.language;
  if (language === null) {
    return {
      status: "error",
      error:
        "Could not tell what kind of project this is. The Hollow supports Node/TypeScript and Python.",
    };
  }
  if (detection.language !== null && language !== detection.language) {
    return {
      status: "error",
      error: `hollow.yml sets project.language to ${language}, but this looks like a ${detection.language} project.`,
    };
  }
  const packageManager = overrides.packageManager ?? detection.packageManager?.value;
  if (packageManager === undefined) {
    return { status: "error", error: "Could not work out the package manager." };
  }

  const notes = [...detection.warnings];
  const existingHooks = hookManager(files);
  if (existingHooks !== null) {
    notes.push(
      `This project already uses ${existingHooks} for git hooks, so The Hollow does not add a pre-commit config.`,
    );
  }
  const base = {
    language,
    packageManager,
    defaultBranch: overrides.defaultBranch ?? "main",
    services: services(detection),
    dockerfile: detection.container.dockerfile,
    existingHooks,
    security: {
      failOn: config?.security.failOn ?? "high",
      sast: config?.security.sast ?? "auto",
      codeqlLanguages: [language === "node" ? "javascript-typescript" : "python", "actions"],
    },
    notes,
  };

  if (language === "node") {
    if (!isNodePm(packageManager)) {
      return { status: "error", error: `${packageManager} is not a Node package manager.` };
    }
    return {
      status: "ok",
      plan: {
        ...base,
        ...planNode(detection, files, packageManager, overrides.runtimeVersion, notes),
      },
    };
  }
  if (isNodePm(packageManager)) {
    return { status: "error", error: `${packageManager} is not a Python package manager.` };
  }
  return {
    status: "ok",
    plan: {
      ...base,
      ...planPython(detection, files, packageManager, overrides.runtimeVersion, notes),
    },
  };
}

function isNodePm(pm: PackageManager): pm is NodePackageManager {
  return pm === "npm" || pm === "pnpm" || pm === "yarn" || pm === "bun";
}

type LanguagePart = Pick<PipelinePlan, "toolchain" | "install" | "checks">;

function planNode(
  detection: Detection,
  files: ProjectFiles,
  pm: NodePackageManager,
  runtimeOverride: string | undefined,
  notes: string[],
): LanguagePart {
  const manifest = readManifest(files);
  const pinned = packageManagerField(manifest);
  const hasLockfile = !(detection.packageManager?.source ?? "").startsWith("default");
  const yarnBerry =
    pm === "yarn" &&
    (files.exists(".yarnrc.yml") || (pinned?.name === "yarn" && !pinned.version.startsWith("1.")));

  let version: NodeToolchain["version"];
  const source = detection.runtimeVersion?.source;
  if (runtimeOverride !== undefined) version = { input: "node-version", value: runtimeOverride };
  else if (source === ".nvmrc" || source === ".node-version")
    version = { input: "node-version-file", value: source };
  else if (source?.startsWith("package.json"))
    version = { input: "node-version-file", value: "package.json" };
  else version = { input: "node-version", value: "lts/*" };

  let pnpmVersion: string | null = null;
  if (pm === "pnpm" && pinned?.name !== "pnpm") {
    pnpmVersion = TOOL_VERSIONS.pnpmMajor;
    notes.push(
      `package.json has no "packageManager" field, so CI uses pnpm ${TOOL_VERSIONS.pnpmMajor}. Pin your version there (for example "pnpm@${TOOL_VERSIONS.pnpmMajor}.0.0") so CI matches your lockfile.`,
    );
  }

  const toolchain: NodeToolchain = {
    kind: "node",
    packageManager: pm,
    version,
    cache: pm === "bun" || !hasLockfile ? null : pm,
    pnpmVersion,
    corepack: yarnBerry,
    bunVersion:
      pm === "bun"
        ? pinned?.name === "bun"
          ? { input: "bun-version-file", value: "package.json" }
          : { input: "bun-version", value: "latest" }
        : null,
  };

  const install: string[] = !hasLockfile
    ? ["npm install"]
    : {
        npm: ["npm ci"],
        pnpm: ["pnpm install --frozen-lockfile"],
        yarn: [yarnBerry ? "yarn install --immutable" : "yarn install --frozen-lockfile"],
        bun: ["bun install --frozen-lockfile"],
      }[pm];

  const script = (name: string) => `${pm === "npm" ? "npm run" : `${pm} run`} ${name}`;
  const exec = (command: string) =>
    ({
      npm: `npm exec --no -- ${command}`,
      pnpm: `pnpm exec ${command}`,
      yarn: `yarn run ${command}`,
      bun: `bun run ${command}`,
    })[pm];
  // Prisma's client is generated code; type checks, tests and builds need it.
  if (detection.database.migrationTool?.value === "prisma") install.push(exec("prisma generate"));
  const has = (list: { value: string }[], value: string) => list.some((f) => f.value === value);
  const { quality, tests, scripts } = detection;
  const checks: Check[] = [];

  if (scripts.lint) {
    checks.push({
      id: "lint",
      name: "Lint",
      run: script("lint"),
      reason: "package.json script `lint`",
    });
  } else if (has(quality.linters, "eslint")) {
    checks.push({
      id: "lint",
      name: "Lint",
      run: exec("eslint ."),
      reason: "ESLint is configured",
    });
  } else if (has(quality.linters, "biome")) {
    checks.push({
      id: "lint",
      name: "Lint and format check",
      run: exec("biome ci ."),
      reason: "Biome is configured",
    });
  }
  if (has(quality.formatters, "prettier")) {
    checks.push({
      id: "format",
      name: "Format check",
      run: exec("prettier --check ."),
      reason: "Prettier is configured",
    });
  }
  if (scripts.typecheck) {
    checks.push({
      id: "typecheck",
      name: "Type check",
      run: script("typecheck"),
      reason: "package.json script `typecheck`",
    });
  } else if (has(quality.typeCheckers, "tsc")) {
    checks.push({
      id: "typecheck",
      name: "Type check",
      run: exec("tsc --noEmit"),
      reason: "tsconfig.json found",
    });
  }
  if (scripts.test) {
    checks.push({
      id: "test",
      name: "Test",
      run: script("test"),
      reason: "package.json script `test`",
    });
  } else {
    const runner = tests.runners[0]?.value;
    const command = runner === "vitest" ? "vitest run" : runner;
    if (command !== undefined) {
      checks.push({
        id: "test",
        name: "Test",
        run: exec(command),
        reason: `${runner} is installed`,
      });
    } else {
      checks.push(placeholderTests(notes));
    }
  }
  if (scripts.build) {
    checks.push({
      id: "build",
      name: "Build",
      run: script("build"),
      reason: "package.json script `build`",
    });
  }
  return { toolchain, install, checks };
}

function planPython(
  detection: Detection,
  files: ProjectFiles,
  pm: PythonPackageManager,
  runtimeOverride: string | undefined,
  notes: string[],
): LanguagePart {
  const pyproject = readPyproject(files);
  const requirements = REQUIREMENTS_FILES.filter((file) => files.exists(file));

  let version: PythonToolchain["version"];
  const source = detection.runtimeVersion?.source;
  if (runtimeOverride !== undefined) version = { input: "python-version", value: runtimeOverride };
  else if (pm === "uv") version = null;
  else if (source === ".python-version") version = { input: "python-version-file", value: source };
  else if (source?.startsWith("pyproject.toml"))
    version = { input: "python-version-file", value: "pyproject.toml" };
  else version = { input: "python-version", value: "3.13" };

  let install: string[];
  let cacheDependencyPath: string[] = [];
  if (pm === "uv") {
    install = ["uv sync --locked"];
  } else if (pm === "poetry") {
    install = ["poetry check --lock", "poetry sync --no-interaction"];
  } else if (requirements.length > 0) {
    install = [
      "python -m pip install --upgrade pip",
      `python -m pip install ${requirements.map((file) => `-r ${file}`).join(" ")}`,
    ];
    cacheDependencyPath = requirements;
  } else {
    const project = isRecord(pyproject?.project) ? pyproject.project : {};
    const extras = isRecord(project["optional-dependencies"])
      ? project["optional-dependencies"]
      : {};
    const groups = isRecord(pyproject?.["dependency-groups"]) ? pyproject["dependency-groups"] : {};
    const target = "dev" in extras ? '-e ".[dev]"' : "-e .";
    install = [
      "python -m pip install --upgrade pip",
      `python -m pip install ${target}${"dev" in groups ? " --group dev" : ""}`,
    ];
    cacheDependencyPath = ["pyproject.toml"];
  }

  const toolchain: PythonToolchain = {
    kind: "python",
    packageManager: pm,
    version,
    cache: pm === "uv" ? null : pm === "poetry" ? "poetry" : "pip",
    cacheDependencyPath,
  };

  const prefix = { uv: "uv run --no-sync ", poetry: "poetry run ", pip: "" }[pm];
  const has = (list: { value: string }[], value: string) => list.some((f) => f.value === value);
  const { quality, tests } = detection;
  const checks: Check[] = [];

  if (has(quality.linters, "ruff")) {
    checks.push({
      id: "lint",
      name: "Lint",
      run: `${prefix}ruff check .`,
      reason: "Ruff is configured",
    });
  } else if (has(quality.linters, "flake8")) {
    checks.push({
      id: "lint",
      name: "Lint",
      run: `${prefix}flake8`,
      reason: "flake8 is configured",
    });
  }
  if (has(quality.formatters, "ruff")) {
    checks.push({
      id: "format",
      name: "Format check",
      run: `${prefix}ruff format --check .`,
      reason: "Ruff is configured",
    });
  } else if (has(quality.formatters, "black")) {
    checks.push({
      id: "format",
      name: "Format check",
      run: `${prefix}black --check .`,
      reason: "Black is configured",
    });
  }
  if (has(quality.typeCheckers, "mypy")) {
    checks.push({
      id: "typecheck",
      name: "Type check",
      run: `${prefix}mypy .`,
      reason: "mypy is configured",
    });
  } else if (has(quality.typeCheckers, "pyright")) {
    checks.push({
      id: "typecheck",
      name: "Type check",
      run: `${prefix}pyright`,
      reason: "Pyright is configured",
    });
  }
  if (has(tests.runners, "pytest")) {
    checks.push({
      id: "test",
      name: "Test",
      run: `${prefix}pytest`,
      reason: "pytest is configured",
    });
  } else {
    checks.push(placeholderTests(notes));
  }
  if (isRecord(pyproject?.["build-system"]) && pm !== "pip") {
    checks.push({
      id: "build",
      name: "Build",
      run: pm === "uv" ? "uv build" : "poetry build",
      reason: "pyproject.toml has a [build-system]",
    });
  }
  return { toolchain, install, checks };
}

function placeholderTests(notes: string[]): Check {
  // Replace detection's generic warning with one that says what CI will do about it.
  const generic = notes.findIndex((note) => note.startsWith("No test runner found"));
  if (generic !== -1) notes.splice(generic, 1);
  notes.push(
    "No test runner found. CI runs a passing placeholder that warns on every run. Add tests, then run `hollow upgrade`.",
  );
  return {
    id: "test",
    name: "Test (placeholder: no tests found)",
    run: 'echo "::warning title=No tests::The Hollow found no test runner in this project. Add tests, then run hollow upgrade."',
    reason: "no test runner found",
    placeholder: true,
  };
}

const SERVICE_ENV: Record<DatabaseEngine, Record<string, string> | null> = {
  postgres: { DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/app" },
  mysql: { DATABASE_URL: "mysql://root:root@localhost:3306/app" },
  redis: { REDIS_URL: "redis://localhost:6379" },
  sqlite: null,
};

function services(detection: Detection): Service[] {
  const result: Service[] = [];
  const taken = new Set<string>();
  for (const { value: engine } of detection.database.engines) {
    const env = SERVICE_ENV[engine];
    if (env === null) continue;
    // Only the first SQL engine gets DATABASE_URL.
    const free = Object.fromEntries(Object.entries(env).filter(([key]) => !taken.has(key)));
    for (const key of Object.keys(free)) taken.add(key);
    result.push({ engine, env: free });
  }
  return result;
}

function hookManager(files: ProjectFiles): string | null {
  if (files.exists(".husky")) return "Husky";
  if (files.firstExisting(["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"])) {
    return "Lefthook";
  }
  return null;
}

function readManifest(files: ProjectFiles): Record<string, unknown> {
  const text = files.readText("package.json");
  const parsed = text === null ? null : parseJson(text);
  return isRecord(parsed) ? parsed : {};
}

function packageManagerField(
  manifest: Record<string, unknown>,
): { name: string; version: string } | null {
  const field = manifest.packageManager;
  if (typeof field !== "string") return null;
  const match = /^([a-z]+)@(\d[^+\s]*)/.exec(field);
  return match?.[1] !== undefined && match[2] !== undefined
    ? { name: match[1], version: match[2] }
    : null;
}

function readPyproject(files: ProjectFiles): Record<string, unknown> | null {
  const text = files.readText("pyproject.toml");
  if (text === null) return null;
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
