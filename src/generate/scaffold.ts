import type { PipelinePlan } from "../pipeline/plan.js";
import { COMMIT_TYPES } from "./pr-title.js";

/**
 * Starting points the developer owns. `hollow init` writes each one only if it is missing and
 * never touches it again, so these carry no "generated" marker.
 */

export const EDITORCONFIG = ".editorconfig";
export const PR_TEMPLATE = ".github/pull_request_template.md";
export const CODEOWNERS = ".github/CODEOWNERS";

export function renderEditorconfig(plan: PipelinePlan): string {
  const indent = plan.language === "python" ? 4 : 2;
  return `# https://editorconfig.org (created by The Hollow; edit freely)
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = ${indent}

[*.{yml,yaml,json}]
indent_size = 2

[*.md]
trim_trailing_whitespace = false

[Makefile]
indent_style = tab
`;
}

export function renderPrTemplate(): string {
  return `<!--
Title: use a Conventional Commit, for example "feat: add login" or "fix(api): handle timeouts".
Allowed types: ${COMMIT_TYPES.join(", ")}. The title becomes the commit message and the changelog entry.
-->

## What and why


## How it was tested


## Checklist

- [ ] Tests cover the change (or it needs none, and the reason is above)
- [ ] No secrets, tokens or credentials in the code or the history
- [ ] Database migrations, if any, are safe to run before the new code goes live
`;
}

export function renderCodeowners(): string {
  return `# Who must review changes to which paths. https://docs.github.com/articles/about-code-owners
# Created by The Hollow as a starting point: uncomment and edit, then require code owner review
# in branch protection if you want it enforced.
#
# Everything:
# *                     @your-username
#
# The pipeline and its config deserve a careful reviewer:
# /.github/             @your-username
# /hollow.yml           @your-username
`;
}
