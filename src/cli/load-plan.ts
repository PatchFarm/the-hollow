import { CONFIG_FILE, loadConfig } from "../config/load.js";
import type { HollowConfig } from "../config/schema.js";
import { type Detection, detectProject } from "../detect/index.js";
import { type PipelinePlan, planPipeline } from "../pipeline/plan.js";

export interface LoadedPlan {
  detection: Detection;
  config: HollowConfig;
  plan: PipelinePlan;
}

/**
 * Detect the project, load hollow.yml and plan the pipeline, for commands that need all three.
 * Reports what went wrong and returns null when any step fails.
 */
export function loadPlan(dir: string, stderr: (text: string) => void): LoadedPlan | null {
  let detection: Detection;
  try {
    detection = detectProject(dir);
  } catch (error) {
    stderr(`${(error as Error).message}\n`);
    return null;
  }
  const config = loadConfig(detection.root);
  if (config.status === "missing") {
    stderr(`No ${CONFIG_FILE} here. Run \`hollow init\` first.\n`);
    return null;
  }
  if (config.status === "invalid") {
    stderr(`${CONFIG_FILE} is invalid:\n${config.errors.map((e) => `  - ${e}`).join("\n")}\n`);
    return null;
  }
  const pipeline = planPipeline(detection, config.config);
  if (pipeline.status === "error") {
    stderr(`${pipeline.error}\n`);
    return null;
  }
  return { detection, config: config.config, plan: pipeline.plan };
}
