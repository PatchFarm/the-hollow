import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type HollowConfigInput, hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { vpsMigrationLines } from "../src/generate/deploy-migrations.js";
import { generateFiles } from "../src/generate/index.js";
import { IMAGES } from "../src/generate/pins.js";
import { RELEASE_WORKFLOW } from "../src/generate/release.js";
import { expr } from "../src/generate/render.js";
import { MIGRATIONS_GUIDE } from "../src/generate/scaffold.js";
import type { MigrationPlan } from "../src/pipeline/migrations.js";
import { type PipelinePlan, planPipeline } from "../src/pipeline/plan.js";
import { settingsFor } from "../src/secrets/catalog.js";
import { copyFixture, fixture, tempProject } from "./helpers.js";

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
type Job = { permissions?: unknown; steps: Step[] };
type Workflow = { jobs: Record<string, Job> };

function plan(dir: string, extra: Partial<HollowConfigInput>): PipelinePlan {
  const config = hollowConfigSchema.parse({ version: 1, ...extra });
  const result = planPipeline(detectProject(dir), config);
  if (result.status !== "ok") throw new Error(result.error);
  return result.plan;
}

const jobs = (p: PipelinePlan) =>
  (parse(generateFiles(p).find((f) => f.path === RELEASE_WORKFLOW)?.content ?? "") as Workflow)
    .jobs;
const names = (job: Job | undefined) => (job?.steps ?? []).map((s) => s.name ?? s.uses ?? "");
const migrateIndex = (job: Job | undefined) =>
  names(job).findIndex((name) => name.startsWith("Apply the "));
const indexOf = (job: Job | undefined, prefix: string) =>
  names(job).findIndex((name) => name.startsWith(prefix));

/** A Node project on Drizzle with PostgreSQL, built on one of the fixtures. */
function drizzleProject(base: string): string {
  const dir = copyFixture(base);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  manifest.dependencies = { ...manifest.dependencies, pg: "8.0.0", "drizzle-orm": "1.0.0" };
  manifest.devDependencies = { ...manifest.devDependencies, "drizzle-kit": "1.0.0" };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(
    path.join(dir, "drizzle.config.ts"),
    'export default { dialect: "postgresql", out: "./drizzle" };\n',
  );
  return dir;
}

describe("which environments a deploy migrates", () => {
  it("migrates every Docker environment from the runner, with the URL secret", () => {
    const p = plan(fixture("python-fastapi"), {
      deploy: { target: "docker" },
      environments: { preprod: { enabled: true } },
    });
    expect(p.migrations?.deploy).toEqual({
      where: "runner",
      secret: "DATABASE_URL",
      environments: ["staging", "preprod", "production"],
      imageCommand: "",
      backup: null,
    });
    const all = jobs(p);
    for (const id of ["deploy-staging", "deploy-preprod", "deploy-production"]) {
      expect(migrateIndex(all[id])).toBeGreaterThan(indexOf(all[id], "Install dependencies"));
      expect(migrateIndex(all[id])).toBeLessThan(indexOf(all[id], "Point the "));
    }
  });

  it("migrates on release only on Vercel: preprod first, since it serves production's database", () => {
    const p = plan(fixture("node-next-prisma"), {
      deploy: { target: "vercel" },
      environments: { preprod: { enabled: true, url: "https://preprod.example.com" } },
    });
    expect(p.migrations?.deploy?.environments).toEqual(["preprod", "production"]);
    const all = jobs(p);
    expect(migrateIndex(all["deploy-staging"])).toBe(-1);
    const preprod = all["deploy-preprod"];
    expect(preprod?.permissions).toEqual({ contents: "read" });
    expect(migrateIndex(preprod)).toBeLessThan(indexOf(preprod, "Point preprod.example.com"));
    expect(preprod?.steps[migrateIndex(preprod)]?.run).toContain(
      "(production's database URL: this deployment runs with production's settings)",
    );
    const production = all["deploy-production"];
    expect(migrateIndex(production)).toBeLessThan(indexOf(production, "Promote"));
  });

  it("migrates only production on Workers, right before it gets the new version", () => {
    const p = plan(drizzleProject("node-hono-workers"), {
      deploy: { target: "cloudflare-workers" },
    });
    expect(p.migrations?.deploy?.environments).toEqual(["production"]);
    const all = jobs(p);
    expect(migrateIndex(all["deploy-staging"])).toBe(-1);
    const production = all["deploy-production"];
    expect(production?.steps[migrateIndex(production)]?.run).toContain(
      "yarn run drizzle-kit migrate",
    );
    expect(migrateIndex(production)).toBeLessThan(
      indexOf(production, "Send all traffic to the staged version"),
    );
    // A manual run migrates with the release's own code.
    const manual = all["deploy-production-manual"];
    expect(manual?.steps[1]).toMatchObject({ with: { ref: expr("steps.release.outputs.tag") } });
    expect(migrateIndex(manual)).toBeGreaterThan(0);
  });

  it("migrates every Pages environment, staging included, before deploying its branch", () => {
    const p = plan(drizzleProject("node-vite-static"), {
      deploy: { target: "cloudflare-pages", projectName: "site" },
    });
    expect(p.migrations?.deploy?.environments).toEqual(["staging", "production"]);
    const all = jobs(p);
    const staging = all["deploy-staging"];
    expect(migrateIndex(staging)).toBeGreaterThan(indexOf(staging, "Build"));
    expect(migrateIndex(staging)).toBeLessThan(indexOf(staging, "Deploy to the staging branch"));
    const production = all["deploy-production"];
    expect(migrateIndex(production)).toBeLessThan(indexOf(production, "Deploy the staged build"));
  });

  it("stops the deploy with a clear error when the secret is missing", () => {
    const p = plan(fixture("python-fastapi"), {
      deploy: { target: "docker" },
      database: { urlSecret: "APP_DATABASE_URL" },
    });
    const step = jobs(p)["deploy-staging"]?.steps.find((s) => s.name?.startsWith("Apply the "));
    expect(step?.env).toEqual({ DATABASE_URL: expr("secrets.APP_DATABASE_URL") });
    expect(step?.run).toContain(
      "Add the APP_DATABASE_URL secret to the staging environment (Settings > Environments > staging)",
    );
    expect(step?.run).toContain("exit 1");
    expect(step?.run).not.toContain("${{");
  });

  it("does nothing at deploy time for SQLite on runner targets, or with migrations turned off", () => {
    const sqlite = tempProject({
      "package.json": JSON.stringify({ name: "s", dependencies: { "@prisma/client": "6.0.0" } }),
      "package-lock.json": "{}",
      "prisma/schema.prisma": 'datasource db {\n  provider = "sqlite"\n}\n',
      Dockerfile: "FROM scratch\n",
    });
    const sqlitePlan = plan(sqlite, { deploy: { target: "docker" } });
    expect(sqlitePlan.migrations?.deploy).toBeNull();
    expect(sqlitePlan.notes.join("\n")).toContain("the app uses SQLite");
    expect(migrateIndex(jobs(sqlitePlan)["deploy-production"])).toBe(-1);

    const off = plan(fixture("python-fastapi"), {
      deploy: { target: "docker" },
      database: { migrations: "none" },
    });
    expect(JSON.stringify(jobs(off))).not.toContain("Apply the ");
    expect(generateFiles(off).some((f) => f.path === MIGRATIONS_GUIDE)).toBe(false);
  });

  it("lists the URL secret per migrating environment in hollow secrets", () => {
    const vercel = plan(fixture("node-next-prisma"), {
      deploy: { target: "vercel" },
      environments: { preprod: { enabled: true, url: "https://preprod.example.com" } },
    });
    const database = settingsFor(vercel).filter((s) => s.name === "DATABASE_URL");
    expect(database.map((s) => [s.environment, s.kind, s.input, s.required])).toEqual([
      ["preprod", "secret", "hidden", true],
      ["production", "secret", "hidden", true],
    ]);
    expect(database[0]?.purpose).toContain("production's database URL");

    const vps = plan(fixture("python-django"), { deploy: { target: "vps", host: "app.example" } });
    expect(settingsFor(vps).some((s) => s.name === "DATABASE_URL")).toBe(false);
  });
});

describe("VPS deploys", () => {
  it("back up, then migrate inside the new image, then start it", () => {
    const p = plan(fixture("python-django"), { deploy: { target: "vps", host: "app.example" } });
    expect(p.migrations?.deploy).toMatchObject({
      where: "image",
      imageCommand: "python manage.py migrate --noinput",
      backup: "postgres",
    });
    const run = jobs(p)["deploy-staging"]?.steps.find((s) => s.name === "Deploy to app.example")
      ?.run as string;
    const backup = run.indexOf("run --rm -T --user");
    const migrate = run.indexOf("compose run --rm -T app python manage.py migrate --noinput");
    const up = run.indexOf("compose up --detach --wait");
    expect(backup).toBeGreaterThan(run.indexOf("compose pull --quiet"));
    expect(migrate).toBeGreaterThan(backup);
    expect(up).toBeGreaterThan(migrate);
    expect(run).toContain(`image: ${IMAGES.postgres.image}`);
    // compose run would read the rest of the server script from stdin otherwise.
    for (const line of run.split("\n").filter((l) => l.includes("compose run"))) {
      expect(line).toContain("< /dev/null");
    }
    expect(run).toContain("The database stays migrated");
  });

  it("runs Node tools through npm in the image, and warns when the CLI is a dev dependency", () => {
    const p = plan(fixture("node-next-prisma"), { deploy: { target: "vps", host: "app.example" } });
    expect(p.migrations?.deploy?.imageCommand).toBe("npm exec --no -- prisma migrate deploy");
    expect(p.notes.join("\n")).toContain("prisma is only in devDependencies");
  });

  it("skips the backup, and says so, when it cannot use pg_dump or mysqldump", () => {
    const lines = vpsMigrationLines(migrationPlan(null)).join("\n");
    expect(lines).not.toContain("hollow-backup");
    expect(lines).toContain("compose run --rm -T app alembic upgrade head < /dev/null");
  });
});

function migrationPlan(backup: "postgres" | "mysql" | null): MigrationPlan {
  return {
    tool: "alembic",
    apply: "alembic upgrade head",
    missingCheck: null,
    paths: [],
    label: "allow-destructive-migration",
    appliesInCi: true,
    ciEnv: {},
    deploy: {
      where: "image",
      secret: "DATABASE_URL",
      environments: ["production"],
      imageCommand: "alembic upgrade head",
      backup,
    },
  };
}

/** The script the backup container runs, pointed at a temporary folder instead of /backups. */
function backupScript(engine: "postgres" | "mysql", backups: string): string {
  const lines = vpsMigrationLines(migrationPlan(engine));
  const start = lines.indexOf("cat > .hollow-backup.sh << 'SCRIPT'");
  const end = lines.indexOf("SCRIPT", start + 1);
  return `${lines
    .slice(start + 1, end)
    .join("\n")
    .replaceAll("/backups", backups)}\n`;
}

/** A fake dump tool that writes what it was given to the file it was asked to write. */
function stub(bin: string, name: string, body: string[]): void {
  const file = path.join(bin, name);
  writeFileSync(file, ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(file, 0o755);
}

function runBackup(engine: "postgres" | "mysql", url: string | null, fail = false) {
  const root = tempProject({});
  const backups = path.join(root, "backups");
  const bin = path.join(root, "bin");
  mkdirSync(backups);
  mkdirSync(bin);
  const outputFlag = engine === "postgres" ? "--file=" : "--result-file=";
  stub(bin, engine === "postgres" ? "pg_dump" : "mysqldump", [
    'out=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    `    ${outputFlag}*) out="\${arg#${outputFlag}}" ;;`,
    "  esac",
    "done",
    `printf '%s\\n' "$MYSQL_PWD" "$@" > "$out"`,
    fail ? "exit 1" : "exit 0",
  ]);
  writeFileSync(path.join(root, "backup.sh"), backupScript(engine, backups));
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}`, MYSQL_PWD: "" };
  if (url !== null) env.DATABASE_URL = url;
  const result = spawnSync("sh", [path.join(root, "backup.sh")], { env, encoding: "utf8" });
  return { result, backups };
}

describe("the backup script, run for real with a stub dump tool", () => {
  it("gives pg_dump a plain URL, keeps sslmode, and writes a finished file", () => {
    const { result, backups } = runBackup(
      "postgres",
      "postgresql+psycopg://app:s3cret@db:5432/app?schema=public&sslmode=require",
    );
    expect(result.status).toBe(0);
    const files = readdirSync(backups);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}T\d{6}Z\.dump$/);
    expect(readFileSync(path.join(backups, files[0] as string), "utf8")).toContain(
      "--dbname=postgresql://app:s3cret@db:5432/app?sslmode=require",
    );
    expect(result.stdout).toContain("Backed up the database to backups/");
  });

  it("keeps only the newest seven backups", () => {
    const root = tempProject({});
    const backups = path.join(root, "backups");
    mkdirSync(backups);
    for (let day = 1; day <= 9; day++) {
      const old = path.join(backups, `2026010${day}T000000Z.dump`);
      writeFileSync(old, "old");
      utimesSync(old, new Date(2026, 0, day), new Date(2026, 0, day));
    }
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    stub(bin, "pg_dump", [
      `for arg in "$@"; do case "$arg" in --file=*) : > "\${arg#--file=}" ;; esac; done`,
    ]);
    writeFileSync(path.join(root, "backup.sh"), backupScript("postgres", backups));
    const result = spawnSync("sh", [path.join(root, "backup.sh")], {
      env: { PATH: `${bin}:${process.env.PATH}`, DATABASE_URL: "postgres://db/app" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const left = readdirSync(backups).sort();
    expect(left).toHaveLength(7);
    expect(left).not.toContain("20260101T000000Z.dump");
    expect(left).not.toContain("20260103T000000Z.dump");
  });

  it("fails, and leaves no half-written file, when the dump fails or there is no URL", () => {
    const failed = runBackup("postgres", "postgres://db/app", true);
    expect(failed.result.status).not.toBe(0);
    expect(readdirSync(failed.backups)).toEqual([]);

    const missing = runBackup("postgres", null);
    expect(missing.result.status).toBe(1);
    expect(missing.result.stderr).toContain("DATABASE_URL is not set");
  });

  it("splits a MySQL URL for mysqldump and decodes the password", () => {
    const { result, backups } = runBackup(
      "mysql",
      "mysql+pymysql://app:p%40ss%3Aword@db.internal:3307/shop?charset=utf8mb4",
    );
    expect(result.status).toBe(0);
    const files = readdirSync(backups);
    expect(files[0]).toMatch(/\.sql$/);
    const recorded = readFileSync(path.join(backups, files[0] as string), "utf8").split("\n");
    expect(recorded[0]).toBe("p@ss:word");
    expect(recorded).toContain("--host=db.internal");
    expect(recorded).toContain("--port=3307");
    expect(recorded).toContain("--user=app");
    expect(recorded).toContain("shop");
  });

  it("uses MySQL's default port when the URL has none", () => {
    const { result, backups } = runBackup("mysql", "mysql://root@db/app");
    expect(result.status).toBe(0);
    const recorded = readFileSync(path.join(backups, readdirSync(backups)[0] as string), "utf8");
    expect(recorded).toContain("--port=3306");
    expect(recorded).toContain("--user=root");
  });
});

describe("the migrations guide", () => {
  it("is a starter file, written once, that explains this project's deploy order", () => {
    const p = plan(fixture("node-next-prisma"), { deploy: { target: "vercel" } });
    const guide = generateFiles(p).find((f) => f.path === MIGRATIONS_GUIDE);
    expect(guide?.kind).toBe("scaffold");
    expect(guide?.content).toContain("## Expand, migrate, contract");
    expect(guide?.content).toContain("shares production's database");
    expect(guide?.content).not.toContain("## Restoring a backup");

    const vps = plan(fixture("python-django"), { deploy: { target: "vps", host: "app.example" } });
    const vpsGuide = generateFiles(vps).find((f) => f.path === MIGRATIONS_GUIDE)?.content;
    expect(vpsGuide).toContain("## Restoring a backup");
    expect(vpsGuide).toContain("pg_restore --clean --if-exists");
  });
});
