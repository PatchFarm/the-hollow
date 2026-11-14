import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type HollowConfigInput, hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { generateFiles } from "../src/generate/index.js";
import { ACTIONS, NPM_TOOLS } from "../src/generate/pins.js";
import { RELEASE_WORKFLOW } from "../src/generate/release.js";
import { expr } from "../src/generate/render.js";
import { PREVIEW_WORKFLOW, VERCEL_JSON } from "../src/generate/vercel.js";
import { type PipelinePlan, planPipeline } from "../src/pipeline/plan.js";
import { copyFixture, fixture, runCli } from "./helpers.js";

type Step = Record<string, unknown> & {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string[];
  if?: string;
  permissions?: unknown;
  environment?: unknown;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = { on?: unknown; concurrency?: unknown; jobs: Record<string, Job> };

function plan(
  extra: Partial<HollowConfigInput> = {},
  dir = fixture("node-next-prisma"),
): PipelinePlan {
  const config = hollowConfigSchema.parse({ version: 1, deploy: { target: "vercel" }, ...extra });
  const result = planPipeline(detectProject(dir), config);
  if (result.status !== "ok") throw new Error(result.error);
  return result.plan;
}

const file = (p: PipelinePlan, path: string) => generateFiles(p).find((f) => f.path === path);
const workflow = (p: PipelinePlan, path = RELEASE_WORKFLOW) =>
  parse(file(p, path)?.content ?? "") as Workflow;
const step = (job: Job | undefined, prefix: string) =>
  job?.steps.find((s) => s.name?.startsWith(prefix));

const RELEASED = expr("needs.release-please.outputs.released == 'true'");
const URLS = {
  environments: {
    staging: { url: "https://staging.example.com" },
    production: { url: "https://example.com" },
  },
  verify: { healthPath: "/api/health" },
};

describe("Vercel deploys", () => {
  it("builds once per merge as a staged production deployment, then promotes it on release", () => {
    const wf = workflow(plan());
    expect(Object.keys(wf.jobs)).toEqual([
      "release-please",
      "deploy-staging",
      "release-assets",
      "production-gate",
      "deploy-production",
      "deploy-production-manual",
    ]);
    const staging = wf.jobs["deploy-staging"];
    expect(staging?.if).toBe(expr("github.event_name == 'push'"));
    expect(staging?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
    expect(step(staging, "Pull the production settings")?.run).toContain(
      "vercel pull --yes --environment=production",
    );
    expect(step(staging, "Deploy")?.run).toContain("vercel deploy --prebuilt --prod --skip-domain");
    expect(staging?.outputs).toEqual({ url: expr("steps.deploy.outputs.url") });

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
    // Prisma migrations: the job checks out the code to migrate production's database first.
    expect(production?.permissions).toEqual({ contents: "read" });
    expect(step(staging, "Apply the prisma")).toBeUndefined();
    expect(step(production, "Apply the prisma migrations to the production database")?.env).toEqual(
      { DATABASE_URL: expr("secrets.DATABASE_URL") },
    );
    const promote = step(production, "Promote the staged deployment");
    expect(promote?.env?.DEPLOYMENT).toBe(expr("needs.deploy-staging.outputs.url"));
    expect(promote?.run).toContain('vercel promote "$DEPLOYMENT" --yes');
    expect(JSON.stringify(production)).not.toContain("vercel build");
  });

  it("never gives the build step the token, and checks the CLI's checksum", () => {
    const staging = workflow(plan()).jobs["deploy-staging"];
    const build = step(staging, "Build with production settings");
    expect(build?.run).toBe("vercel build --prod");
    expect(build?.env).not.toHaveProperty("VERCEL_TOKEN");
    const install = step(staging, "Install the Vercel CLI");
    expect(install?.env).toEqual({ URL: NPM_TOOLS.vercel.url, SHA512: NPM_TOOLS.vercel.sha512 });
    expect(install?.run).toContain("sha512sum --check --strict");
    expect(install?.run).toContain("--ignore-scripts");
  });

  it("attests the build output and passes it to the release through an artifact", () => {
    const wf = workflow(plan());
    const staging = wf.jobs["deploy-staging"];
    expect(staging?.steps.filter((s) => s.uses === ACTIONS.attest.uses)).toHaveLength(2);
    expect(step(staging, "Keep the build output")?.uses).toBe(ACTIONS.uploadArtifact.uses);
    const assets = wf.jobs["release-assets"];
    expect(assets?.if).toBe(RELEASED);
    expect(assets?.permissions).toEqual({ contents: "write" });
    expect(assets?.steps[0]?.uses).toBe(ACTIONS.downloadArtifact.uses);
    expect(JSON.stringify(assets)).toContain("deployment-url.txt");
  });

  it("points the staging domain, checks it with the bypass header, and rolls production back", () => {
    const wf = workflow(plan(URLS));
    const staging = wf.jobs["deploy-staging"];
    expect(staging?.environment).toEqual({ name: "staging", url: "https://staging.example.com" });
    expect(step(staging, "Point staging.example.com")?.run).toBe(
      'vercel alias set "$DEPLOYMENT" "$HOST" --token "$VERCEL_TOKEN"',
    );
    const check = step(staging, "Check ");
    expect(check?.env).toEqual({
      URL: "https://staging.example.com/api/health",
      BYPASS: expr("secrets.VERCEL_AUTOMATION_BYPASS_SECRET"),
    });
    expect(check?.run).toContain("x-vercel-protection-bypass: $BYPASS");

    const production = wf.jobs["deploy-production"];
    expect(step(production, "Note what example.com serves now")?.run).toContain("vercel inspect");
    expect(step(production, "Check ")?.env?.URL).toBe("https://example.com/api/health");
    const rollback = step(production, "Roll back");
    expect(rollback?.if).toBe(expr("failure() && steps.promote.outcome == 'success'"));
    expect(rollback?.run).toContain('vercel rollback "https://$PREVIOUS"');
  });

  it("checks the staged deployment's own URL when staging has no domain", () => {
    const check = step(workflow(plan()).jobs["deploy-staging"], "Check ");
    expect(check?.env?.URL).toBe(`${expr("steps.deploy.outputs.url")}/`);
    expect(step(workflow(plan()).jobs["deploy-production"], "Roll back")).toBeUndefined();
  });

  it("adds preprod only with a domain, between staging and production", () => {
    const withUrl = workflow(
      plan({ environments: { preprod: { enabled: true, url: "https://preprod.example.com" } } }),
    );
    expect(withUrl.jobs["deploy-preprod"]?.needs).toEqual([
      "release-please",
      "deploy-staging",
      "release-assets",
    ]);
    expect(step(withUrl.jobs["deploy-preprod"], "Point preprod.example.com")).toBeDefined();
    expect(withUrl.jobs["deploy-production"]?.needs).toContain("deploy-preprod");

    const without = plan({ environments: { preprod: { enabled: true } } });
    expect(workflow(without).jobs["deploy-preprod"]).toBeUndefined();
    expect(without.notes.join("\n")).toContain("needs environments.preprod.url");
  });

  it("uses custom secret and variable names from hollow.yml", () => {
    const text = file(
      plan({
        deploy: {
          target: "vercel",
          tokenSecret: "VC_TOKEN",
          orgIdVariable: "VC_ORG",
          projectIdVariable: "VC_PROJECT",
          bypassSecret: "VC_BYPASS",
        },
        ...URLS,
      }),
      RELEASE_WORKFLOW,
    )?.content;
    for (const name of [
      "secrets.VC_TOKEN",
      "vars.VC_ORG",
      "vars.VC_PROJECT",
      "secrets.VC_BYPASS",
    ]) {
      expect(text).toContain(name);
    }
  });

  it("never puts expressions inside scripts", () => {
    const p = plan({
      ...URLS,
      environments: {
        ...URLS.environments,
        preprod: { enabled: true, url: "https://pre.example.com" },
      },
    });
    for (const path of [RELEASE_WORKFLOW, PREVIEW_WORKFLOW]) {
      for (const job of Object.values(workflow(p, path).jobs)) {
        for (const s of job.steps) {
          if (typeof s.run === "string") expect(s.run).not.toContain("${{");
        }
      }
    }
  });
});

describe("Vercel previews", () => {
  it("deploys same-repo pull requests with Preview settings and comments the URL", () => {
    const wf = workflow(plan(), PREVIEW_WORKFLOW);
    expect(wf.on).toEqual({ pull_request: { types: ["opened", "synchronize", "reopened"] } });
    expect(wf.concurrency).toEqual({
      group: `preview-${expr("github.event.pull_request.number")}`,
      "cancel-in-progress": true,
    });
    const job = wf.jobs.preview;
    expect(job?.if).toBe(
      expr(
        "github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'",
      ),
    );
    expect(job?.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    expect(step(job, "Pull the preview settings")?.run).toContain("--environment=preview");
    expect(step(job, "Build with preview settings")?.run).toBe("vercel build");
    const deploy = step(job, "Deploy")?.run ?? "";
    expect(deploy).toContain("vercel deploy --prebuilt --token");
    expect(deploy).not.toContain("--prod");
    expect(step(job, "Post the preview URL")?.run).toContain("issues/comments/$id");
  });

  it("only exists for Vercel", () => {
    const docker = planPipeline(
      detectProject(fixture("python-fastapi")),
      hollowConfigSchema.parse({ version: 1, deploy: { target: "docker" } }),
    );
    if (docker.status !== "ok") throw new Error(docker.error);
    expect(file(docker.plan, PREVIEW_WORKFLOW)).toBeUndefined();
  });
});

describe("vercel.json", () => {
  it("writes a starter that turns off Vercel's own Git deploys when there is none", () => {
    const written = file(plan(), VERCEL_JSON);
    expect(written?.kind).toBe("scaffold");
    expect(JSON.parse(written?.content ?? "")).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      git: { deploymentEnabled: false },
    });
  });

  it("leaves an existing vercel.json alone and says what to add", () => {
    const dir = copyFixture("node-next-prisma");
    const withConfig = (content: string) => {
      writeFileSync(`${dir}/vercel.json`, content);
      return plan({}, dir);
    };
    const missing = withConfig('{ "cleanUrls": true }');
    expect(file(missing, VERCEL_JSON)).toBeUndefined();
    expect(missing.notes.join("\n")).toContain('"git": { "deploymentEnabled": false }');

    const done = withConfig('{ "git": { "deploymentEnabled": false } }');
    expect(done.notes.join("\n")).not.toContain("deploymentEnabled");
  });

  it("lists the Vercel setup in init's next steps", async () => {
    const dir = copyFixture("node-next-prisma");
    writeFileSync(`${dir}/hollow.yml`, "version: 1\ndeploy:\n  target: vercel\n");
    const result = await runCli(["init", "--yes", "--cwd", dir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("create         .github/workflows/preview.yml");
    expect(result.stdout).toContain("create         vercel.json");
    expect(result.stdout).toContain(
      "as the VERCEL_ORG_ID and VERCEL_PROJECT_ID repository variables",
    );
    expect(result.stdout).toContain("as the VERCEL_AUTOMATION_BYPASS_SECRET secret");
    expect(result.stdout).toContain("uses production's Vercel environment variables");
  });
});
