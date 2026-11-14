import type { PipelinePlan } from "../pipeline/plan.js";
import { HOOKS } from "./pins.js";
import { renderGenerated } from "./render.js";

export const PRE_COMMIT_CONFIG = ".pre-commit-config.yaml";

/** File types each language's lint and format hooks run on. */
const FILE_TYPES = {
  node: ["javascript", "jsx", "ts", "tsx"],
  python: ["python"],
} as const;

/**
 * `.pre-commit-config.yaml` for https://pre-commit.com: Gitleaks on staged changes, plus the
 * project's own lint and format checks, the same commands CI runs. Only fast checks: type checks,
 * tests and builds stay in CI and `hollow check`.
 */
export function renderPreCommit(plan: PipelinePlan): string {
  const local = plan.checks
    .filter((check) => check.id === "lint" || check.id === "format")
    .map((check) => ({
      id: `hollow-${check.id}`,
      name: check.name,
      entry: check.run,
      language: "system",
      pass_filenames: false,
      types_or: [...FILE_TYPES[plan.language]],
    }));

  const repos: Record<string, unknown>[] = [
    { repo: HOOKS.gitleaks.repo, rev: HOOKS.gitleaks.rev, hooks: [{ id: "gitleaks" }] },
  ];
  if (local.length > 0) repos.push({ repo: "local", hooks: local });

  return renderGenerated(
    { repos },
    {
      about: [
        "Set up once per clone: pipx install pre-commit && pre-commit install",
        "Hook repositories are pinned to commit SHAs (pre-commit autoupdate --freeze style).",
      ],
    },
  );
}
