import type { ContainerStarter, DeployPlan } from "../pipeline/deploy.js";
import { TOOL_VERSIONS, UV_IMAGE } from "./pins.js";

export const DOCKERFILE = "Dockerfile";
export const DOCKERIGNORE = ".dockerignore";

const HEADER = `# syntax=docker/dockerfile:1
# Starter Dockerfile created by The Hollow. It is yours now: edit it freely, and
# \`hollow upgrade\` will never change it. Base images are pinned by digest, and
# Dependabot keeps those digests up to date.`;

/** Exec-form CMD, or one that stops with a clear message when the start command is unknown. */
function cmd(start: string[] | null): string {
  const args = start ?? [
    "sh",
    "-c",
    "echo 'Edit the CMD line in the Dockerfile so it starts your app.' >&2; exit 1",
  ];
  return `CMD ${JSON.stringify(args).replaceAll('","', '", "')}`;
}

/**
 * Multi-stage, non-root, with the base image pinned by digest. The build stage has the dev
 * tooling; the runtime stage gets only what the app needs to run.
 */
export function renderDockerfile(starter: ContainerStarter): string {
  return starter.language === "node" ? nodeDockerfile(starter) : pythonDockerfile(starter);
}

function nodeDockerfile(starter: ContainerStarter): string {
  const base = starter.baseImage.image;
  const build: string[] = [`FROM ${base} AS build`, "WORKDIR /app"];
  if (starter.corepack) build.push("RUN corepack enable");
  build.push("COPY . .", `RUN ${starter.install.join(" && ")}`);
  if (starter.build !== null) build.push(`RUN ${starter.build}`);
  if (starter.prune !== null) build.push(`RUN ${starter.prune}`);

  const runtime = [
    `FROM ${base} AS runtime`,
    "ENV NODE_ENV=production",
    `ENV PORT=${starter.appPort}`,
    "WORKDIR /app",
    "COPY --from=build --chown=node:node /app ./",
    "USER node",
    `EXPOSE ${starter.appPort}`,
    cmd(starter.start),
  ];
  return `${HEADER}\n\n# Node ${starter.baseImage.version}\n${build.join("\n")}\n\n${runtime.join("\n")}\n`;
}

function pythonDockerfile(starter: ContainerStarter): string {
  const base = starter.baseImage.image;
  const build: string[] = [
    `FROM ${base} AS build`,
    "ENV PIP_NO_CACHE_DIR=1 \\",
    "    PIP_DISABLE_PIP_VERSION_CHECK=1",
    "WORKDIR /app",
  ];
  if (starter.packageManager === "poetry") {
    build.push(`RUN pip install poetry==${TOOL_VERSIONS.poetry}`);
  }
  build.push("RUN python -m venv /venv", 'ENV PATH="/venv/bin:$PATH" \\', "    VIRTUAL_ENV=/venv");

  if (starter.packageManager === "uv") {
    const locked = starter.lockfile === null ? "" : " --locked";
    build.push(
      `COPY --from=${UV_IMAGE.image} /uv /usr/local/bin/uv`,
      "ENV UV_COMPILE_BYTECODE=1 \\",
      "    UV_LINK_MODE=copy \\",
      "    UV_PROJECT_ENVIRONMENT=/venv \\",
      "    UV_PYTHON_DOWNLOADS=never",
      `COPY pyproject.toml${starter.lockfile === null ? "" : ` ${starter.lockfile}`} ./`,
      `RUN uv sync${locked} --no-dev --no-install-project`,
      "COPY . .",
      `RUN uv sync${locked} --no-dev`,
    );
  } else if (starter.packageManager === "poetry") {
    build.push(
      "ENV POETRY_VIRTUALENVS_CREATE=false",
      `COPY pyproject.toml${starter.lockfile === null ? "" : ` ${starter.lockfile}`} ./`,
      "RUN poetry install --only main --no-root --no-interaction",
      "COPY . .",
    );
  } else if (starter.requirements !== null) {
    build.push(
      `COPY ${starter.requirements} ./`,
      `RUN pip install -r ${starter.requirements}`,
      "COPY . .",
    );
  } else {
    build.push("COPY . .", "RUN pip install .");
  }

  const runtime = [
    `FROM ${base} AS runtime`,
    'ENV PATH="/venv/bin:$PATH" \\',
    "    PYTHONUNBUFFERED=1 \\",
    "    PYTHONDONTWRITEBYTECODE=1",
    "WORKDIR /app",
    "RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app",
    "COPY --from=build /venv /venv",
    "COPY --from=build /app /app",
    "USER app",
    `EXPOSE ${starter.appPort}`,
    cmd(starter.start),
  ];
  return `${HEADER}\n\n# Python ${starter.baseImage.version}\n${build.join("\n")}\n\n${runtime.join("\n")}\n`;
}

export function renderDockerignore(starter: ContainerStarter): string {
  const language =
    starter.language === "node"
      ? ["node_modules", "npm-debug.log*", "coverage"]
      : [
          "__pycache__",
          "*.py[cod]",
          ".venv",
          "venv",
          ".pytest_cache",
          ".mypy_cache",
          ".ruff_cache",
        ];
  return `# Keeps the image small and secrets out of it. Created by The Hollow; edit freely.
.git
.github
.env
.env.*
!.env.example
${language.join("\n")}
Dockerfile
.dockerignore
deploy
`;
}

export const COMPOSE_HEADER = "Created by The Hollow";

/**
 * `deploy/compose.yaml`: what each environment runs on the server. The deploy workflow copies it
 * to `<path>/<environment>/compose.yaml` and sets IMAGE (the release digest) and APP_PORT.
 */
export function renderDeployCompose(deploy: DeployPlan, language: "node" | "python"): string {
  const vps = deploy.vps;
  const base = vps?.path ?? "/srv/app";
  const port = deploy.appPort;
  const url = `http://127.0.0.1:${port}${deploy.healthPath}`;
  // Healthy means the app answers without a server error (below 500), the same rule the
  // deploy workflow's check uses.
  const probe =
    language === "node"
      ? [
          "node",
          "-e",
          `"fetch('${url}').then((r) => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"`,
        ]
      : [
          "python",
          "-c",
          `"import http.client, sys; c = http.client.HTTPConnection('127.0.0.1', ${port}, timeout=5); c.request('GET', '${deploy.healthPath}'); sys.exit(c.getresponse().status >= 500)"`,
        ];
  const test = ["CMD", ...probe].map((part) => `        - ${part}`).join("\n");
  const ports = deploy.environments
    .map((environment) => `${environment.name} ${environment.hostPort}`)
    .join(", ");
  return `# ${COMPOSE_HEADER}: what each environment runs on your server. It is yours now:
# edit it freely, and \`hollow upgrade\` will never change it.
#
# Each deploy copies this file to ${base}/<environment>/compose.yaml and sets IMAGE to the
# released image (by digest) and APP_PORT to the environment's port on 127.0.0.1:
# ${ports}.
# Point your reverse proxy at those ports, and put each environment's runtime settings in
# ${base}/<environment>/.env on the server.
services:
  app:
    image: \${IMAGE:?IMAGE is set by the deploy workflow}
    restart: unless-stopped
    env_file:
      - path: .env
        required: false
    ports:
      - "127.0.0.1:\${APP_PORT:-${port}}:${port}"
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test:
${test}
      interval: 10s
      timeout: 6s
      retries: 3
      start_period: 30s
`;
}
