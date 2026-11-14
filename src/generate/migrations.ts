import type { MigrationPlan } from "../pipeline/migrations.js";
import { checkout, lines } from "./ci.js";
import { MIGRATION_CHECKER } from "./migration-check.js";
import { expr, renderGenerated } from "./render.js";

export const MIGRATIONS_WORKFLOW = ".github/workflows/migrations.yml";
/** Job name, and so the check name branch protection requires. */
export const MIGRATION_CHECK = "Migration safety";

/**
 * `.github/workflows/migrations.yml`: checks the migration files each pull request adds or
 * changes for destructive changes. Its own workflow, so adding or removing the override label
 * re-runs just this check, not all of CI.
 */
export function renderMigrationsWorkflow(migrations: MigrationPlan): string {
  // GitHub expressions escape a single quote by doubling it.
  const label = migrations.label.replaceAll("'", "''");
  const quoted = migrations.paths.map((pattern) => `'${pattern}'`).join(" ");
  const workflow = {
    name: MIGRATION_CHECK,
    on: {
      pull_request: { types: ["opened", "synchronize", "reopened", "labeled", "unlabeled"] },
    },
    permissions: {},
    concurrency: {
      group: `migrations-${expr("github.event.pull_request.number")}`,
      "cancel-in-progress": true,
    },
    jobs: {
      migrations: {
        name: MIGRATION_CHECK,
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        permissions: { contents: "read", "pull-requests": "read" },
        steps: [
          checkout(),
          {
            name: `Check new ${migrations.tool} migrations for destructive changes`,
            env: {
              GH_TOKEN: expr("github.token"),
              PR: expr("github.event.pull_request.number"),
              OVERRIDE: expr(`contains(github.event.pull_request.labels.*.name, '${label}')`),
              LABEL: migrations.label,
            },
            run: lines([
              'gh api "repos/$GITHUB_REPOSITORY/pulls/$PR/files" --paginate --jq \'.[] | select(.status != "removed") | .filename\' > "$RUNNER_TEMP/changed.txt"',
              `python3 ${MIGRATION_CHECKER} ${migrations.tool} ${quoted} < "$RUNNER_TEMP/changed.txt"`,
            ]),
          },
        ],
      },
    },
  };
  return renderGenerated(workflow, {
    about: [
      `Fails a pull request whose new migrations drop, rename or tighten what running code still uses, unless it has the "${migrations.label}" label.`,
    ],
    comments: { concurrency: "A new push or label change replaces the check that was running." },
  });
}
