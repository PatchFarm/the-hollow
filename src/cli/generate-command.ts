import { CONFIG_FILE, loadConfig } from "../config/load.js";
import { type HollowConfig, hollowConfigSchema } from "../config/schema.js";
import { type Detection, detectProject } from "../detect/index.js";
import { renderHollowYml } from "../generate/hollow-yml.js";
import { type GeneratedFile, generateFiles } from "../generate/index.js";
import { isGenerated } from "../generate/render.js";
import { type PipelinePlan, planPipeline } from "../pipeline/plan.js";
import { ProjectFiles } from "../util/project-files.js";
import { writeProjectFile } from "../util/project-writer.js";
import { actionlint } from "../verify/actionlint.js";
import { type Ask, interview } from "./interview.js";

export interface GenerateOptions {
  dir: string;
  force: boolean;
  dryRun: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface InitOptions extends GenerateOptions {
  target?: string | undefined;
  yes: boolean;
  ask?: Ask | undefined;
}

type Change = "create" | "update" | "unchanged" | "kept";

/**
 * `hollow init`: detect, interview, write hollow.yml, and generate the CI files from it.
 * An existing valid hollow.yml is kept and used as is.
 */
export async function init(options: InitOptions): Promise<number> {
  const detection = detect(options);
  if (detection === null) return 1;
  if (detection.language === null) {
    options.stderr(
      "Could not tell what kind of project this is. The Hollow supports Node/TypeScript and Python.\n",
    );
    return 1;
  }

  const existing = loadConfig(detection.root);
  let config: HollowConfig;
  const extra: GeneratedFile[] = [];
  if (existing.status === "invalid") {
    reportInvalid(existing.errors, options);
    return 1;
  }
  if (existing.status === "ok") {
    options.stdout(`Using the existing ${CONFIG_FILE}.\n`);
    config = existing.config;
  } else {
    const answers = await interview({
      detection,
      target: options.target,
      yes: options.yes,
      ask: options.ask,
      say: options.stdout,
    });
    if (answers.status === "error") {
      options.stderr(`${answers.error}\n`);
      return 1;
    }
    const parsed = hollowConfigSchema.safeParse(answers.config);
    if (!parsed.success) {
      reportInvalid(
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        options,
      );
      return 1;
    }
    config = parsed.data;
    extra.push({
      path: CONFIG_FILE,
      content: renderHollowYml(answers.config),
      // Written only because it is missing; the developer owns it from here on.
      kind: "scaffold",
      workflow: false,
    });
  }

  const plan = makePlan(detection, config, options);
  if (plan === null) return 1;
  const files = [...extra, ...generateFiles(plan)];
  const code = apply(detection.root, files, options);
  if (code === 0 && !options.dryRun) printNextSteps(plan, options);
  return code;
}

/**
 * `hollow upgrade`: regenerate every file The Hollow owns from hollow.yml. Starting-point files
 * (PR template, CODEOWNERS, .editorconfig) belong to the developer, so upgrade leaves them out;
 * `hollow init` adds any that are missing.
 */
export function upgrade(options: GenerateOptions): number {
  const detection = detect(options);
  if (detection === null) return 1;
  const existing = loadConfig(detection.root);
  if (existing.status === "missing") {
    options.stderr(`No ${CONFIG_FILE} here. Run \`hollow init\` first.\n`);
    return 1;
  }
  if (existing.status === "invalid") {
    reportInvalid(existing.errors, options);
    return 1;
  }
  const plan = makePlan(detection, existing.config, options);
  if (plan === null) return 1;
  const files = generateFiles(plan).filter((file) => file.kind !== "scaffold");
  const code = apply(detection.root, files, options);
  if (code === 0 && !options.dryRun) printNotes(plan, options);
  return code;
}

function detect(options: GenerateOptions): Detection | null {
  try {
    return detectProject(options.dir);
  } catch (error) {
    options.stderr(`${(error as Error).message}\n`);
    return null;
  }
}

function makePlan(
  detection: Detection,
  config: HollowConfig,
  options: GenerateOptions,
): PipelinePlan | null {
  const result = planPipeline(detection, config);
  if (result.status === "error") {
    options.stderr(`${result.error}\n`);
    return null;
  }
  return result.plan;
}

function reportInvalid(errors: string[], options: GenerateOptions): void {
  options.stderr(`${CONFIG_FILE} is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
}

/**
 * Check every file before writing any: refuse to overwrite files The Hollow did not write (unless
 * --force), lint workflows, then write. Either everything is written or nothing is.
 */
function apply(root: string, files: GeneratedFile[], options: GenerateOptions): number {
  const project = new ProjectFiles(root);
  const changes = new Map<string, Change>();
  const conflicts: string[] = [];
  for (const file of files) {
    if (!project.exists(file.path)) {
      changes.set(file.path, "create");
      continue;
    }
    const current = project.readText(file.path);
    if (current === file.content) {
      changes.set(file.path, "unchanged");
    } else if (file.kind === "scaffold") {
      changes.set(file.path, "kept");
    } else if (current !== null && isGenerated(current)) {
      changes.set(file.path, "update");
    } else if (options.force) {
      changes.set(file.path, "update");
    } else if (file.kind === "generated-optional") {
      changes.set(file.path, "kept");
    } else {
      conflicts.push(file.path);
    }
  }
  if (conflicts.length > 0) {
    options.stderr(
      `These files already exist and were not written by The Hollow:\n${conflicts
        .map((path) => `  - ${path}`)
        .join(
          "\n",
        )}\nMove them aside (or merge what you need into hollow.yml), or run again with --force to replace them.\nNothing was written.\n`,
    );
    return 1;
  }

  let lintSkipped = false;
  for (const file of files) {
    if (!file.workflow) continue;
    const result = actionlint(file.path, file.content, root);
    if (result.status === "unavailable") lintSkipped = true;
    if (result.status === "failed") {
      options.stderr(
        `actionlint rejected the generated ${file.path}. This is a bug in The Hollow, please report it at https://github.com/PatchFarm/the-hollow/issues\n\n${result.output}\n\nNothing was written.\n`,
      );
      return 1;
    }
  }

  for (const file of files) {
    const change = changes.get(file.path) ?? "unchanged";
    const writes = change === "create" || change === "update";
    if (!options.dryRun && writes) writeProjectFile(root, file.path, file.content);
    const label = options.dryRun && writes ? `would ${change}` : change;
    const why = change === "kept" ? "  (yours, left as is)" : "";
    options.stdout(`  ${label.padEnd(14)} ${file.path}${why}\n`);
  }
  if (lintSkipped) {
    options.stdout(
      "\nactionlint is not installed, so the workflow was not linted on this machine. The Hollow's own tests lint every template; install actionlint to check here too.\n",
    );
  }
  return 0;
}

function printNotes(plan: PipelinePlan, options: GenerateOptions): void {
  if (plan.notes.length === 0) return;
  options.stdout(`\nWorth knowing\n${plan.notes.map((note) => `  - ${note}`).join("\n")}\n`);
}

function printNextSteps(plan: PipelinePlan, options: GenerateOptions): void {
  printNotes(plan, options);
  const steps = [
    "Review the new files (git status, git diff).",
    'Commit them on a branch and open a pull request with a Conventional Commit title, such as "ci: add The Hollow pipeline". The pipeline runs on that pull request.',
    `Once it is merged, run \`npx the-hollow protect\` to protect ${plan.defaultBranch}: it shows the branch rules, environments and security settings it would apply on GitHub, and asks before changing anything.`,
  ];
  if (plan.existingHooks === null) {
    steps.push(
      "Turn on the git hooks in each clone: pipx install pre-commit && pre-commit install",
    );
  }
  const deploy = plan.deploy;
  if (deploy?.vps) {
    const vps = deploy.vps;
    const ports = deploy.environments
      .map((environment) => `127.0.0.1:${environment.hostPort} (${environment.name})`)
      .join(", ");
    steps.push(
      `Prepare ${vps.host}: Docker with Compose 2.24 or newer, a ${vps.user} user allowed to run docker, and a reverse proxy that sends each domain to ${ports}.`,
      `Make an SSH key for deploys and add its public key to ${vps.user}'s ~/.ssh/authorized_keys. In each environment on GitHub (Settings > Environments), add the private key as the ${vps.sshKeySecret} secret and the output of \`ssh-keyscan -p ${vps.sshPort} ${vps.host}\` as the ${vps.knownHostsVariable} variable.`,
    );
  } else if (deploy?.vercel) {
    const vercel = deploy.vercel;
    steps.push(
      `Link the Vercel project: run \`npx vercel link\`, then add the orgId and projectId from .vercel/project.json as the ${vercel.orgIdVariable} and ${vercel.projectIdVariable} repository variables, and a Vercel token as the ${vercel.tokenSecret} secret (Settings > Secrets and variables > Actions).`,
      `Optional: turn on Protection Bypass for Automation in the Vercel project and add its value as the ${vercel.bypassSecret} secret, so health checks can reach protected deployment URLs. Without it, a protected URL only shows the deployment is reachable.`,
      "Staging is a production build that is not live yet, so it uses production's Vercel environment variables. Pull request previews use the Preview ones.",
    );
  } else if (deploy?.cloudflare) {
    const cf = deploy.cloudflare;
    steps.push(
      `Add a Cloudflare API token as the ${cf.tokenSecret} secret and your account ID as the ${cf.accountIdVariable} variable (Settings > Secrets and variables > Actions). The token needs ${cf.kind === "workers" ? "Workers Scripts: Edit" : "Cloudflare Pages: Edit"}.`,
      cf.kind === "workers"
        ? "Turn on Version URLs (preview_urls = true in the Wrangler config) so staging can be checked. Staging runs the production Worker's version, so it uses production's bindings and data, and its URL is public unless the Worker is behind Cloudflare Access."
        : `Create the ${cf.projectName} Pages project with ${plan.defaultBranch} as its production branch. Staging deploys to its staging branch (staging.${cf.projectName}.pages.dev), which uses the project's preview variables.`,
    );
  } else if (deploy !== null) {
    steps.push(
      "Every merge publishes the image and points its :staging tag at it; each release moves :production. Point whatever runs the container at those tags.",
    );
  }
  if (deploy?.environments.some((environment) => environment.healthUrl === null)) {
    const missing = deploy.environments
      .filter((environment) => environment.healthUrl === null)
      .map((environment) => environment.name)
      .join(", ");
    steps.push(
      `Set environments.<name>.url in hollow.yml for ${missing} and run \`hollow upgrade\`, so each deploy is checked and rolled back if it fails.`,
    );
  }
  if (plan.release !== null) {
    steps.push(
      "Then run `npx the-hollow secrets` to see which secrets and variables the pipeline still needs in each environment, and set them (values are hidden and go straight to GitHub).",
    );
  }
  if (deploy !== null) {
    steps.push(
      "Production deploys after the production environment's required reviewers approve (`hollow protect` sets them up). Where GitHub has none (private repos without Enterprise), a release waits instead, and running `gh workflow run release.yml -f version=<tag>` (or the Release workflow in the Actions tab) is the approval.",
    );
  }
  if (plan.release?.artifact.kind === "image" && plan.release.artifact.starter !== null) {
    steps.push(
      "Check the starter Dockerfile: build and run it once with `docker build -t app . && docker run --rm -p 8080:" +
        `${plan.release.artifact.starter.appPort} app\`.`,
    );
  }
  if (plan.release !== null) {
    steps.push(
      `Optional: add a fine-grained token with Contents and Pull requests write access as the ${plan.release.tokenSecret} secret, so CI also runs on release PRs.`,
    );
  }
  options.stdout(`\nNext steps\n${steps.map((step, i) => `  ${i + 1}. ${step}`).join("\n")}\n`);
}
