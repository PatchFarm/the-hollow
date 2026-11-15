import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type HollowConfigInput, hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { generateFiles } from "../src/generate/index.js";
import { ACTIONS, NPM_TOOLS } from "../src/generate/pins.js";
import { RELEASE_WORKFLOW } from "../src/generate/release.js";
import { expr } from "../src/generate/render.js";
import { PREVIEW_WORKFLOW } from "../src/generate/vercel.js";
import { type PipelinePlan, planPipeline } from "../src/pipeline/plan.js";
import { copyFixture, fixture, runCli, tempProject } from "./helpers.js";

type Step = Record<string, unknown> & {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
};
type Job = {
  needs?: string[];
  if?: string;
  permissions?: unknown;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = { jobs: Record<string, Job> };

const WORKERS = { target: "cloudflare-workers" } as const;
const PAGES = { target: "cloudflare-pages", projectName: "site" } as const;

function plan(
  deploy: HollowConfigInput["deploy"],
  extra: Partial<HollowConfigInput> = {},
  dir = fixture(deploy.target === "cloudflare-pages" ? "node-vite-static" : "node-hono-workers"),
): PipelinePlan {
  const config = hollowConfigSchema.parse({ version: 1, deploy, ...extra });
  const result = planPipeline(detectProject(dir), config);
  if (result.status !== "ok") throw new Error(result.error);
  return result.plan;
}

const workflow = (p: PipelinePlan, path = RELEASE_WORKFLOW) =>
  parse(generateFiles(p).find((f) => f.path === path)?.content ?? "") as Workflow;
const step = (job: Job | undefined, prefix: string) =>
  job?.steps.find((s) => s.name?.startsWith(prefix));

describe("Cloudflare Workers deploys", () => {
  it("uploads a version for staging on every merge and deploys that version on release", () => {
    const wf = workflow(plan(WORKERS));
    expect(Object.keys(wf.jobs)).toEqual([
      "release-please",
      "deploy-staging",
      "release-assets",
      "production-gate",
      "deploy-production",
      "deploy-production-manual",
      "report-production",
    ]);
    const staging = wf.jobs["deploy-staging"];
    expect(staging?.if).toBe(expr("github.event_name == 'push'"));
    expect(staging?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
    expect(staging?.outputs).toEqual({
      version: expr("steps.upload.outputs.version"),
      url: expr("steps.upload.outputs.url"),
    });
    const upload = step(staging, "Upload a new version")?.run ?? "";
    expect(upload).toContain('export WRANGLER_OUTPUT_FILE_PATH="$RUNNER_TEMP/wrangler.ndjson"');
    expect(upload).toContain(
      'npm exec --no -- wrangler versions upload --preview-alias staging --tag "$GITHUB_SHA"',
    );
    expect(upload).toContain('select(.type == "version-upload")');
    expect(staging?.steps.filter((s) => s.uses === ACTIONS.attest.uses)).toHaveLength(2);

    const production = wf.jobs["deploy-production"];
    expect(production?.needs).toEqual([
      "release-please",
      "deploy-staging",
      "release-assets",
      "production-gate",
    ]);
    expect(production?.if).toBe(
      expr(
        "needs.release-please.outputs.released == 'true' && needs.production-gate.outputs.reviewed == 'true'",
      ),
    );
    const promote = step(production, "Send all traffic to the staged version");
    expect(promote?.env?.VERSION_ID).toBe(expr("needs.deploy-staging.outputs.version"));
    expect(promote?.run).toContain('versions deploy "$VERSION_ID@100%" --yes');
    expect(JSON.stringify(production)).not.toContain("versions upload");
  });

  it("checks the Version URL when there is one, and staging's own URL when it is set", () => {
    const check = step(workflow(plan(WORKERS)).jobs["deploy-staging"], "Check ");
    expect(check?.if).toBe(expr("steps.upload.outputs.url != ''"));
    expect(check?.env?.URL).toBe(`${expr("steps.upload.outputs.url")}/`);

    const configured = step(
      workflow(
        plan(WORKERS, { environments: { staging: { url: "https://staging-api.me.workers.dev" } } }),
      ).jobs["deploy-staging"],
      "Check ",
    );
    expect(configured?.if).toBeUndefined();
    expect(configured?.env?.URL).toBe("https://staging-api.me.workers.dev/");
  });

  it("rolls production back to the version it served before", () => {
    const production = workflow(
      plan(WORKERS, { environments: { production: { url: "https://api.example.com" } } }),
    ).jobs["deploy-production"];
    expect(step(production, "Note the version production serves now")?.run).toContain(
      "deployments status --json",
    );
    const rollback = step(production, "Roll back");
    expect(rollback?.if).toBe(expr("failure() && steps.promote.outcome == 'success'"));
    expect(rollback?.run).toContain('versions deploy "$PREVIOUS@100%" --yes');
    expect(step(workflow(plan(WORKERS)).jobs["deploy-production"], "Roll back")).toBeUndefined();
  });

  it("has no preprod step, and says so", () => {
    const p = plan(WORKERS, { environments: { preprod: { enabled: true } } });
    expect(workflow(p).jobs["deploy-preprod"]).toBeUndefined();
    expect(p.notes.join("\n")).toContain("Workers have no preprod step");
  });

  it("installs the pinned wrangler only when the project has none", () => {
    const dir = tempProject({
      "package.json": JSON.stringify({ name: "w", dependencies: { hono: "4.0.0" } }),
      "package-lock.json": "{}",
      "wrangler.toml": 'name = "w"\nmain = "src/index.ts"\n',
    });
    const staging = workflow(plan(WORKERS, {}, dir)).jobs["deploy-staging"];
    const install = step(staging, "Install wrangler");
    expect(install?.env).toEqual({
      URL: NPM_TOOLS.wrangler.url,
      SHA512: NPM_TOOLS.wrangler.sha512,
    });
    expect(install?.run).toContain("--ignore-scripts");
    expect(step(staging, "Upload a new version")?.run).toContain("\nwrangler versions upload");
    expect(
      step(workflow(plan(WORKERS)).jobs["deploy-staging"], "Install wrangler"),
    ).toBeUndefined();
  });

  it("stops with a clear message when the token or account ID is missing", () => {
    const setup = step(
      workflow(plan(WORKERS)).jobs["deploy-staging"],
      "Confirm the Cloudflare token",
    );
    expect(setup?.env).toEqual({
      CLOUDFLARE_API_TOKEN: expr("secrets.CLOUDFLARE_API_TOKEN"),
      CLOUDFLARE_ACCOUNT_ID: expr("vars.CLOUDFLARE_ACCOUNT_ID"),
    });
    expect(setup?.run).toContain("as the CLOUDFLARE_API_TOKEN secret");
    const custom = JSON.stringify(
      workflow(plan({ ...WORKERS, tokenSecret: "CF_TOKEN", accountIdVariable: "CF_ACCOUNT" })),
    );
    expect(custom).toContain("secrets.CF_TOKEN");
    expect(custom).toContain("vars.CF_ACCOUNT");
  });
});

describe("Cloudflare Pages deploys", () => {
  it("builds once, deploys to the staging branch, and deploys the same build to production", () => {
    const wf = workflow(plan(PAGES));
    const staging = wf.jobs["deploy-staging"];
    expect(step(staging, "Build")?.run).toBe("pnpm run build");
    const deploy = step(staging, "Deploy to the staging branch");
    expect(deploy?.env).toMatchObject({ PROJECT: "site", OUTPUT_DIR: "dist" });
    expect(deploy?.run).toContain(
      'pages deploy "$OUTPUT_DIR" --project-name "$PROJECT" --branch "staging"',
    );
    expect(step(staging, "Keep the build and SBOM")?.uses).toBe(ACTIONS.uploadArtifact.uses);

    const production = wf.jobs["deploy-production"];
    expect(production?.if).toBe(
      expr(
        "needs.release-please.outputs.released == 'true' && needs.production-gate.outputs.reviewed == 'true'",
      ),
    );
    expect(step(production, "Fetch the staged build")?.uses).toBe(ACTIONS.downloadArtifact.uses);
    expect(JSON.stringify(production)).not.toContain("pnpm run build");
    const promote = step(production, "Deploy the staged build to the main branch")?.run ?? "";
    expect(promote).toContain('pages deploy "$RUNNER_TEMP/site"');
    expect(promote).toContain('--branch "main"');
    expect(promote).toContain('if [ "$environment" != "production" ]; then');
  });

  it("rolls production back through the Cloudflare API", () => {
    const production = workflow(
      plan(PAGES, { environments: { production: { url: "https://www.example.com" } } }),
    ).jobs["deploy-production"];
    expect(step(production, "Note the deployment production serves now")?.run).toContain(
      ".result.canonical_deployment.id",
    );
    expect(step(production, "Roll back")?.run).toContain("/deployments/$PREVIOUS/rollback");
  });

  it("deploys preprod to its own branch between staging and production", () => {
    const wf = workflow(plan(PAGES, { environments: { preprod: { enabled: true } } }));
    expect(
      step(wf.jobs["deploy-preprod"], "Deploy the staged build to the preprod branch"),
    ).toBeDefined();
    expect(wf.jobs["deploy-production"]?.needs).toContain("deploy-preprod");
  });

  it("deploys same-repo pull requests to their own preview branch", () => {
    const wf = workflow(plan(PAGES), PREVIEW_WORKFLOW);
    const job = wf.jobs.preview;
    expect(job?.steps.filter((s) => s.uses === ACTIONS.checkout.uses)).toHaveLength(1);
    const deploy = step(job, "Deploy to a preview branch");
    expect(deploy?.env?.PR).toBe(expr("github.event.pull_request.number"));
    expect(deploy?.run).toContain('--branch "pr-$PR"');
    expect(step(job, "Post the preview URL")).toBeDefined();
    expect(generateFiles(plan(WORKERS)).some((f) => f.path === PREVIEW_WORKFLOW)).toBe(false);
  });
});

describe("Cloudflare pipelines", () => {
  it("never put expressions inside scripts", () => {
    const urls = {
      environments: {
        staging: { url: "https://staging.example.com" },
        preprod: { enabled: true },
        production: { url: "https://www.example.com" },
      },
    };
    for (const p of [plan(WORKERS, urls), plan(PAGES, urls)]) {
      for (const path of [RELEASE_WORKFLOW, PREVIEW_WORKFLOW]) {
        const file = generateFiles(p).find((f) => f.path === path);
        if (file === undefined) continue;
        expect(file.content).not.toMatch(/&a\d|\*a\d/);
        for (const job of Object.values((parse(file.content) as Workflow).jobs)) {
          for (const s of job.steps) {
            if (typeof s.run === "string") expect(s.run).not.toContain("${{");
          }
        }
      }
    }
  });

  it("explain the Cloudflare setup in init's next steps", async () => {
    const workers = copyFixture("node-hono-workers");
    writeFileSync(`${workers}/hollow.yml`, "version: 1\ndeploy:\n  target: cloudflare-workers\n");
    const w = await runCli(["init", "--yes", "--cwd", workers]);
    expect(w.stdout).toContain(
      "as the CLOUDFLARE_API_TOKEN secret and your account ID as the CLOUDFLARE_ACCOUNT_ID variable",
    );
    expect(w.stdout).toContain("preview_urls = true");

    const pages = copyFixture("node-vite-static");
    writeFileSync(
      `${pages}/hollow.yml`,
      "version: 1\ndeploy:\n  target: cloudflare-pages\n  projectName: site\n",
    );
    const shown = await runCli(["plan", "--cwd", pages]);
    expect(shown.stdout).toContain(
      "Pages project site: staging branch, then the same build to production",
    );
    const p = await runCli(["init", "--yes", "--cwd", pages]);
    expect(p.stdout).toContain("create         .github/workflows/preview.yml");
    expect(p.stdout).toContain("with main as its production branch");
  });
});
