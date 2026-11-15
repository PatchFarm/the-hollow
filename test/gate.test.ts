import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type HollowConfigInput, hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { generateFiles } from "../src/generate/index.js";
import { ACTIONS } from "../src/generate/pins.js";
import { RELEASE_WORKFLOW } from "../src/generate/release.js";
import { expr } from "../src/generate/render.js";
import { planPipeline } from "../src/pipeline/plan.js";
import { fixture, runCli, tempProject } from "./helpers.js";

type Step = Record<string, unknown> & {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  name?: string;
  needs?: string[];
  if?: string;
  permissions?: Record<string, string>;
  environment?: unknown;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

const SAMPLES: [string, HollowConfigInput["deploy"], string][] = [
  ["python-fastapi", { target: "docker" }, "image-digest.txt"],
  ["python-django", { target: "vps", host: "app.example.com" }, "image-digest.txt"],
  ["node-next-prisma", { target: "vercel" }, "deployment-url.txt"],
  ["node-hono-workers", { target: "cloudflare-workers" }, "worker-version.txt"],
  ["node-vite-static", { target: "cloudflare-pages", projectName: "site" }, "*.tar.gz"],
];

function release(
  dir: string,
  deploy: HollowConfigInput["deploy"],
  extra: Partial<HollowConfigInput> = {},
) {
  const config = hollowConfigSchema.parse({ version: 1, deploy, ...extra });
  const result = planPipeline(detectProject(dir), config);
  if (result.status !== "ok") throw new Error(result.error);
  return parse(
    generateFiles(result.plan).find((f) => f.path === RELEASE_WORKFLOW)?.content ?? "",
  ) as Workflow;
}

const step = (job: Job | undefined, prefix: string) =>
  job?.steps.find((s) => s.name?.startsWith(prefix));
const DISPATCH = expr("github.event_name == 'workflow_dispatch'");

describe.each(SAMPLES)("production approval gate: %s", (name, deploy, asset) => {
  const wf = release(fixture(name), deploy);

  it("can be run by hand with a release version", () => {
    expect(wf.on.workflow_dispatch).toEqual({
      inputs: {
        version: {
          description:
            "Release to deploy to production, for example v1.4.0. Running this is the approval.",
          required: true,
          type: "string",
        },
      },
    });
  });

  it("deploys automatically only when production has required reviewers", () => {
    const gate = wf.jobs["production-gate"];
    expect(gate?.needs).toEqual(["release-please"]);
    expect(gate?.permissions).toEqual({ actions: "read" });
    expect(gate?.outputs).toEqual({ reviewed: expr("steps.check.outputs.reviewed") });
    const check = step(gate, "Look for required reviewers")?.run ?? "";
    expect(check).toContain('gh api "repos/$GITHUB_REPOSITORY/environments/production"');
    expect(check).toContain("gh workflow run release.yml -f version=$TAG");

    const automatic = wf.jobs["deploy-production"];
    expect(automatic?.needs).toContain("production-gate");
    expect(automatic?.if).toBe(
      expr(
        "needs.release-please.outputs.released == 'true' && needs.production-gate.outputs.reviewed == 'true'",
      ),
    );
    expect(automatic?.environment).toEqual(expect.anything());
  });

  it("deploys a chosen release from its own assets when run by hand", () => {
    const manual = wf.jobs["deploy-production-manual"];
    expect(manual?.if).toBe(DISPATCH);
    expect(manual?.needs).toBeUndefined();
    expect(manual?.permissions?.contents).toBe("read");
    expect(manual?.environment).toEqual(wf.jobs["deploy-production"]?.environment);
    const resolve = manual?.steps[0];
    expect(resolve?.id).toBe("release");
    expect(resolve?.env).toEqual({ INPUT: expr("inputs.version"), GH_TOKEN: expr("github.token") });
    expect(resolve?.run).toContain("*[!A-Za-z0-9._-]*");
    expect(resolve?.run).toContain('gh release download "$tag"');
    expect(resolve?.run).toContain(asset);
    const text = JSON.stringify(manual);
    expect(text).not.toContain("needs.");
    expect(text).not.toContain(ACTIONS.downloadArtifact.uses);
  });

  it("skips every other job on a manual run", () => {
    for (const [id, job] of Object.entries(wf.jobs)) {
      if (id === "deploy-production-manual") continue;
      if (id === "report-production") {
        // It reports on whichever production job ran, the manual one included.
        expect(job.if).toContain("needs.deploy-production-manual.result == 'failure'");
        continue;
      }
      const runsOnPush =
        job.if === expr("github.event_name == 'push'") ||
        (job.if ?? "").includes("needs.release-please.outputs.released == 'true'");
      expect(runsOnPush, id).toBe(true);
    }
  });

  it("never puts expressions inside scripts", () => {
    for (const job of Object.values(wf.jobs)) {
      for (const s of job.steps) {
        if (typeof s.run === "string") expect(s.run).not.toContain("${{");
      }
    }
  });
});

describe("manual production runs", () => {
  it("deploy the release's own artifact for each target", () => {
    const docker = release(fixture("python-fastapi"), { target: "docker" }).jobs[
      "deploy-production-manual"
    ];
    expect(step(docker, "Point the production tag")?.env).toMatchObject({
      IMAGE: expr("steps.release.outputs.image"),
      DIGEST: expr("steps.release.outputs.digest"),
    });

    const vps = release(fixture("python-django"), { target: "vps", host: "app.example.com" }).jobs[
      "deploy-production-manual"
    ];
    expect(vps?.steps.find((s) => s.uses === ACTIONS.checkout.uses)?.with?.ref).toBe(
      expr("steps.release.outputs.tag"),
    );
    expect(step(vps, "Deploy to app.example.com")?.env?.IMAGE_REF).toBe(
      `${expr("steps.release.outputs.image")}@${expr("steps.release.outputs.digest")}`,
    );

    const vercel = release(fixture("node-next-prisma"), { target: "vercel" }).jobs[
      "deploy-production-manual"
    ];
    expect(step(vercel, "Promote the staged deployment")?.env?.DEPLOYMENT).toBe(
      expr("steps.release.outputs.deployment"),
    );

    const workers = release(fixture("node-hono-workers"), { target: "cloudflare-workers" }).jobs[
      "deploy-production-manual"
    ];
    expect(step(workers, "Send all traffic")?.env).toMatchObject({
      VERSION_ID: expr("steps.release.outputs.worker_version"),
      TAG: expr("steps.release.outputs.tag"),
    });

    const pages = release(fixture("node-vite-static"), {
      target: "cloudflare-pages",
      projectName: "site",
    }).jobs["deploy-production-manual"];
    expect(step(pages, "Fetch the staged build")).toBeUndefined();
    expect(step(pages, "Unpack it")?.run).toContain('"$RUNNER_TEMP"/assets/*.tar.gz');
  });

  it("only cover production: preprod stays part of the automatic release", () => {
    const wf = release(
      fixture("python-django"),
      { target: "vps", host: "app.example.com" },
      {
        environments: { preprod: { enabled: true } },
      },
    );
    expect(wf.jobs["deploy-preprod"]?.if).toBe(
      expr("needs.release-please.outputs.released == 'true'"),
    );
    expect(Object.keys(wf.jobs).filter((id) => id.endsWith("-manual"))).toEqual([
      "deploy-production-manual",
    ]);
  });
});

it("adds no gate when there is nothing to deploy", () => {
  const dir = tempProject({
    "package.json": JSON.stringify({ name: "site" }),
    "package-lock.json": "{}",
  });
  const wf = release(dir, { target: "cloudflare-pages", projectName: "site" });
  expect(wf.on.workflow_dispatch).toBeUndefined();
  expect(wf.jobs["production-gate"]).toBeUndefined();
});

it("tells init users how a release reaches production", async () => {
  const dir = tempProject({
    "requirements.txt": "django\ngunicorn\n",
    "manage.py": 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "site.settings")\n',
    "site/wsgi.py": "application = None\n",
    "hollow.yml": "version: 1\ndeploy:\n  target: vps\n  host: app.example.com\n",
  });
  const result = await runCli(["init", "--yes", "--cwd", dir]);
  expect(result.stdout).toContain("gh workflow run release.yml -f version=<tag>");
});
