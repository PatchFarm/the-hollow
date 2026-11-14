import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type HollowConfigInput, hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { generateFiles } from "../src/generate/index.js";
import { BASE_IMAGES, TOOL_VERSIONS, UV_IMAGE } from "../src/generate/pins.js";
import { RELEASE_WORKFLOW } from "../src/generate/release.js";
import { expr } from "../src/generate/render.js";
import { type PipelinePlan, planPipeline } from "../src/pipeline/plan.js";
import { fixture, runCli, tempProject } from "./helpers.js";

type Step = Record<string, unknown> & {
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
};
type Job = {
  name: string;
  needs?: string[];
  if?: string;
  permissions?: unknown;
  environment?: unknown;
  concurrency?: unknown;
  steps: Step[];
};
type Workflow = { concurrency?: unknown; jobs: Record<string, Job> };

const VPS = { target: "vps", host: "app.example.com" } as const;

function plan(
  dir: string,
  config: Partial<HollowConfigInput> & Pick<HollowConfigInput, "deploy">,
): PipelinePlan {
  const parsed = hollowConfigSchema.parse({ version: 1, ...config });
  const result = planPipeline(detectProject(dir), parsed);
  if (result.status !== "ok") throw new Error(result.error);
  return result.plan;
}

function file(p: PipelinePlan, path: string): string | undefined {
  return generateFiles(p).find((f) => f.path === path)?.content;
}

function workflow(p: PipelinePlan): Workflow {
  return parse(file(p, RELEASE_WORKFLOW) ?? "") as Workflow;
}

const stepNamed = (job: Job | undefined, prefix: string) =>
  job?.steps.find((step) => step.name?.startsWith(prefix));

const RELEASED = expr("needs.release-please.outputs.released == 'true'");

describe("deploy pipeline for image targets", () => {
  it("deploys every merge to staging and promotes releases to production after staging", () => {
    const wf = workflow(plan(fixture("python-django"), { deploy: VPS }));
    expect(wf.concurrency).toBeUndefined();
    expect(Object.keys(wf.jobs)).toEqual([
      "release-please",
      "build",
      "release-assets",
      "deploy-staging",
      "production-gate",
      "deploy-production",
      "deploy-production-manual",
    ]);
    const staging = wf.jobs["deploy-staging"];
    expect(staging?.needs).toEqual(["build"]);
    expect(staging?.if).toBe(expr("github.event_name == 'push'"));
    expect(staging?.environment).toBe("staging");
    expect(staging?.concurrency).toEqual({ group: "deploy-staging", "cancel-in-progress": false });

    const production = wf.jobs["deploy-production"];
    expect(production?.needs).toEqual([
      "release-please",
      "build",
      "release-assets",
      "deploy-staging",
      "production-gate",
    ]);
    expect(production?.if).toBe(
      expr(
        "needs.release-please.outputs.released == 'true' && needs.production-gate.outputs.reviewed == 'true'",
      ),
    );
    expect(production?.environment).toBe("production");
  });

  it("puts preprod between staging and production when it is enabled", () => {
    const wf = workflow(
      plan(fixture("python-django"), { deploy: VPS, environments: { preprod: { enabled: true } } }),
    );
    expect(wf.jobs["deploy-preprod"]?.needs).toContain("deploy-staging");
    expect(wf.jobs["deploy-preprod"]?.if).toBe(RELEASED);
    expect(wf.jobs["deploy-production"]?.needs).toContain("deploy-preprod");
  });

  it("deploys to a VPS over SSH with a pinned host key, then checks and rolls back", () => {
    const p = plan(fixture("python-django"), {
      deploy: { ...VPS, port: 2222, path: "/srv/site", sshKeySecret: "DEPLOY_KEY" },
      environments: { staging: { url: "https://staging.example.com" } },
      verify: { healthPath: "/healthz" },
    });
    const staging = workflow(p).jobs["deploy-staging"];
    expect(staging?.permissions).toEqual({ contents: "read", packages: "read" });
    expect(staging?.environment).toEqual({ name: "staging", url: "https://staging.example.com" });

    const ssh = stepNamed(staging, "Set up SSH");
    expect(ssh?.env).toEqual({
      SSH_KEY: expr("secrets.DEPLOY_KEY"),
      KNOWN_HOSTS: expr("vars.VPS_KNOWN_HOSTS"),
    });
    expect(ssh?.run).toContain("ssh-keyscan -p 2222 app.example.com");

    const deploy = stepNamed(staging, "Deploy to app.example.com");
    expect(deploy?.env).toMatchObject({
      HOST: "app.example.com",
      SSH_PORT: "2222",
      DIR: "/srv/site/staging",
      APP_PORT: expr("vars.APP_PORT || '8001'"),
      IMAGE_REF: `${expr("needs.build.outputs.image")}@${expr("needs.build.outputs.digest")}`,
    });
    expect(deploy?.run).toContain("StrictHostKeyChecking=yes");
    expect(deploy?.run).toContain("--password-stdin");
    expect(deploy?.run).toContain("docker logout ghcr.io");
    expect(deploy?.run).toContain("compose up --detach --wait");

    expect(stepNamed(staging, "Check ")?.env).toEqual({
      URL: "https://staging.example.com/healthz",
    });
    expect(stepNamed(staging, "Roll back")?.if).toBe(
      expr("failure() && steps.deploy.outcome == 'success'"),
    );

    // No url for production: the container health check still guards it, but there is no URL check.
    const production = workflow(p).jobs["deploy-production"];
    expect(stepNamed(production, "Check ")).toBeUndefined();
    expect(stepNamed(production, "Roll back")).toBeUndefined();
    expect(stepNamed(production, "Deploy to")?.env).toMatchObject({
      APP_PORT: expr("vars.APP_PORT || '8000'"),
    });
  });

  it("promotes Docker images by moving the environment's tag, and rolls the tag back", () => {
    const p = plan(fixture("python-fastapi"), {
      deploy: { target: "docker" },
      environments: { production: { url: "https://api.example.com" } },
    });
    const production = workflow(p).jobs["deploy-production"];
    expect(production?.permissions).toEqual({ packages: "write" });
    const promote = stepNamed(production, "Point the production tag");
    expect(promote?.env).toMatchObject({ TAG_NAME: "production" });
    expect(promote?.run).toContain('imagetools create --tag "$IMAGE:$TAG_NAME" "$IMAGE@$DIGEST"');
    expect(stepNamed(production, "Check ")?.env).toEqual({ URL: "https://api.example.com/" });
    expect(stepNamed(production, "Roll back")?.run).toContain('"$IMAGE@$PREVIOUS"');
    expect(file(p, "deploy/compose.yaml")).toBeUndefined();
  });

  it("never puts expressions inside scripts", () => {
    for (const config of [
      { deploy: VPS, environments: { staging: { url: "https://s.example.com" } } },
      {
        deploy: { target: "docker" as const },
        environments: { staging: { url: "https://s.example.com" } },
      },
    ]) {
      const wf = workflow(plan(fixture("python-django"), config));
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps) {
          if (typeof step.run === "string") expect(step.run).not.toContain("${{");
        }
      }
    }
  });

  it("writes deploy/compose.yaml for VPS deploys, with the health path and each environment's port", () => {
    const compose = file(
      plan(fixture("python-django"), {
        deploy: VPS,
        environments: { preprod: { enabled: true } },
        verify: { healthPath: "/health" },
      }),
      "deploy/compose.yaml",
    );
    expect(compose).toContain(`\${IMAGE:?IMAGE is set by the deploy workflow}`);
    expect(compose).toContain(`"127.0.0.1:\${APP_PORT:-8000}:8000"`);
    expect(compose).toContain("staging 8001, preprod 8002, production 8000");
    expect(compose).toContain("c.request('GET', '/health')");
    expect(parse(compose ?? "")).toMatchObject({
      services: { app: { restart: "unless-stopped" } },
    });
  });
});

describe("starter Dockerfile", () => {
  it("is only written when the project has no Dockerfile", () => {
    expect(
      file(plan(fixture("python-fastapi"), { deploy: { target: "docker" } }), "Dockerfile"),
    ).toBeUndefined();
    const django = generateFiles(plan(fixture("python-django"), { deploy: VPS }));
    expect(django.find((f) => f.path === "Dockerfile")?.kind).toBe("scaffold");
    expect(django.find((f) => f.path === ".dockerignore")?.content).toContain(".env.*");
  });

  it("runs Django with gunicorn as a non-root user, on a pinned base image", () => {
    const dockerfile = file(plan(fixture("python-django"), { deploy: VPS }), "Dockerfile") ?? "";
    expect(dockerfile).toContain(`FROM ${BASE_IMAGES.python["3.13"].image} AS build`);
    expect(dockerfile).toContain("RUN pip install -r requirements.txt");
    expect(dockerfile).toContain("USER app");
    expect(dockerfile).toContain(
      'CMD ["gunicorn", "mysite.wsgi:application", "--bind", "0.0.0.0:8000"]',
    );
  });

  it("finds a FastAPI app for uv projects and copies uv from its pinned image", () => {
    const dir = tempProject({
      "pyproject.toml":
        '[project]\nname = "api"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndependencies = ["fastapi", "uvicorn"]\n',
      "uv.lock": "version = 1\n",
      "src/__init__.py": "",
      "service/main.py": "from fastapi import FastAPI\n\napi = FastAPI()\n",
    });
    const p = plan(dir, { deploy: { target: "docker", appPort: 9000 } });
    const dockerfile = file(p, "Dockerfile") ?? "";
    expect(dockerfile).toContain(`FROM ${BASE_IMAGES.python["3.12"].image} AS build`);
    expect(dockerfile).toContain(`COPY --from=${UV_IMAGE.image} /uv /usr/local/bin/uv`);
    expect(dockerfile).toContain("RUN uv sync --locked --no-dev --no-install-project");
    expect(dockerfile).toContain(
      'CMD ["uvicorn", "service.main:api", "--host", "0.0.0.0", "--port", "9000"]',
    );
    expect(dockerfile).toContain("EXPOSE 9000");
    expect(p.notes.join("\n")).not.toContain("starter Dockerfile");
  });

  it("installs Poetry in the build stage only, and says when the server is missing", () => {
    const dir = tempProject({
      "pyproject.toml":
        '[tool.poetry]\nname = "app"\nversion = "0.1.0"\n\n[tool.poetry.dependencies]\npython = "^3.13"\nflask = "*"\n',
      "poetry.lock": "",
      "app.py": "from flask import Flask\napp = Flask(__name__)\n",
    });
    const p = plan(dir, { deploy: { target: "docker" } });
    const dockerfile = file(p, "Dockerfile") ?? "";
    expect(dockerfile.indexOf(`RUN pip install poetry==${TOOL_VERSIONS.poetry}`)).toBeLessThan(
      dockerfile.indexOf("RUN python -m venv /venv"),
    );
    expect(dockerfile).toContain("COPY pyproject.toml poetry.lock ./");
    expect(dockerfile).toContain("RUN poetry install --only main --no-root --no-interaction");
    expect(dockerfile).toContain('CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:8000"]');
    expect(p.notes.join("\n")).toContain(
      "runs Flask with gunicorn, which is not in the project's dependencies",
    );
  });

  it("stops with a message, and says so, when it cannot tell how to start the app", () => {
    const dir = tempProject({ "requirements.txt": "requests\n", "main.py": "print('hi')\n" });
    const p = plan(dir, { deploy: { target: "docker" } });
    expect(file(p, "Dockerfile")).toContain(
      "Edit the CMD line in the Dockerfile so it starts your app.",
    );
    expect(p.notes.join("\n")).toContain("could not tell how to start this app");
  });

  it("builds Node apps with their own package manager and starts them with npm start", () => {
    const p = plan(fixture("node-next-prisma"), { deploy: { target: "docker" } });
    const dockerfile = file(p, "Dockerfile") ?? "";
    expect(dockerfile).toContain(`FROM ${BASE_IMAGES.node["22"].image} AS build`);
    expect(dockerfile).toContain("RUN npm ci && npm exec --no -- prisma generate");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("RUN npm prune --omit=dev");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('CMD ["npm", "start"]');
    expect(dockerfile).toContain("EXPOSE 3000");
  });

  it("enables Corepack for pnpm, and uses the default Node line for an unpinned version", () => {
    const dir = tempProject({
      "package.json": JSON.stringify({
        name: "web",
        scripts: { start: "node server.js" },
        engines: { node: ">=20" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    const p = plan(dir, { deploy: { target: "docker" } });
    const dockerfile = file(p, "Dockerfile") ?? "";
    expect(dockerfile).toContain("RUN corepack enable");
    expect(dockerfile).toContain("RUN pnpm prune --prod");
    expect(dockerfile).toContain(`FROM ${BASE_IMAGES.node["24"].image} AS build`);
    expect(p.notes.join("\n")).toContain("The starter Dockerfile uses Node 24");
  });

  it("falls back to a source archive for Bun, and says so", () => {
    const dir = tempProject({
      "package.json": JSON.stringify({ name: "b", scripts: { start: "bun run index.ts" } }),
      "bun.lock": "{}",
    });
    const p = plan(dir, { deploy: VPS });
    expect(p.release?.artifact.kind).toBe("archive");
    expect(p.deploy).toBeNull();
    expect(p.notes.join("\n")).toContain("does not write a starter Dockerfile for Bun");
  });
});

describe("init and plan for deploys", () => {
  it("lists the server setup, secrets and missing health URLs in init's next steps", async () => {
    const dir = tempProject({
      "requirements.txt": "django\ngunicorn\n",
      "manage.py": 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "site.settings")\n',
      "site/wsgi.py": "application = None\n",
      "hollow.yml": "version: 1\ndeploy:\n  target: vps\n  host: app.example.com\n",
    });
    const shown = await runCli(["plan", "--cwd", dir]);
    expect(shown.stdout).toContain(
      "staging (every merge), production (on release); Docker Compose on app.example.com over SSH",
    );
    const result = await runCli(["init", "--yes", "--cwd", dir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("create         Dockerfile");
    expect(result.stdout).toContain("create         deploy/compose.yaml");
    expect(result.stdout).toContain("127.0.0.1:8001 (staging), 127.0.0.1:8000 (production)");
    expect(result.stdout).toContain("as the VPS_SSH_KEY secret");
    expect(result.stdout).toContain("ssh-keyscan -p 22 app.example.com");
    expect(result.stdout).toContain(
      "Set environments.<name>.url in hollow.yml for staging, production",
    );

    expect(shown.stdout).toContain("starter written by init");
  });
});
