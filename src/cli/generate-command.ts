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
    `Once it passes, require the "CI passed" and "Conventional Commit title" checks in branch protection for ${plan.defaultBranch}.`,
  ];
  if (plan.existingHooks === null) {
    steps.push(
      "Turn on the git hooks in each clone: pipx install pre-commit && pre-commit install",
    );
  }
  if (plan.release !== null) {
    steps.push(
      "Let GitHub Actions create pull requests (Settings > Actions > General), so release-please can open its release PR.",
      `Optional: add a fine-grained token with Contents and Pull requests write access as the ${plan.release.tokenSecret} secret, so CI also runs on release PRs.`,
    );
  }
  options.stdout(`\nNext steps\n${steps.map((step, i) => `  ${i + 1}. ${step}`).join("\n")}\n`);
}
