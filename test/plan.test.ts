import { describe, expect, it } from "vitest";
import { hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { type PipelinePlan, planPipeline } from "../src/pipeline/plan.js";
import { fixture, tempProject } from "./helpers.js";

function plan(dir: string, project: Record<string, unknown> = {}): PipelinePlan {
  const config = hollowConfigSchema.parse({ version: 1, deploy: { target: "docker" }, project });
  const result = planPipeline(detectProject(dir), config);
  if (result.status !== "ok") throw new Error(result.error);
  return result.plan;
}

const runs = (p: PipelinePlan) => Object.fromEntries(p.checks.map((c) => [c.id, c.run]));

describe("pipeline plan: sample apps", () => {
  it("node-next-prisma uses the project's own scripts", () => {
    const p = plan(fixture("node-next-prisma"));
    expect(p.install).toEqual(["npm ci", "npm exec --no -- prisma generate"]);
    expect(runs(p)).toEqual({
      lint: "npm run lint",
      typecheck: "npm run typecheck",
      test: "npm run test",
      build: "npm run build",
    });
    expect(p.toolchain).toMatchObject({
      version: { input: "node-version-file", value: ".nvmrc" },
      cache: "npm",
    });
    expect(p.services.map((s) => s.engine)).toEqual(["postgres"]);
  });

  it("node-vite-static runs the tools it has and a placeholder for missing tests", () => {
    const p = plan(fixture("node-vite-static"));
    expect(p.install).toEqual(["pnpm install --frozen-lockfile"]);
    expect(p.toolchain).toMatchObject({ pnpmVersion: null, cache: "pnpm" });
    expect(runs(p)).toMatchObject({
      format: "pnpm exec prettier --check .",
      typecheck: "pnpm exec tsc --noEmit",
      build: "pnpm run build",
    });
    expect(p.checks.find((c) => c.id === "test")?.placeholder).toBe(true);
    expect(p.notes.join("\n")).toContain("No test runner found");
  });

  it("node-hono-workers reads the Node version from engines", () => {
    const p = plan(fixture("node-hono-workers"));
    expect(p.install).toEqual(["yarn install --frozen-lockfile"]);
    expect(p.toolchain).toMatchObject({
      version: { input: "node-version-file", value: "package.json" },
      corepack: false,
    });
  });

  it("python-fastapi runs everything through uv", () => {
    const p = plan(fixture("python-fastapi"));
    expect(p.install).toEqual(["uv sync --locked"]);
    expect(p.toolchain).toMatchObject({ kind: "python", version: null, cache: null });
    expect(runs(p)).toEqual({
      lint: "uv run --no-sync ruff check .",
      format: "uv run --no-sync ruff format --check .",
      typecheck: "uv run --no-sync mypy .",
      test: "uv run --no-sync pytest",
    });
    expect(p.dockerfile).toBe("Dockerfile");
  });

  it("python-django installs every requirements file", () => {
    const p = plan(fixture("python-django"));
    expect(p.install[1]).toBe("python -m pip install -r requirements.txt -r requirements-dev.txt");
    expect(p.toolchain).toMatchObject({
      version: { input: "python-version-file", value: ".python-version" },
      cache: "pip",
      cacheDependencyPath: ["requirements.txt", "requirements-dev.txt"],
    });
  });
});

describe("pipeline plan: edge cases", () => {
  it("uses Corepack and --immutable for Yarn 2+", () => {
    const p = plan(
      tempProject({
        "package.json": JSON.stringify({ packageManager: "yarn@4.12.0" }),
        "yarn.lock": "__metadata:\n",
      }),
    );
    expect(p.install).toEqual(["yarn install --immutable"]);
    expect(p.toolchain).toMatchObject({ corepack: true });
  });

  it("pins pnpm and says so when package.json does not", () => {
    const p = plan(tempProject({ "package.json": "{}", "pnpm-lock.yaml": "" }));
    expect(p.toolchain).toMatchObject({ pnpmVersion: "12" });
    expect(p.notes.join("\n")).toContain('no "packageManager" field');
  });

  it("uses bun's own installer and setup action", () => {
    const p = plan(
      tempProject({
        "package.json": JSON.stringify({ packageManager: "bun@1.3.2" }),
        "bun.lock": "",
      }),
    );
    expect(p.install).toEqual(["bun install --frozen-lockfile"]);
    expect(p.toolchain).toMatchObject({
      bunVersion: { input: "bun-version-file", value: "package.json" },
      cache: null,
    });
  });

  it("falls back to npm install without a lockfile and turns the cache off", () => {
    const p = plan(
      tempProject({ "package.json": JSON.stringify({ devDependencies: { jest: "30" } }) }),
    );
    expect(p.install).toEqual(["npm install"]);
    expect(p.toolchain).toMatchObject({ cache: null });
    expect(runs(p).test).toBe("npm exec --no -- jest");
  });

  it("uses Biome's ci command when there is no lint script", () => {
    const p = plan(
      tempProject({ "package.json": "{}", "package-lock.json": "{}", "biome.json": "{}" }),
    );
    expect(runs(p).lint).toBe("npm exec --no -- biome ci .");
  });

  it("checks the poetry lockfile before installing", () => {
    const p = plan(
      tempProject({
        "pyproject.toml":
          '[tool.poetry]\nname = "x"\n[tool.poetry.group.dev.dependencies]\npytest = "^9"\n',
        "poetry.lock": "",
      }),
    );
    expect(p.install).toEqual(["poetry check --lock", "poetry sync --no-interaction"]);
    expect(runs(p).test).toBe("poetry run pytest");
    expect(p.toolchain).toMatchObject({ cache: "poetry" });
  });

  it("installs a pip project with its dev group", () => {
    const p = plan(
      tempProject({
        "pyproject.toml":
          '[project]\nname = "x"\ndependencies = ["flask"]\n[dependency-groups]\ndev = ["pytest"]\n',
      }),
    );
    expect(p.install[1]).toBe("python -m pip install -e . --group dev");
    expect(p.toolchain).toMatchObject({ cacheDependencyPath: ["pyproject.toml"] });
  });

  it("respects project overrides in hollow.yml", () => {
    const p = plan(fixture("node-next-prisma"), { runtimeVersion: "24", defaultBranch: "trunk" });
    expect(p.toolchain).toMatchObject({ version: { input: "node-version", value: "24" } });
    expect(p.defaultBranch).toBe("trunk");
  });

  it("gives DATABASE_URL to the first SQL database only", () => {
    const p = plan(
      tempProject({
        "requirements.txt": "psycopg\npymysql\nredis\n",
      }),
    );
    expect(p.services).toEqual([
      { engine: "postgres", env: { DATABASE_URL: expect.stringContaining("postgresql://") } },
      { engine: "mysql", env: {} },
      { engine: "redis", env: { REDIS_URL: "redis://localhost:6379" } },
    ]);
  });

  it("refuses a language override that contradicts the project", () => {
    const config = hollowConfigSchema.parse({
      version: 1,
      deploy: { target: "docker" },
      project: { language: "python" },
    });
    const result = planPipeline(detectProject(fixture("node-next-prisma")), config);
    expect(result).toEqual({
      status: "error",
      error: expect.stringContaining("looks like a node project"),
    });
  });

  it("cannot plan an unknown project", () => {
    expect(planPipeline(detectProject(fixture("empty")), null).status).toBe("error");
  });
});
