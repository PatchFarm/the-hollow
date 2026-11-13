import { describe, expect, it } from "vitest";
import { detectProject } from "../src/detect/index.js";
import { drizzleDialect, prismaProvider } from "../src/detect/node.js";
import { requirementName } from "../src/detect/python.js";
import { fixture, tempProject, values } from "./helpers.js";

describe("sample apps", () => {
  it("node-next-prisma", () => {
    const d = detectProject(fixture("node-next-prisma"));
    expect(d.language).toBe("node");
    expect(d.typescript).toBe(true);
    expect(d.packageManager).toEqual({ value: "npm", source: "package-lock.json" });
    expect(d.runtimeVersion).toEqual({ value: "22", source: ".nvmrc" });
    expect(values(d.frameworks)).toEqual(["next"]);
    expect(values(d.quality.linters)).toEqual(["eslint"]);
    expect(d.quality.linters[0]?.source).toBe("eslint.config.mjs");
    expect(values(d.quality.typeCheckers)).toEqual(["tsc"]);
    expect(values(d.tests.runners)).toEqual(["vitest"]);
    expect(values(d.tests.e2e)).toEqual(["playwright"]);
    expect(d.database.migrationTool).toEqual({ value: "prisma", source: "prisma/schema.prisma" });
    expect(values(d.database.engines)).toEqual(["postgres"]);
    expect(d.scripts).toEqual({ build: true, test: true, lint: true, typecheck: true });
    expect(d.deployHints).toEqual([]);
    expect(d.warnings).toEqual([]);
  });

  it("node-vite-static", () => {
    const d = detectProject(fixture("node-vite-static"));
    expect(d.language).toBe("node");
    expect(d.packageManager).toEqual({ value: "pnpm", source: "package.json#packageManager" });
    expect(values(d.frameworks)).toEqual(["vite"]);
    expect(values(d.quality.formatters)).toEqual(["prettier"]);
    expect(d.quality.linters).toEqual([]);
    expect(d.tests.runners).toEqual([]);
    expect(d.scripts.test).toBe(false);
    expect(d.warnings).toEqual([expect.stringContaining("No test runner found")]);
  });

  it("node-hono-workers", () => {
    const d = detectProject(fixture("node-hono-workers"));
    expect(d.packageManager).toEqual({ value: "yarn", source: "yarn.lock" });
    expect(d.runtimeVersion).toEqual({ value: ">=22", source: "package.json#engines.node" });
    expect(values(d.frameworks)).toEqual(["hono"]);
    expect(values(d.quality.linters)).toEqual(["biome"]);
    expect(values(d.quality.formatters)).toEqual(["biome"]);
    expect(d.deployHints).toEqual([{ value: "cloudflare-workers", source: "wrangler.toml" }]);
    expect(d.database.migrationTool).toBeNull();
  });

  it("python-fastapi", () => {
    const d = detectProject(fixture("python-fastapi"));
    expect(d.language).toBe("python");
    expect(d.packageManager).toEqual({ value: "uv", source: "uv.lock" });
    expect(d.runtimeVersion).toEqual({
      value: ">=3.12",
      source: "pyproject.toml#project.requires-python",
    });
    expect(values(d.frameworks)).toEqual(["fastapi"]);
    expect(values(d.quality.linters)).toEqual(["ruff"]);
    expect(values(d.quality.typeCheckers)).toEqual(["mypy"]);
    expect(values(d.tests.runners)).toEqual(["pytest"]);
    expect(d.database.migrationTool).toEqual({ value: "alembic", source: "alembic.ini" });
    expect(values(d.database.engines)).toEqual(["postgres"]);
    expect(d.container).toEqual({ dockerfile: "Dockerfile", compose: "compose.yaml" });
    expect(values(d.deployHints)).toEqual(["docker"]);
    expect(d.warnings).toEqual([]);
  });

  it("python-django", () => {
    const d = detectProject(fixture("python-django"));
    expect(d.packageManager).toEqual({ value: "pip", source: "requirements.txt" });
    expect(d.runtimeVersion).toEqual({ value: "3.13", source: ".python-version" });
    expect(values(d.frameworks)).toEqual(["django"]);
    expect(values(d.quality.linters)).toEqual(["ruff"]);
    expect(d.tests.runners).toEqual([{ value: "pytest", source: "pytest.ini" }]);
    expect(d.database.migrationTool).toEqual({ value: "django", source: "manage.py" });
    expect(values(d.database.engines)).toEqual(["postgres"]);
    expect(d.warnings).toEqual([]);
  });

  it("empty folder", () => {
    const d = detectProject(fixture("empty"));
    expect(d.language).toBeNull();
    expect(d.packageManager).toBeNull();
    expect(d.warnings).toEqual([expect.stringContaining("supports Node/TypeScript and Python")]);
  });
});

describe("node edge cases", () => {
  it("warns when there is no lockfile and defaults to npm", () => {
    const d = detectProject(tempProject({ "package.json": '{"devDependencies":{"jest":"30"}}' }));
    expect(d.packageManager).toEqual({ value: "npm", source: "default (no lockfile found)" });
    expect(d.warnings).toEqual([expect.stringContaining("No lockfile found")]);
  });

  it("warns about lockfiles from several package managers", () => {
    const d = detectProject(
      tempProject({ "package.json": "{}", "pnpm-lock.yaml": "", "package-lock.json": "{}" }),
    );
    expect(d.packageManager?.value).toBe("pnpm");
    expect(d.warnings.join("\n")).toContain("more than one package manager");
  });

  it("does not crash on an invalid package.json", () => {
    const d = detectProject(tempProject({ "package.json": "{ not json" }));
    expect(d.language).toBe("node");
    expect(d.warnings).toContain("package.json exists but could not be parsed as a JSON object.");
  });

  it("ignores non-string dependency values", () => {
    const d = detectProject(
      tempProject({
        "package.json": JSON.stringify({ dependencies: { next: 16, vite: "8" }, scripts: [] }),
        "package-lock.json": "{}",
      }),
    );
    expect(values(d.frameworks)).toEqual(["vite"]);
  });

  it("does not count the npm init test stub as a test script", () => {
    const d = detectProject(
      tempProject({
        "package.json": JSON.stringify({
          scripts: { test: 'echo "Error: no test specified" && exit 1' },
        }),
      }),
    );
    expect(d.scripts.test).toBe(false);
  });

  it("detects drizzle and Cloudflare Pages", () => {
    const d = detectProject(
      tempProject({
        "package.json": JSON.stringify({ devDependencies: { "drizzle-kit": "0.31" } }),
        "package-lock.json": "{}",
        "drizzle.config.ts": 'export default defineConfig({ dialect: "mysql" });',
        "wrangler.toml": 'name = "site"\npages_build_output_dir = "dist"\n',
      }),
    );
    expect(d.database.migrationTool).toEqual({ value: "drizzle", source: "drizzle.config.ts" });
    expect(values(d.database.engines)).toEqual(["mysql"]);
    expect(values(d.deployHints)).toEqual(["cloudflare-pages"]);
  });

  it("prefers package.json when Python files are also present, and says so", () => {
    const d = detectProject(tempProject({ "package.json": "{}", "requirements.txt": "flask\n" }));
    expect(d.language).toBe("node");
    expect(d.warnings.join("\n")).toContain("Found both package.json and requirements.txt");
  });
});

describe("python edge cases", () => {
  it("detects poetry projects and their python constraint", () => {
    const d = detectProject(
      tempProject({
        "pyproject.toml": [
          "[tool.poetry]",
          'name = "x"',
          "[tool.poetry.dependencies]",
          'python = "^3.12"',
          'Flask = "^3.1"',
          "[tool.poetry.group.dev.dependencies]",
          'pytest = "^9"',
        ].join("\n"),
      }),
    );
    expect(d.packageManager).toEqual({ value: "poetry", source: "pyproject.toml#tool.poetry" });
    expect(d.runtimeVersion?.value).toBe("^3.12");
    expect(values(d.frameworks)).toEqual(["flask"]);
    expect(values(d.tests.runners)).toEqual(["pytest"]);
  });

  it("warns when pyproject has no lockfile", () => {
    const d = detectProject(
      tempProject({ "pyproject.toml": '[project]\nname = "x"\ndependencies = ["fastapi"]\n' }),
    );
    expect(d.packageManager?.value).toBe("pip");
    expect(d.warnings.join("\n")).toContain("No uv.lock, poetry.lock or requirements.txt");
  });

  it("does not crash on invalid TOML", () => {
    const d = detectProject(tempProject({ "pyproject.toml": "[project\nname=" }));
    expect(d.language).toBe("python");
    expect(d.warnings).toContain("pyproject.toml exists but is not valid TOML.");
  });

  it("flags Pipenv as unsupported", () => {
    const d = detectProject(tempProject({ Pipfile: "[packages]\n" }));
    expect(d.warnings.join("\n")).toContain("Pipenv is not supported");
  });
});

describe("parsers", () => {
  it.each([
    ["Django==6.1", "django"],
    ["psycopg[binary]>=3.3", "psycopg"],
    ["uvicorn[standard] ; python_version >= '3.12'", "uvicorn"],
    ["Flask_SQLAlchemy", "flask-sqlalchemy"],
    ["zope.interface", "zope-interface"],
    ["  # comment", null],
    ["-r requirements.txt", null],
    ["--index-url https://example.com", null],
    ["", null],
  ])("requirementName(%j) is %j", (spec, expected) => {
    expect(requirementName(spec)).toBe(expected);
  });

  it("reads the Prisma datasource provider, not the generator's", () => {
    const schema =
      'generator client {\n provider = "prisma-client"\n}\ndatasource db {\n provider = "sqlite"\n}';
    expect(prismaProvider(schema)).toBe("sqlite");
    expect(prismaProvider('datasource db {\n provider = "mongodb"\n}')).toBeNull();
  });

  it("reads the drizzle dialect", () => {
    expect(drizzleDialect("dialect: 'postgresql',")).toBe("postgres");
    expect(drizzleDialect("export default {}")).toBeNull();
  });
});
