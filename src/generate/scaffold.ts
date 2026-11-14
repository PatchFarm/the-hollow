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

export const MIGRATIONS_GUIDE = "docs/migrations.md";

/** How the pipeline treats migrations here, and how to change a schema without downtime. */
export function renderMigrationsGuide(plan: PipelinePlan): string {
  const migrations = plan.migrations;
  if (migrations === null) return "";
  const { tool, label } = migrations;
  const deploy = migrations.deploy;
  const target = plan.deploy?.target;
  let deploys: string;
  if (deploy === null) {
    deploys =
      "Nothing in the pipeline migrates a deployed database for this project, so apply the migrations yourself before the new code goes live.";
  } else if (deploy.where === "image") {
    const tool = deploy.backup === "postgres" ? "pg_dump" : "mysqldump";
    deploys = `${deploy.backup === null ? "The server" : `The server first backs the database up with \`${tool}\`, then`} applies the migrations inside the new image, with the environment's \`.env\`, before starting it.${deploy.backup === null ? "" : " If the backup fails, nothing is migrated or deployed (except on the first deploy, which goes ahead with a warning)."}`;
  } else {
    const names = deploy.environments.join(", ");
    const why =
      target === "vercel"
        ? " Staging on Vercel is a staged production deployment, so it shares production's database: migrations run on release, before the new deployment serves any domain."
        : target === "cloudflare-workers"
          ? " A Worker's staging Version URL already uses production's bindings, so migrations run on release, right before production gets the new version."
          : "";
    deploys = `The deploy job applies the migrations to the ${names} database${deploy.environments.length === 1 ? "" : "s"} before the new code goes live, with ${deploy.environments.length === 1 ? "that" : "each"} environment's \`${deploy.secret}\` secret.${why}`;
  }
  const backups =
    deploy?.where === "image" && deploy.backup !== null && plan.deploy?.vps
      ? `
## Restoring a backup

Before each deploy migrates, the server saves a backup to \`${plan.deploy.vps.path.replace(/\/+$/, "")}/<environment>/backups/\` and keeps the newest seven. To restore one:

${
  deploy.backup === "postgres"
    ? `\`\`\`bash
pg_restore --clean --if-exists --no-owner --dbname "<database URL>" backups/<file>.dump
\`\`\`

Use a \`pg_restore\` at least as new as the one that made the backup (PostgreSQL 18).`
    : `\`\`\`bash
mysql --host <host> --user <user> --password <database> < backups/<file>.sql
\`\`\``
}

Stop the app first, and restore the code that matches the backup too.
`
      : "";
  return `# Database migrations

<!-- Created by The Hollow as a starting point: edit freely. \`hollow upgrade\` never changes it. -->

This project's migrations use **${tool}**. The pipeline handles them in three places:

1. **Pull requests.** CI applies every migration to a throwaway database, so a migration that does not run never merges. The Migration safety check reads new migrations and fails on changes that break the code already running, unless the pull request has the \`${label}\` label.
2. **Deploys.** ${deploys} If the migrations fail, the deploy stops and the previous version keeps running.
3. **Rollbacks.** When a deploy fails its health check, the pipeline puts the previous code back. It does not undo migrations: the database stays migrated, so every migration has to work with both the old code and the new.

## Expand, migrate, contract

During a deploy the old code keeps running against the new schema for a while, and after a rollback it runs there again. So change the schema in steps that are each safe for whatever code is running:

1. **Expand.** Add what the new code needs (a column, a table, an index) without removing or changing anything the old code uses. Release it.
2. **Migrate.** Release code that writes to both the old and the new place, backfill the existing rows, then switch reads to the new place.
3. **Contract.** Once no running code uses the old column or table, drop it in a later release. This is the step that needs the \`${label}\` label.

| Change | Safe way |
|---|---|
| Rename a column or table | Add the new one, write to both, backfill, read from the new one, then drop the old one in a later release. |
| Drop a column or table | Stop using it in the code and release that. Drop it in a later release. |
| Change a column's type | Add a column with the new type, backfill, switch to it, then drop the old one. |
| Make a column NOT NULL | Backfill every row and make the code always write it, then add the constraint. |
| Add a NOT NULL column | Give it a default, or add it as nullable, backfill, then make it NOT NULL. |

When a contract step is ready, add the \`${label}\` label to its pull request. The Migration safety check then reports the change as a warning and passes.
${backups}`;
}
