import { parse as parseToml } from "smol-toml";
import type { ProjectFiles } from "../util/project-files.js";
import { isRecord } from "./common.js";
import { addFinding, type DatabaseEngine, type Detection } from "./types.js";

const FRAMEWORKS = ["django", "fastapi", "flask", "starlette", "litestar"] as const;

const DB_DRIVERS: ReadonlyArray<readonly [string, DatabaseEngine]> = [
  ["psycopg", "postgres"],
  ["psycopg2", "postgres"],
  ["psycopg2-binary", "postgres"],
  ["asyncpg", "postgres"],
  ["mysqlclient", "mysql"],
  ["pymysql", "mysql"],
  ["aiomysql", "mysql"],
  ["asyncmy", "mysql"],
  ["aiosqlite", "sqlite"],
  ["redis", "redis"],
];

const REQUIREMENTS_FILES = [
  "requirements.txt",
  "requirements-dev.txt",
  "requirements/base.txt",
  "requirements/dev.txt",
  "dev-requirements.txt",
];

export function detectPython(files: ProjectFiles, result: Detection): void {
  const pyproject = readPyproject(files, result);
  const deps = collectDependencies(files, pyproject);
  const has = (name: string) => deps.has(name);
  const tool = isRecord(pyproject?.tool) ? pyproject.tool : {};
  const depSource = pyproject === null ? "requirements.txt" : "pyproject.toml";

  // Package manager: a lockfile is the strongest signal, then poetry's own table, then pip.
  if (files.exists("uv.lock")) {
    result.packageManager = { value: "uv", source: "uv.lock" };
  } else if (files.exists("poetry.lock")) {
    result.packageManager = { value: "poetry", source: "poetry.lock" };
  } else if (isRecord(tool.poetry)) {
    result.packageManager = { value: "poetry", source: "pyproject.toml#tool.poetry" };
  } else {
    const where =
      files.firstExisting(["requirements.txt", "pyproject.toml", "setup.py"]) ?? "default";
    result.packageManager = { value: "pip", source: where };
    if (!files.exists("requirements.txt") && pyproject !== null) {
      result.warnings.push(
        "No uv.lock, poetry.lock or requirements.txt found. CI installs need pinned dependencies, so add a lockfile before the pipeline runs.",
      );
    }
  }
  if (files.exists("Pipfile")) {
    result.warnings.push(
      "Pipenv is not supported yet. Use uv, poetry or pip with a requirements file.",
    );
  }

  detectRuntime(files, pyproject, result);

  for (const framework of FRAMEWORKS) {
    if (has(framework)) addFinding(result.frameworks, framework, depSource);
  }

  // Quality tools: config tables count as much as the dependency itself.
  if (
    isRecord(tool.ruff) ||
    files.exists("ruff.toml") ||
    files.exists(".ruff.toml") ||
    has("ruff")
  ) {
    const where = files.firstExisting(["ruff.toml", ".ruff.toml"]) ?? depSource;
    addFinding(result.quality.linters, "ruff", where);
    addFinding(result.quality.formatters, "ruff", where);
  }
  if (isRecord(tool.black) || has("black"))
    addFinding(result.quality.formatters, "black", depSource);
  if (files.exists(".flake8") || has("flake8")) {
    addFinding(result.quality.linters, "flake8", files.exists(".flake8") ? ".flake8" : depSource);
  }
  if (isRecord(tool.mypy) || files.exists("mypy.ini") || has("mypy")) {
    addFinding(
      result.quality.typeCheckers,
      "mypy",
      files.exists("mypy.ini") ? "mypy.ini" : depSource,
    );
  }
  if (isRecord(tool.pyright) || files.exists("pyrightconfig.json") || has("pyright")) {
    const where = files.exists("pyrightconfig.json") ? "pyrightconfig.json" : depSource;
    addFinding(result.quality.typeCheckers, "pyright", where);
  }

  const pytestConfig = files.firstExisting(["pytest.ini", "conftest.py", "tests/conftest.py"]);
  if (pytestConfig !== null) addFinding(result.tests.runners, "pytest", pytestConfig);
  else if (has("pytest") || isRecord(isRecord(tool.pytest) ? tool.pytest.ini_options : undefined)) {
    addFinding(result.tests.runners, "pytest", depSource);
  }
  if (has("pytest-playwright") || has("playwright"))
    addFinding(result.tests.e2e, "playwright", depSource);

  // Migrations: Django ships its own; otherwise Alembic.
  if (has("django") && files.exists("manage.py")) {
    result.database.migrationTool = { value: "django", source: "manage.py" };
  } else if (files.exists("alembic.ini")) {
    result.database.migrationTool = { value: "alembic", source: "alembic.ini" };
  } else if (has("alembic")) {
    result.database.migrationTool = { value: "alembic", source: depSource };
  }
  for (const [dep, engine] of DB_DRIVERS) {
    if (has(dep)) addFinding(result.database.engines, engine, depSource);
  }
}

function readPyproject(files: ProjectFiles, result: Detection): Record<string, unknown> | null {
  const text = files.readText("pyproject.toml");
  if (text === null) return null;
  try {
    const parsed = parseToml(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    result.warnings.push("pyproject.toml exists but is not valid TOML.");
    return null;
  }
}

function detectRuntime(
  files: ProjectFiles,
  pyproject: Record<string, unknown> | null,
  result: Detection,
): void {
  const pinned = files.readText(".python-version")?.split(/\r?\n/)[0]?.trim();
  if (pinned) {
    result.runtimeVersion = { value: pinned, source: ".python-version" };
    return;
  }
  const project = isRecord(pyproject?.project) ? pyproject.project : {};
  if (typeof project["requires-python"] === "string") {
    result.runtimeVersion = {
      value: project["requires-python"],
      source: "pyproject.toml#project.requires-python",
    };
    return;
  }
  const poetry = poetryTable(pyproject);
  const poetryDeps = isRecord(poetry.dependencies) ? poetry.dependencies : {};
  if (typeof poetryDeps.python === "string") {
    result.runtimeVersion = {
      value: poetryDeps.python,
      source: "pyproject.toml#tool.poetry.dependencies.python",
    };
  }
}

/**
 * Every dependency name the project declares, normalized per PEP 503 (lowercase, runs of `-_.`
 * collapsed to `-`). Covers PEP 621, PEP 735 dependency groups, Poetry, uv and requirements files.
 */
export function collectDependencies(
  files: ProjectFiles,
  pyproject: Record<string, unknown> | null,
): Set<string> {
  const names = new Set<string>();
  const addSpec = (spec: unknown) => {
    if (typeof spec !== "string") return;
    const name = requirementName(spec);
    if (name !== null) names.add(name);
  };
  const addSpecs = (list: unknown) => {
    if (Array.isArray(list)) list.forEach(addSpec);
  };

  const project = isRecord(pyproject?.project) ? pyproject.project : {};
  addSpecs(project.dependencies);
  if (isRecord(project["optional-dependencies"])) {
    Object.values(project["optional-dependencies"]).forEach(addSpecs);
  }
  if (isRecord(pyproject?.["dependency-groups"])) {
    Object.values(pyproject["dependency-groups"]).forEach(addSpecs);
  }

  const tool = isRecord(pyproject?.tool) ? pyproject.tool : {};
  const uv = isRecord(tool.uv) ? tool.uv : {};
  addSpecs(uv["dev-dependencies"]);

  const poetry = poetryTable(pyproject);
  const addKeys = (table: unknown) => {
    if (!isRecord(table)) return;
    for (const key of Object.keys(table)) {
      if (key !== "python") names.add(normalizeName(key));
    }
  };
  addKeys(poetry.dependencies);
  addKeys(poetry["dev-dependencies"]);
  if (isRecord(poetry.group)) {
    for (const group of Object.values(poetry.group)) {
      if (isRecord(group)) addKeys(group.dependencies);
    }
  }

  for (const file of REQUIREMENTS_FILES) {
    const text = files.readText(file);
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) addSpec(line);
  }
  return names;
}

function poetryTable(pyproject: Record<string, unknown> | null): Record<string, unknown> {
  const tool = isRecord(pyproject?.tool) ? pyproject.tool : {};
  return isRecord(tool.poetry) ? tool.poetry : {};
}

/** The distribution name at the start of a PEP 508 string or requirements line, or `null`. */
export function requirementName(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("-")) return null;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(trimmed);
  return match?.[1] === undefined ? null : normalizeName(match[1]);
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}
