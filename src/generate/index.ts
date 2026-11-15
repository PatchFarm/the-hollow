import { DEPLOY_COMPOSE } from "../pipeline/deploy.js";
import type { PipelinePlan } from "../pipeline/plan.js";
import { CI_WORKFLOW, renderCiWorkflow } from "./ci.js";
import { renderPagesPreview } from "./cloudflare.js";
import { DEPENDABOT_CONFIG, renderDependabot } from "./dependabot.js";
import {
  DOCKERFILE,
  DOCKERIGNORE,
  renderDeployCompose,
  renderDockerfile,
  renderDockerignore,
} from "./dockerfile.js";
import { MIGRATION_CHECKER, renderMigrationChecker } from "./migration-check.js";
import { MIGRATIONS_WORKFLOW, renderMigrationsWorkflow } from "./migrations.js";
import { PIPELINE_DOC, renderPipelineDoc } from "./pipeline-doc.js";
import { PR_TITLE_WORKFLOW, renderPrTitleWorkflow } from "./pr-title.js";
import { PRE_COMMIT_CONFIG, renderPreCommit } from "./pre-commit.js";
import { RELEASE_WORKFLOW, renderReleaseWorkflow } from "./release.js";
import {
  CODEOWNERS,
  EDITORCONFIG,
  MIGRATIONS_GUIDE,
  PR_TEMPLATE,
  renderCodeowners,
  renderEditorconfig,
  renderMigrationsGuide,
  renderPrTemplate,
} from "./scaffold.js";
import { hasSchedule, renderScheduledWorkflow, SCHEDULED_WORKFLOW } from "./scheduled.js";
import {
  PREVIEW_WORKFLOW,
  renderPreviewWorkflow,
  renderVercelJson,
  VERCEL_JSON,
} from "./vercel.js";

/**
 * Who owns a file, which decides what `init` and `upgrade` may do with it:
 * - `generated`: The Hollow owns it and regenerates it. A file at that path that The Hollow did
 *   not write is a conflict.
 * - `generated-optional`: the same, except a file The Hollow did not write is left alone (the
 *   project already has its own, for example its own pre-commit config).
 * - `scaffold`: a starting point the developer owns. Written once if missing, never overwritten.
 */
export type FileKind = "generated" | "generated-optional" | "scaffold";

export interface GeneratedFile {
  /** Path relative to the project root, with forward slashes. */
  path: string;
  content: string;
  kind: FileKind;
  /** Workflow files get checked with actionlint. */
  workflow: boolean;
}

/** Every file The Hollow produces for this plan. Pure: same plan, same bytes. */
export function generateFiles(plan: PipelinePlan): GeneratedFile[] {
  const files: GeneratedFile[] = [
    { path: CI_WORKFLOW, content: renderCiWorkflow(plan), kind: "generated", workflow: true },
    {
      path: PR_TITLE_WORKFLOW,
      content: renderPrTitleWorkflow(),
      kind: "generated",
      workflow: true,
    },
    ...(plan.release === null
      ? []
      : [
          {
            path: RELEASE_WORKFLOW,
            content: renderReleaseWorkflow(plan, plan.release),
            kind: "generated" as const,
            workflow: true,
          },
        ]),
    {
      path: DEPENDABOT_CONFIG,
      content: renderDependabot(plan),
      kind: "generated",
      workflow: false,
    },
  ];
  if (plan.existingHooks === null) {
    files.push({
      path: PRE_COMMIT_CONFIG,
      content: renderPreCommit(plan),
      kind: "generated-optional",
      workflow: false,
    });
  }
  files.push(
    { path: EDITORCONFIG, content: renderEditorconfig(plan), kind: "scaffold", workflow: false },
    { path: PR_TEMPLATE, content: renderPrTemplate(), kind: "scaffold", workflow: false },
    { path: CODEOWNERS, content: renderCodeowners(), kind: "scaffold", workflow: false },
  );
  const artifact = plan.release?.artifact;
  if (artifact?.kind === "image" && artifact.starter !== null) {
    files.push(
      {
        path: DOCKERFILE,
        content: renderDockerfile(artifact.starter),
        kind: "scaffold",
        workflow: false,
      },
      {
        path: DOCKERIGNORE,
        content: renderDockerignore(artifact.starter),
        kind: "scaffold",
        workflow: false,
      },
    );
  }
  if (plan.migrations !== null) {
    files.splice(2, 0, {
      path: MIGRATIONS_WORKFLOW,
      content: renderMigrationsWorkflow(plan.migrations),
      kind: "generated",
      workflow: true,
    });
    files.push({
      path: MIGRATION_CHECKER,
      content: renderMigrationChecker(),
      kind: "generated",
      workflow: false,
    });
    files.push({
      path: MIGRATIONS_GUIDE,
      content: renderMigrationsGuide(plan),
      kind: "scaffold",
      workflow: false,
    });
  }
  const cloudflare = plan.deploy?.cloudflare;
  if (cloudflare?.kind === "pages") {
    files.splice(3, 0, {
      path: PREVIEW_WORKFLOW,
      content: renderPagesPreview(plan, cloudflare),
      kind: "generated",
      workflow: true,
    });
  }
  const vercel = plan.deploy?.vercel;
  if (vercel) {
    files.splice(3, 0, {
      path: PREVIEW_WORKFLOW,
      content: renderPreviewWorkflow(plan, vercel),
      kind: "generated",
      workflow: true,
    });
    if (vercel.writeConfig) {
      files.push({
        path: VERCEL_JSON,
        content: renderVercelJson(),
        kind: "scaffold",
        workflow: false,
      });
    }
  }
  if (plan.deploy?.vps) {
    files.push({
      path: DEPLOY_COMPOSE,
      content: renderDeployCompose(plan.deploy, plan.language),
      kind: "scaffold",
      workflow: false,
    });
  }
  if (hasSchedule(plan)) {
    files.push({
      path: SCHEDULED_WORKFLOW,
      content: renderScheduledWorkflow(plan),
      kind: "generated",
      workflow: true,
    });
  }
  files.push({
    path: PIPELINE_DOC,
    content: renderPipelineDoc(plan),
    kind: "generated",
    workflow: false,
  });
  return files;
}
