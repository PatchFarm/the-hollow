import { parse as parseToml } from "smol-toml";
import type { HollowConfig } from "../config/schema.js";
import { isRecord } from "../detect/common.js";
import { collectDependencies } from "../detect/python.js";
import type { Detection, Language, PackageManager } from "../detect/types.js";
import { BASE_IMAGES, DEFAULT_RUNTIME, type ImagePin } from "../generate/pins.js";
import type { ProjectFiles } from "../util/project-files.js";

export type EnvironmentName = "staging" | "preprod" | "production";

export interface DeployEnvironment {
  name: EnvironmentName;
  /** The environment's public URL from hollow.yml, shown on GitHub's deployments page. */
  url: string | null;
  /** Full URL checked after each deploy, or null when hollow.yml sets no url for it. */
  healthUrl: string | null;
  /** Staging deploys every merge; preprod and production deploy releases only. */
  onRelease: boolean;
  /**
   * VPS only: the server port this environment listens on, so environments can share a server.
   * Production uses the app port, staging the next one, preprod the one after.
   */
  hostPort: number;
}

export interface VpsPlan {
  host: string;
  user: string;
  sshPort: number;
  /** Base directory on the server; each environment gets its own folder inside it. */
  path: string;
  sshKeySecret: string;
  knownHostsVariable: string;
}

export interface VercelPlan {
  tokenSecret: string;
  orgIdVariable: string;
  projectIdVariable: string;
  bypassSecret: string;
  /** True when init should write a vercel.json that turns off Vercel's own Git deploys. */
  writeConfig: boolean;
}

/**
 * How one build is promoted through the environments. Null for targets M3 has not reached yet.
 * Docker and VPS promote an image digest; Vercel promotes a staged production deployment.
 */
export interface DeployPlan {
  target: "docker" | "vps" | "vercel";
  environments: DeployEnvironment[];
  /** Port the app listens on inside the container. */
  appPort: number;
  healthPath: string;
  vps: VpsPlan | null;
  vercel: VercelPlan | null;
  /** Workflow for per-PR preview deploys, for targets that have them. */
  previews: boolean;
}

/** What the starter Dockerfile needs to know. Null when the project has its own Dockerfile. */
export interface ContainerStarter {
  language: Language;
  packageManager: PackageManager;
  baseImage: ImagePin;
  /** Node: install, build and prune lines for the build stage. */
  install: string[];
  build: string | null;
  prune: string | null;
  corepack: boolean;
  /** Python: the requirements file pip installs from, when there is one. */
  requirements: string | null;
  /** Python: a lockfile to copy before installing (uv.lock, poetry.lock). */
  lockfile: string | null;
  /** The command that starts the app, or null when The Hollow could not tell. */
  start: string[] | null;
  appPort: number;
}

export const DEPLOY_COMPOSE = "deploy/compose.yaml";
export const DEFAULT_APP_PORT: Record<Language, number> = { node: 3000, python: 8000 };

export function planDeploy(
  config: HollowConfig,
  appPort: number,
  files: ProjectFiles,
  notes: string[],
): DeployPlan | null {
  const { deploy, environments, verify } = config;
  if (deploy.target !== "docker" && deploy.target !== "vps" && deploy.target !== "vercel") {
    return null;
  }
  const health = (url: string | undefined) =>
    url === undefined ? null : `${url.replace(/\/+$/, "")}${verify.healthPath}`;
  const environment = (
    name: EnvironmentName,
    url: string | undefined,
    offset: number,
  ): DeployEnvironment => ({
    name,
    url: url ?? null,
    healthUrl: health(url),
    onRelease: name !== "staging",
    hostPort: appPort + offset,
  });
  const list = [environment("staging", environments.staging.url, 1)];
  if (environments.preprod.enabled) {
    if (deploy.target === "vercel" && environments.preprod.url === undefined) {
      notes.push(
        "On Vercel, preprod points a domain at the release before production does, so it needs environments.preprod.url (a domain on your Vercel project). Without one, releases go from staging straight to production.",
      );
    } else {
      list.push(environment("preprod", environments.preprod.url, 2));
    }
  }
  list.push(environment("production", environments.production.url, 0));
  return {
    target: deploy.target,
    environments: list,
    appPort,
    healthPath: verify.healthPath,
    vps:
      deploy.target === "vps"
        ? {
            host: deploy.host,
            user: deploy.user,
            sshPort: deploy.port,
            path: deploy.path,
            sshKeySecret: deploy.sshKeySecret,
            knownHostsVariable: deploy.knownHostsVariable,
          }
        : null,
    vercel:
      deploy.target === "vercel"
        ? {
            tokenSecret: deploy.tokenSecret,
            orgIdVariable: deploy.orgIdVariable,
            projectIdVariable: deploy.projectIdVariable,
            bypassSecret: deploy.bypassSecret,
            writeConfig: vercelConfig(files, notes),
          }
        : null,
    previews: deploy.target === "vercel",
  };
}

/**
 * Vercel also deploys every push itself when the project is connected to the repo, which would
 * double every deploy. Returns true when init should write a vercel.json that turns that off.
 */
function vercelConfig(files: ProjectFiles, notes: string[]): boolean {
  const text = files.readText("vercel.json");
  if (text === null) return !files.exists("vercel.json");
  let gitDeploys: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    gitDeploys =
      isRecord(parsed) && isRecord(parsed.git) ? parsed.git.deploymentEnabled : undefined;
  } catch {
    gitDeploys = undefined;
  }
  if (gitDeploys !== false) {
    notes.push(
      'Add "git": { "deploymentEnabled": false } to vercel.json. Otherwise Vercel also deploys every push itself, next to the pipeline.',
    );
  }
  return false;
}

interface StarterInput {
  detection: Detection;
  files: ProjectFiles;
  language: Language;
  packageManager: PackageManager;
  runtimeVersion: string | undefined;
  install: string[];
  build: string | null;
  appPort: number;
  notes: string[];
}

/** Plan the starter Dockerfile, or return null when The Hollow cannot write one for this stack. */
export function planStarter(input: StarterInput): ContainerStarter | null {
  const { language, packageManager, notes } = input;
  if (packageManager === "bun") {
    notes.push(
      "The Hollow does not write a starter Dockerfile for Bun projects yet, so releases attach a source archive. Add a Dockerfile and run `hollow upgrade`.",
    );
    return null;
  }
  const baseImage = pickBaseImage(language, input.runtimeVersion, notes);
  const common = {
    language,
    packageManager,
    baseImage,
    appPort: input.appPort,
  };
  if (language === "node") {
    const start = input.detection.scripts.start ? ["npm", "start"] : null;
    if (start === null) {
      notes.push(
        'package.json has no "start" script, so the starter Dockerfile cannot tell how to run the app. Add one, or edit the CMD line in the Dockerfile.',
      );
    }
    return {
      ...common,
      install: input.install,
      build: input.build,
      prune:
        packageManager === "npm"
          ? "npm prune --omit=dev"
          : packageManager === "pnpm"
            ? "pnpm prune --prod"
            : null,
      corepack: packageManager === "pnpm" || packageManager === "yarn",
      requirements: null,
      lockfile: null,
      start,
    };
  }

  const { files } = input;
  const requirements =
    packageManager === "pip" && files.exists("requirements.txt") ? "requirements.txt" : null;
  const lockfile =
    packageManager === "uv" && files.exists("uv.lock")
      ? "uv.lock"
      : packageManager === "poetry" && files.exists("poetry.lock")
        ? "poetry.lock"
        : null;
  return {
    ...common,
    install: [],
    build: null,
    prune: null,
    corepack: false,
    requirements,
    lockfile,
    start: pythonStart(input.detection, files, input.appPort, notes),
  };
}

function pickBaseImage(language: Language, version: string | undefined, notes: string[]): ImagePin {
  const lines = BASE_IMAGES[language] as Record<string, ImagePin>;
  const wanted =
    version === undefined
      ? null
      : language === "node"
        ? (/(\d+)/.exec(version)?.[1] ?? null)
        : (/3\.(\d+)/.exec(version)?.[0] ?? null);
  const line = wanted !== null && lines[wanted] !== undefined ? wanted : DEFAULT_RUNTIME[language];
  if (wanted !== line) {
    const label = language === "node" ? "Node" : "Python";
    notes.push(
      `The starter Dockerfile uses ${label} ${line}${version === undefined ? ", since the project does not pin a version" : `, since there is no pinned base image for ${version}`}. Change the FROM lines if the app needs another version.`,
    );
  }
  return lines[line] as ImagePin;
}

/** Folders never searched for the app object. */
const SKIP_DIRS = new Set([
  "tests",
  "test",
  "migrations",
  "node_modules",
  "venv",
  "env",
  "site-packages",
  "__pycache__",
  "docs",
]);

/** Python files at the top level and one folder down, where an app object usually lives. */
function pythonFiles(files: ProjectFiles): string[] {
  const found: string[] = [];
  for (const entry of files.list(".")) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
    if (entry.endsWith(".py")) {
      found.push(entry);
      continue;
    }
    for (const inner of files.list(entry)) {
      if (inner.endsWith(".py")) found.push(`${entry}/${inner}`);
    }
  }
  return found.sort();
}

function moduleName(file: string): string {
  return file.replace(/\.py$/, "").split("/").join(".");
}

/** `module:variable` for the first `variable = <Constructor>(` found, or null. */
function findApp(files: ProjectFiles, className: string): string | null {
  const pattern = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*${className}\\(`, "m");
  for (const file of pythonFiles(files)) {
    const match = pattern.exec(files.readText(file) ?? "");
    if (match) return `${moduleName(file)}:${match[1]}`;
  }
  return null;
}

function pythonStart(
  detection: Detection,
  files: ProjectFiles,
  port: number,
  notes: string[],
): string[] | null {
  let pyproject: Record<string, unknown> | null = null;
  try {
    const text = files.readText("pyproject.toml");
    pyproject = text === null ? null : (parseToml(text) as Record<string, unknown>);
  } catch {
    pyproject = null;
  }
  const deps = collectDependencies(files, isRecord(pyproject) ? pyproject : null);
  const frameworks = detection.frameworks.map((f) => f.value);
  const bind = `0.0.0.0:${port}`;
  const missing = (server: string, framework: string) => {
    notes.push(
      `The starter Dockerfile runs ${framework} with ${server}, which is not in the project's dependencies yet. Add it, or edit the CMD line in the Dockerfile.`,
    );
  };

  if (frameworks.includes("django")) {
    const settings = /DJANGO_SETTINGS_MODULE["']\s*,\s*["']([A-Za-z0-9_.]+)\.settings["']/.exec(
      files.readText("manage.py") ?? "",
    )?.[1];
    if (settings !== undefined && files.exists(`${settings.split(".").join("/")}/wsgi.py`)) {
      if (!deps.has("gunicorn")) missing("gunicorn", "Django");
      return ["gunicorn", `${settings}.wsgi:application`, "--bind", bind];
    }
  } else if (frameworks.includes("fastapi") || frameworks.includes("starlette")) {
    const app = findApp(files, frameworks.includes("fastapi") ? "FastAPI" : "Starlette");
    if (app !== null) {
      if (!deps.has("uvicorn")) missing("uvicorn", "the app");
      return ["uvicorn", app, "--host", "0.0.0.0", "--port", String(port)];
    }
  } else if (frameworks.includes("flask")) {
    const app = findApp(files, "Flask");
    if (app !== null) {
      if (!deps.has("gunicorn")) missing("gunicorn", "Flask");
      return ["gunicorn", app, "--bind", bind];
    }
  }
  notes.push(
    "The Hollow could not tell how to start this app, so the starter Dockerfile's CMD line stops with a message. Edit it to run your server.",
  );
  return null;
}
