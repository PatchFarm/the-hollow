import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type HollowConfigInput, hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { CI_WORKFLOW } from "../src/generate/ci.js";
import { generateFiles } from "../src/generate/index.js";
import { MIGRATION_CHECKER, renderMigrationChecker } from "../src/generate/migration-check.js";
import { MIGRATION_CHECK, MIGRATIONS_WORKFLOW } from "../src/generate/migrations.js";
import { expr } from "../src/generate/render.js";
import { type PipelinePlan, planPipeline } from "../src/pipeline/plan.js";
import { FakeGitHub, fakeState } from "./fake-github.js";
import { copyFixture, fixture, runCli, tempProject } from "./helpers.js";

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, { name?: string; permissions?: unknown; steps: Step[] }>;
};

function plan(dir: string, extra: Partial<HollowConfigInput> = {}): PipelinePlan {
  const config = hollowConfigSchema.parse({ version: 1, deploy: { target: "docker" }, ...extra });
  const result = planPipeline(detectProject(dir), config);
  if (result.status !== "ok") throw new Error(result.error);
  return result.plan;
}

const file = (p: PipelinePlan, filePath: string) =>
  generateFiles(p).find((f) => f.path === filePath);
const buildSteps = (p: PipelinePlan) =>
  (parse(file(p, CI_WORKFLOW)?.content ?? "") as Workflow).jobs.build?.steps ?? [];

describe("migration planning", () => {
  it("knows how each tool applies migrations and where their files live", () => {
    expect(plan(fixture("node-next-prisma")).migrations).toMatchObject({
      tool: "prisma",
      apply: "npm exec --no -- prisma migrate deploy",
      paths: ["prisma/migrations/*/migration.sql"],
      appliesInCi: true,
    });
    expect(plan(fixture("python-fastapi")).migrations).toMatchObject({
      tool: "alembic",
      apply: "uv run --no-sync alembic upgrade head",
      paths: ["migrations/versions/*.py"],
    });
    expect(plan(fixture("python-django")).migrations).toMatchObject({
      tool: "django",
      apply: "python manage.py migrate --noinput",
      missingCheck: "python manage.py makemigrations --check --dry-run",
      paths: ["*migrations/[0-9]*.py"],
    });
  });

  it("reads Drizzle's out folder and Alembic's script_location", () => {
    const drizzle = tempProject({
      "package.json": JSON.stringify({
        name: "d",
        devDependencies: { "drizzle-kit": "1.0.0" },
        dependencies: { pg: "8.0.0" },
      }),
      "package-lock.json": "{}",
      "drizzle.config.ts":
        'export default { dialect: "postgresql", out: "./db/migrations", schema: "./src/schema.ts" };\n',
    });
    expect(plan(drizzle).migrations).toMatchObject({
      tool: "drizzle",
      apply: "npm exec --no -- drizzle-kit migrate",
      paths: ["db/migrations/*.sql"],
    });

    const alembic = tempProject({
      "requirements.txt": "alembic\npsycopg\n",
      "alembic.ini": "[alembic]\nscript_location = %(here)s/db/alembic\n",
    });
    expect(plan(alembic).migrations?.paths).toEqual(["db/alembic/versions/*.py"]);
  });

  it("honours database.migrations and the override label from hollow.yml", () => {
    expect(
      plan(fixture("node-next-prisma"), { database: { migrations: "none" } }).migrations,
    ).toBeNull();
    expect(
      plan(fixture("node-next-prisma"), { database: { destructiveChangeLabel: "schema-break" } })
        .migrations?.label,
    ).toBe("schema-break");
  });

  it("uses a throwaway SQLite file in CI for SQLite projects, and says when there is no database", () => {
    const sqlite = tempProject({
      "package.json": JSON.stringify({ name: "s", dependencies: { "@prisma/client": "6.0.0" } }),
      "package-lock.json": "{}",
      "prisma/schema.prisma":
        'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n',
    });
    const sqlitePlan = plan(sqlite);
    expect(sqlitePlan.migrations?.ciEnv).toEqual({ DATABASE_URL: "file:./hollow-ci.db" });
    expect(buildSteps(sqlitePlan).find((s) => s.name?.startsWith("Apply"))?.env).toEqual({
      DATABASE_URL: "file:./hollow-ci.db",
    });

    const none = tempProject({
      "requirements.txt": "alembic\n",
      "alembic.ini": "[alembic]\nscript_location = migrations\n",
    });
    const nonePlan = plan(none);
    expect(nonePlan.migrations?.appliesInCi).toBe(false);
    expect(buildSteps(nonePlan).some((s) => s.name?.startsWith("Apply"))).toBe(false);
    expect(nonePlan.notes.join("\n")).toContain("CI cannot apply the alembic migrations");
  });
});

describe("CI applies migrations", () => {
  it("applies them right after installing, before the checks", () => {
    const names = buildSteps(plan(fixture("python-django"))).map((s) => s.name);
    const install = names.indexOf("Install dependencies");
    expect(names[install + 1]).toBe("Apply the django migrations to the CI database");
    expect(names[install + 2]).toBe("Check that every model change has a migration");
    expect(names.indexOf("Lint")).toBeGreaterThan(install + 2);
  });
});

describe("migration safety workflow", () => {
  const wf = parse(
    file(plan(fixture("node-next-prisma")), MIGRATIONS_WORKFLOW)?.content ?? "",
  ) as Workflow;

  it("re-runs when the override label is added or removed, with read-only access", () => {
    expect(wf.on).toEqual({
      pull_request: { types: ["opened", "synchronize", "reopened", "labeled", "unlabeled"] },
    });
    expect(wf.jobs.migrations?.name).toBe(MIGRATION_CHECK);
    expect(wf.jobs.migrations?.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    const check = wf.jobs.migrations?.steps[1];
    expect(check?.env?.OVERRIDE).toBe(
      expr("contains(github.event.pull_request.labels.*.name, 'allow-destructive-migration')"),
    );
    expect(check?.run).toContain(
      `python3 ${MIGRATION_CHECKER} prisma 'prisma/migrations/*/migration.sql'`,
    );
    expect(check?.run).not.toContain("${{");
  });

  it("escapes quotes in the label inside the expression", () => {
    const quoted = parse(
      file(
        plan(fixture("node-next-prisma"), { database: { destructiveChangeLabel: "it's fine" } }),
        MIGRATIONS_WORKFLOW,
      )?.content ?? "",
    ) as Workflow;
    expect(quoted.jobs.migrations?.steps[1]?.env?.OVERRIDE).toBe(
      expr("contains(github.event.pull_request.labels.*.name, 'it''s fine')"),
    );
  });

  it("is generated with its checker, only for projects with migrations", () => {
    const p = plan(fixture("node-next-prisma"));
    expect(file(p, MIGRATION_CHECKER)?.kind).toBe("generated");
    expect(file(p, MIGRATION_CHECKER)?.content.startsWith("# Generated by The Hollow")).toBe(true);
    expect(file(plan(fixture("node-vite-static")), MIGRATIONS_WORKFLOW)).toBeUndefined();
  });
});

/** Run the generated checker on files in a temp project, as the workflow does. */
function check(files: Record<string, string>, tool: string, pattern: string, override = false) {
  const dir = tempProject(files);
  writeFileSync(path.join(dir, "check.py"), renderMigrationChecker());
  const result = spawnSync("python3", ["check.py", tool, pattern], {
    cwd: dir,
    input: `${Object.keys(files).join("\n")}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      OVERRIDE: override ? "true" : "false",
      LABEL: "allow-destructive-migration",
    },
  });
  return { code: result.status, out: result.stdout };
}

describe("migration checker", () => {
  it("flags destructive SQL and leaves safe changes alone", () => {
    const result = check(
      {
        "prisma/migrations/2_x/migration.sql":
          'ALTER TABLE "User" DROP COLUMN "age",\nADD COLUMN "email" TEXT NOT NULL;\nALTER TABLE "Post" ADD COLUMN "slug" TEXT NOT NULL DEFAULT \'\';\nCREATE TABLE "Tag" ("id" SERIAL NOT NULL);\nALTER TABLE "Post" RENAME COLUMN "title" TO "name";\n',
      },
      "prisma",
      "prisma/migrations/*/migration.sql",
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "line=1,title=Destructive migration::This migration drops a column.",
    );
    expect(result.out).toContain("adds a NOT NULL column without a default");
    expect(result.out).toContain(
      "line=5,title=Destructive migration::This migration renames a column.",
    );
    expect(result.out.match(/::error/g)).toHaveLength(3);
  });

  it("does not flag Prisma's SQLite table rebuild, which keeps the data", () => {
    const result = check(
      {
        "prisma/migrations/3_x/migration.sql":
          'CREATE TABLE "new_User" ("id" INTEGER NOT NULL PRIMARY KEY);\nINSERT INTO "new_User" ("id") SELECT "id" FROM "User";\nDROP TABLE "User";\nALTER TABLE "new_User" RENAME TO "User";\n',
      },
      "prisma",
      "prisma/migrations/*/migration.sql",
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("no destructive changes");
  });

  it("reads Alembic upgrades, not downgrades", () => {
    const result = check(
      {
        "migrations/versions/a1.py":
          'from alembic import op\nimport sqlalchemy as sa\n\ndef upgrade():\n    op.add_column("u", sa.Column("email", sa.String(), nullable=False))\n    op.add_column("u", sa.Column("bio", sa.String(), nullable=True))\n    op.alter_column("u", "name",\n        new_column_name="full_name")\n    op.execute("ALTER TABLE x DROP COLUMN y")\n\ndef downgrade():\n    op.drop_column("u", "email")\n',
      },
      "alembic",
      "migrations/versions/*.py",
    );
    expect(result.code).toBe(1);
    expect(result.out.match(/::error/g)).toHaveLength(3);
    expect(result.out).toContain(
      "line=7,title=Destructive migration::This migration renames a column.",
    );
    expect(result.out).not.toContain("line=12");
  });

  it("reads Django operations, and lets the label through as warnings", () => {
    const files = {
      "shop/migrations/0002_x.py":
        'from django.db import migrations, models\n\nclass Migration(migrations.Migration):\n    operations = [\n        migrations.RemoveField(model_name="b", name="isbn"),\n        migrations.AddField(model_name="b", name="pages", field=models.IntegerField()),\n        migrations.AddField(model_name="b", name="note", field=models.TextField(null=True)),\n        migrations.AddField(model_name="b", name="rating", field=models.IntegerField(default=0)),\n    ]\n',
    };
    const blocked = check(files, "django", "*migrations/[0-9]*.py");
    expect(blocked.code).toBe(1);
    expect(blocked.out.match(/::error/g)).toHaveLength(2);
    const allowed = check(files, "django", "*migrations/[0-9]*.py", true);
    expect(allowed.code).toBe(0);
    expect(allowed.out.match(/::warning/g)).toHaveLength(2);
    expect(allowed.out).toContain("allowed by the 'allow-destructive-migration' label");
  });

  it("ignores files that are not migrations", () => {
    const result = check(
      { "src/schema.sql": "DROP TABLE users;\n" },
      "prisma",
      "prisma/migrations/*/migration.sql",
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("No migration files changed.");
  });
});

describe("hollow protect and hollow plan", () => {
  it("requires the migration check on projects with migrations", async () => {
    const dir = copyFixture("node-next-prisma");
    writeFileSync(path.join(dir, "hollow.yml"), "version: 1\ndeploy:\n  target: vercel\n");
    const fake = new FakeGitHub(
      fakeState({ files: [".github/workflows/ci.yml", ".github/workflows/pr-title.yml"] }),
    );
    const result = await runCli(["protect", "--dry-run", "--cwd", dir], {
      connect: async () => ({ api: fake, repo: "octocat/demo" }),
    });
    expect(result.stdout).toContain(
      'Required checks: "CI passed", "Conventional Commit title" and "Migration safety"',
    );
    expect(result.stdout).toContain(".github/workflows/migrations.yml is not on main yet");

    const shown = await runCli(["plan", "--cwd", dir]);
    expect(shown.stdout).toContain(
      'prisma: applied to the CI database on every run; destructive changes need the "allow-destructive-migration" label',
    );
  });
});
