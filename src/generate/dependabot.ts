import type { PipelinePlan } from "../pipeline/plan.js";
import { CI_WORKFLOW } from "./ci.js";
import { RELEASE_WORKFLOW } from "./release.js";
import { renderGenerated } from "./render.js";

export const DEPENDABOT_CONFIG = ".github/dependabot.yml";

/**
 * `.github/dependabot.yml`: weekly grouped updates for the app's dependencies, its GitHub
 * Actions and its base image, each held back seven days after release (a supply-chain cooldown).
 */
export function renderDependabot(plan: PipelinePlan): string {
  const updates: Record<string, unknown>[] = [];
  // Conventional Commit titles ("build(deps): bump ...") so Dependabot's PRs pass the PR title
  // check and land in the changelog under the right heading.
  const entry = (ecosystem: string, extra: Record<string, unknown> = {}) => ({
    "package-ecosystem": ecosystem,
    directory: "/",
    "commit-message": {
      prefix: ecosystem === "github-actions" ? "ci" : "build",
      include: "scope",
    },
    schedule: { interval: "weekly" },
    cooldown: { "default-days": 7 },
    "open-pull-requests-limit": 5,
    groups: { [ecosystem]: { patterns: ["*"], "update-types": ["minor", "patch"] } },
    ...extra,
  });

  updates.push(entry(appEcosystem(plan)));
  // The Hollow owns the pins in its own workflows; `hollow upgrade` updates them, so Dependabot
  // leaves those files alone and still covers every other workflow.
  updates.push(
    entry("github-actions", {
      "exclude-paths": plan.release === null ? [CI_WORKFLOW] : [CI_WORKFLOW, RELEASE_WORKFLOW],
    }),
  );
  if (plan.dockerfile !== null) updates.push(entry("docker"));

  return renderGenerated(
    { version: 2, updates },
    {
      about: [
        "Weekly grouped updates. Each release waits 7 days before Dependabot proposes it.",
        "The Hollow's own workflows are excluded: their pins change through `hollow upgrade`.",
      ],
    },
  );
}

function appEcosystem(plan: PipelinePlan): string {
  switch (plan.packageManager) {
    case "bun":
      return "bun";
    case "uv":
      return "uv";
    case "pip":
    case "poetry":
      return "pip";
    default:
      return "npm";
  }
}
