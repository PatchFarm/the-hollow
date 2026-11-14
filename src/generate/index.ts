import type { PipelinePlan } from "../pipeline/plan.js";
import { CI_WORKFLOW, renderCiWorkflow } from "./ci.js";
import { DEPENDABOT_CONFIG, renderDependabot } from "./dependabot.js";

export interface GeneratedFile {
  /** Path relative to the project root, with forward slashes. */
  path: string;
  content: string;
  /** Workflow files get checked with actionlint. */
  workflow: boolean;
}

/** Every file The Hollow owns for this plan. Pure: same plan, same bytes. */
export function generateFiles(plan: PipelinePlan): GeneratedFile[] {
  return [
    { path: CI_WORKFLOW, content: renderCiWorkflow(plan), workflow: true },
    { path: DEPENDABOT_CONFIG, content: renderDependabot(plan), workflow: false },
  ];
}
