import { expr, renderGenerated } from "./render.js";

export const PR_TITLE_WORKFLOW = ".github/workflows/pr-title.yml";

/** Conventional Commit types accepted in pull request titles. */
export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

/** `type(scope)!: summary`, with the scope and `!` optional. */
export const TITLE_PATTERN = `^(${COMMIT_TYPES.join("|")})(\\([A-Za-z0-9._/-]+\\))?!?: [^ ].*$`;

/**
 * `.github/workflows/pr-title.yml`: pull request titles must be Conventional Commits, because
 * squash merges turn the title into the commit message that versioning and the changelog read.
 * Plain shell, no third-party action, and the title reaches the script through `env:` so a
 * crafted title cannot inject commands.
 */
export function renderPrTitleWorkflow(): string {
  const workflow = {
    name: "PR title",
    on: { pull_request: { types: ["opened", "edited", "reopened", "synchronize"] } },
    permissions: {},
    jobs: {
      "conventional-title": {
        name: "Conventional Commit title",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 2,
        permissions: {},
        steps: [
          {
            name: "Check the title",
            env: {
              TITLE: expr("github.event.pull_request.title"),
              PATTERN: TITLE_PATTERN,
            },
            run: [
              'if printf \'%s\' "$TITLE" | grep --quiet --extended-regexp "$PATTERN"; then',
              '  echo "Title OK: $TITLE"',
              "else",
              `  echo "::error title=PR title::Start the title with a Conventional Commit type, for example \\"feat: add login\\" or \\"fix(api): handle timeouts\\". Allowed types: ${COMMIT_TYPES.join(", ")}."`,
              "  exit 1",
              "fi",
              "",
            ].join("\n"),
          },
        ],
      },
    },
  };
  return renderGenerated(workflow, {
    about: [
      "Pull request titles become commit messages on merge, and releases are versioned from them.",
    ],
    comments: { permissions: "Reads only the event payload, so it needs no token permissions." },
  });
}
