import type { PipelinePlan } from "../pipeline/plan.js";
import { CI_WORKFLOW, renderCiWorkflow } from "./ci.js";
import { DEPENDABOT_CONFIG, renderDependabot } from "./dependabot.js";
import { PR_TITLE_WORKFLOW, renderPrTitleWorkflow } from "./pr-title.js";
import { PRE_COMMIT_CONFIG, renderPreCommit } from "./pre-commit.js";
import { RELEASE_WORKFLOW, renderReleaseWorkflow } from "./release.js";
import {
  CODEOWNERS,
  EDITORCONFIG,
  PR_TEMPLATE,
  renderCodeowners,
  renderEditorconfig,
  renderPrTemplate,
} from "./scaffold.js";

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
  return files;
}
