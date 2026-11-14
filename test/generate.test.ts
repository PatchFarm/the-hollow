import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type HollowConfigInput, hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { generateFiles } from "../src/generate/index.js";
import { ACTIONS, BINARIES, HOOKS, IMAGES } from "../src/generate/pins.js";
import { PR_TITLE_WORKFLOW, TITLE_PATTERN } from "../src/generate/pr-title.js";
import { expr, isGenerated } from "../src/generate/render.js";
import { type PipelinePlan, planPipeline } from "../src/pipeline/plan.js";
import { fixture, tempProject } from "./helpers.js";

/** The deploy target each sample app uses in docs/SCOPE.md's definition of done. */
const SAMPLES: Record<string, HollowConfigInput["deploy"]> = {
  "node-next-prisma": { target: "vercel" },
  "node-vite-static": { target: "cloudflare-pages", projectName: "fixture-vite-static" },
  "node-hono-workers": { target: "cloudflare-workers" },
  "python-fastapi": { target: "docker" },
  "python-django": { target: "vps", host: "app.example.com" },
};

function planFor(name: string, extra: Partial<HollowConfigInput> = {}): PipelinePlan {
  const config = hollowConfigSchema.parse({ version: 1, deploy: SAMPLES[name], ...extra });
  const result = planPipeline(detectProject(fixture(name)), config);
  if (result.status !== "ok") throw new Error(result.error);
  return result.plan;
}

type Workflow = {
  on: unknown;
  permissions: unknown;
  jobs: Record<
    string,
    { permissions?: unknown; needs?: string[]; steps: Record<string, unknown>[] }
  >;
};

function fileFor(name: string, filePath: string): string {
  const file = generateFiles(planFor(name)).find((f) => f.path === filePath);
  if (file === undefined) throw new Error(`${filePath} not generated`);
  return file.content;
}

function workflow(plan: PipelinePlan): Workflow {
  const ci = generateFiles(plan).find((file) => file.workflow);
  if (ci === undefined) throw new Error("no workflow generated");
  return parse(ci.content) as Workflow;
}

describe("golden files", () => {
  // Reviewed output for every sample app. After an intended template change, run
  // `npx vitest run -u` and review the diff in test/golden/. CI lints these with actionlint.
  for (const name of Object.keys(SAMPLES)) {
    it(name, async () => {
      for (const file of generateFiles(planFor(name))) {
        await expect(file.content).toMatchFileSnapshot(
          path.join(import.meta.dirname, "golden", name, path.basename(file.path)),
        );
      }
    });
  }
});

describe("generated CI workflow", () => {
  const plans = Object.keys(SAMPLES).map((name) => [name, planFor(name)] as const);

  it.each(plans)("%s: pins every action to a full commit SHA", (_name, plan) => {
    for (const job of Object.values(workflow(plan).jobs)) {
      for (const step of job.steps) {
        if (typeof step.uses === "string")
          expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it.each(plans)(
    "%s: grants nothing by default and declares permissions per job",
    (_name, plan) => {
      const wf = workflow(plan);
      expect(wf.permissions).toEqual({});
      for (const job of Object.values(wf.jobs)) expect(job.permissions).toBeDefined();
    },
  );

  it.each(plans)("%s: never leaves the token in the checkout", (_name, plan) => {
    for (const job of Object.values(workflow(plan).jobs)) {
      for (const step of job.steps) {
        if (step.uses === ACTIONS.checkout.uses) {
          expect(step.with).toMatchObject({ "persist-credentials": false });
        }
      }
    }
  });

  it.each(plans)("%s: the CI passed job waits for every other job", (_name, plan) => {
    const { jobs } = workflow(plan);
    const others = Object.keys(jobs).filter((id) => id !== "ci-passed");
    expect(jobs["ci-passed"]?.needs).toEqual(others);
  });

  it("runs only on pull requests and pushes to the default branch", () => {
    expect(workflow(planFor("node-next-prisma")).on).toEqual({
      pull_request: null,
      push: { branches: ["main"] },
    });
    const custom = planFor("node-next-prisma", { project: { defaultBranch: "trunk" } });
    expect(workflow(custom).on).toMatchObject({ push: { branches: ["trunk"] } });
  });

  it("marks the files it owns as generated, not the developer's, and is deterministic", () => {
    const first = generateFiles(planFor("python-fastapi"));
    const second = generateFiles(planFor("python-fastapi"));
    expect(first).toEqual(second);
    for (const file of first) expect(isGenerated(file.content)).toBe(file.kind !== "scaffold");
  });

  it("checks every downloaded binary against its checksum", () => {
    const content = generateFiles(planFor("python-fastapi"))[0]?.content ?? "";
    for (const pin of Object.values(BINARIES)) {
      expect(content).toContain(pin.url);
      expect(content).toContain(pin.sha256);
    }
    expect(content.match(/sha256sum --check --strict/g)).toHaveLength(3);
  });

  it("adds a service container for each database and scans the image when there is a Dockerfile", () => {
    const fastapi = workflow(planFor("python-fastapi"));
    expect(fastapi.jobs.container).toBeDefined();
    expect(JSON.stringify(fastapi.jobs.build)).toContain(IMAGES.postgres.image);
    expect(workflow(planFor("node-vite-static")).jobs.container).toBeUndefined();
  });

  it("follows security.sast and security.failOn", () => {
    const semgrepOnly = workflow(
      planFor("node-hono-workers", { security: { sast: "semgrep", failOn: "medium" } }),
    );
    expect(semgrepOnly.jobs.codeql).toBeUndefined();
    const semgrep = semgrepOnly.jobs.semgrep;
    expect(semgrep).toBeDefined();
    expect(JSON.stringify(semgrep)).not.toContain("repository.private");
    expect(JSON.stringify(semgrep)).toContain("--severity ERROR --severity WARNING");
    expect(JSON.stringify(semgrepOnly.jobs.dependencies)).toContain('"MIN_CVSS":"4.0"');

    const codeqlOnly = workflow(planFor("node-hono-workers", { security: { sast: "codeql" } }));
    expect(codeqlOnly.jobs.semgrep).toBeUndefined();
    expect(JSON.stringify(codeqlOnly.jobs.codeql)).not.toContain("repository.private");
  });
});

describe("generated Dependabot config", () => {
  const dependabot = (name: string) =>
    parse(fileFor(name, ".github/dependabot.yml")) as {
      updates: {
        "package-ecosystem": string;
        "exclude-paths"?: string[];
        cooldown: unknown;
        "commit-message": unknown;
      }[];
    };

  it.each([
    ["node-next-prisma", ["npm", "github-actions"]],
    ["python-fastapi", ["uv", "github-actions", "docker"]],
    ["python-django", ["pip", "github-actions"]],
  ])("%s: covers %j", (name, ecosystems) => {
    expect(dependabot(name).updates.map((u) => u["package-ecosystem"])).toEqual(ecosystems);
  });

  it("waits 7 days and leaves the generated workflow to hollow upgrade", () => {
    const { updates } = dependabot("node-next-prisma");
    for (const update of updates) expect(update.cooldown).toEqual({ "default-days": 7 });
    const actions = updates.find((u) => u["package-ecosystem"] === "github-actions");
    expect(actions?.["exclude-paths"]).toEqual([".github/workflows/ci.yml"]);
  });

  it("titles its pull requests as Conventional Commits", () => {
    const { updates } = dependabot("python-fastapi");
    expect(updates.map((u) => u["commit-message"])).toEqual([
      { prefix: "build", include: "scope" },
      { prefix: "ci", include: "scope" },
      { prefix: "build", include: "scope" },
    ]);
  });
});

describe("PR title check", () => {
  const title = new RegExp(TITLE_PATTERN);

  it.each([
    "feat: add login",
    "fix(api): handle timeouts",
    "feat!: drop Node 20",
    "build(deps): bump zod from 4.6.7 to 4.7.0",
    "ci(deps): bump actions/checkout",
  ])("accepts %j", (value) => {
    expect(title.test(value)).toBe(true);
  });

  it.each(["Add login", "feat:add login", "feature: add login", "fix(): x", "feat:  x", ""])(
    "rejects %j",
    (value) => {
      expect(title.test(value)).toBe(false);
    },
  );

  it("needs no token permissions and passes the title through env", () => {
    const wf = parse(fileFor("node-next-prisma", PR_TITLE_WORKFLOW)) as Workflow;
    expect(wf.permissions).toEqual({});
    const job = wf.jobs["conventional-title"];
    expect(job?.permissions).toEqual({});
    const step = job?.steps[0] as { env: Record<string, string>; run: string };
    expect(step.env.TITLE).toBe(expr("github.event.pull_request.title"));
    expect(step.run).not.toContain("${{");
  });
});

describe("pre-commit config", () => {
  it("pins Gitleaks to a commit SHA and runs the project's own lint and format checks", () => {
    const config = parse(fileFor("python-fastapi", ".pre-commit-config.yaml")) as {
      repos: { repo: string; rev?: string; hooks: { id: string; entry?: string }[] }[];
    };
    expect(config.repos[0]).toEqual({
      repo: HOOKS.gitleaks.repo,
      rev: HOOKS.gitleaks.rev,
      hooks: [{ id: "gitleaks" }],
    });
    expect(config.repos[0]?.rev).toMatch(/^[0-9a-f]{40}$/);
    expect(config.repos[1]?.hooks.map((h) => h.entry)).toEqual([
      "uv run --no-sync ruff check .",
      "uv run --no-sync ruff format --check .",
    ]);
  });

  it("keeps only Gitleaks when there is nothing to lint or format", () => {
    const config = parse(fileFor("node-next-prisma", ".pre-commit-config.yaml")) as {
      repos: unknown[];
    };
    expect(config.repos).toHaveLength(2);
    const bare = generateFiles(
      (() => {
        const result = planPipeline(
          detectProject(tempProject({ "package.json": "{}", "package-lock.json": "{}" })),
          null,
        );
        if (result.status !== "ok") throw new Error("plan failed");
        return result.plan;
      })(),
    ).find((f) => f.path === ".pre-commit-config.yaml");
    expect((parse(bare?.content ?? "") as { repos: unknown[] }).repos).toHaveLength(1);
  });
});

describe("starting-point files", () => {
  it("indents Python with 4 spaces and Node with 2", () => {
    expect(fileFor("python-django", ".editorconfig")).toContain("indent_size = 4");
    expect(fileFor("node-hono-workers", ".editorconfig")).toContain("indent_size = 2");
  });

  it("ships a CODEOWNERS stub that assigns nobody until edited", () => {
    const lines = fileFor("node-hono-workers", ".github/CODEOWNERS").split("\n");
    expect(lines.every((line) => line === "" || line.startsWith("#"))).toBe(true);
  });
});
