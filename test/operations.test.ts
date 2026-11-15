import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type HollowConfigInput, hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { generateFiles } from "../src/generate/index.js";
import { PIPELINE_DOC } from "../src/generate/pipeline-doc.js";
import { RELEASE_WORKFLOW } from "../src/generate/release.js";
import { expr, isGenerated } from "../src/generate/render.js";
import { SCHEDULED_WORKFLOW } from "../src/generate/scheduled.js";
import { type PipelinePlan, planPipeline } from "../src/pipeline/plan.js";
import { settingsFor } from "../src/secrets/catalog.js";
import { copyFixture, fixture, runCli } from "./helpers.js";

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; needs?: string[]; permissions?: unknown; steps: Step[] };
type Workflow = { on: { schedule?: { cron: string }[] }; jobs: Record<string, Job> };

const URLS = {
  staging: { url: "https://staging.example.com" },
  production: { url: "https://example.com" },
};

function plan(extra: Partial<HollowConfigInput> = {}): PipelinePlan {
  const config = hollowConfigSchema.parse({ version: 1, deploy: { target: "docker" }, ...extra });
  const result = planPipeline(detectProject(fixture("python-fastapi")), config);
  if (result.status !== "ok") throw new Error(result.error);
  return result.plan;
}

const file = (p: PipelinePlan, filePath: string) =>
  generateFiles(p).find((f) => f.path === filePath)?.content;
const workflow = (p: PipelinePlan, filePath: string) => parse(file(p, filePath) ?? "") as Workflow;

describe("scheduled.yml", () => {
  it("checks each environment URL on its own schedule and re-scans dependencies nightly", () => {
    const wf = workflow(plan({ environments: URLS }), SCHEDULED_WORKFLOW);
    expect(wf.on.schedule).toEqual([{ cron: "*/15 * * * *" }, { cron: "23 3 * * *" }]);
    const synthetic = wf.jobs.synthetic;
    expect(synthetic?.if).toBe(
      expr("github.event.schedule == '*/15 * * * *' || github.event_name == 'workflow_dispatch'"),
    );
    expect(synthetic?.permissions).toEqual({ issues: "write" });
    const checks = synthetic?.steps.filter((s) => s.id?.startsWith("check-")) ?? [];
    expect(checks.map((s) => s.env?.URL)).toEqual([
      "https://staging.example.com/",
      "https://example.com/",
    ]);
    const report = synthetic?.steps.find((s) => s.name === "Report production");
    expect(report?.env).toMatchObject({
      TITLE: "production is not answering (https://example.com/)",
      FAILING: expr("steps.check-production.outcome == 'failure'"),
      ISSUES: "true",
      SLACK_WEBHOOK: "",
    });
    expect(synthetic?.steps.at(-1)?.name).toBe("Fail the run if any check failed");
    expect(wf.jobs.dependencies?.name).toBe("Nightly dependency scan");
    expect(wf.jobs["dependencies-report"]?.needs).toEqual(["dependencies"]);
  });

  it("follows hollow.yml: other intervals, no synthetic checks without URLs, nothing when both are off", () => {
    const hourly = workflow(
      plan({ environments: URLS, verify: { syntheticEvery: "1h" } }),
      SCHEDULED_WORKFLOW,
    );
    expect(hourly.on.schedule?.[0]).toEqual({ cron: "7 * * * *" });
    expect(Object.keys(workflow(plan(), SCHEDULED_WORKFLOW).jobs)).toEqual([
      "dependencies",
      "dependencies-report",
    ]);
    const off = plan({
      environments: URLS,
      verify: { syntheticEvery: "off" },
      security: { nightlyScan: false },
    });
    expect(file(off, SCHEDULED_WORKFLOW)).toBeUndefined();
    expect(file(off, ".github/dependabot.yml")).not.toContain("scheduled.yml");
  });

  it("opens one issue per problem, comments on repeats, closes on recovery, and alerts only on changes", () => {
    const run =
      workflow(plan({ environments: URLS }), SCHEDULED_WORKFLOW).jobs.synthetic?.steps.find(
        (s) => s.name === "Report staging",
      )?.run ?? "";
    expect(run).toContain("select(.title == env.TITLE)");
    expect(run).toContain('gh issue comment "$number"');
    expect(run).toContain('gh issue close "$number"');
    // A repeat comments and stops before notify; only a new incident or a recovery alerts.
    const repeat = run.indexOf("Still failing at");
    expect(run.indexOf("exit 0", repeat)).toBeLessThan(run.indexOf('notify "$TITLE'));
    expect(run).toContain('notify "Recovered: $TITLE');
    expect(run).toContain("jq --null-input --arg text");
    expect(run).not.toContain("${{");
  });

  it("sends Slack and Discord alerts through secrets, and turns issues off when asked", () => {
    const p = plan({
      environments: URLS,
      notifications: {
        slackWebhookSecret: "SLACK_URL",
        discordWebhookSecret: "DISCORD_URL",
        incidentIssues: false,
      },
    });
    const env = workflow(p, SCHEDULED_WORKFLOW).jobs.synthetic?.steps.find(
      (s) => s.name === "Report staging",
    )?.env;
    expect(env).toMatchObject({
      SLACK_WEBHOOK: expr("secrets.SLACK_URL"),
      DISCORD_WEBHOOK: expr("secrets.DISCORD_URL"),
      ISSUES: "false",
    });
    expect(
      settingsFor(p)
        .filter((s) => ["SLACK_URL", "DISCORD_URL"].includes(s.name))
        .map((s) => [s.name, s.environment]),
    ).toEqual([
      ["SLACK_URL", null],
      ["DISCORD_URL", null],
    ]);
  });

  it("refuses an unknown interval", () => {
    expect(
      hollowConfigSchema.safeParse({
        version: 1,
        deploy: { target: "docker" },
        verify: { syntheticEvery: "1m" },
      }).success,
    ).toBe(false);
  });
});

describe("incident on a failed production deploy", () => {
  it("reports after either production job, automatic or manual", () => {
    const jobs = workflow(plan(), RELEASE_WORKFLOW).jobs;
    const report = jobs["report-production"];
    expect(report?.needs).toEqual([
      "release-please",
      "deploy-production",
      "deploy-production-manual",
    ]);
    expect(report?.if).toContain("always()");
    expect(report?.permissions).toEqual({ issues: "write" });
    expect(report?.steps[0]?.env).toMatchObject({
      TITLE: "Production deploy failed",
      FAILING: expr(
        "needs.deploy-production.result == 'failure' || needs.deploy-production-manual.result == 'failure'",
      ),
    });
    expect(report?.steps[0]?.env?.DETAIL).toContain(
      expr("needs.release-please.outputs.tag || inputs.version"),
    );
  });
});

describe("docs/PIPELINE.md", () => {
  it("explains the stages, secrets, rollback and schedule for this project", () => {
    const doc = file(plan({ environments: URLS }), PIPELINE_DOC) ?? "";
    expect(isGenerated(doc)).toBe(true);
    expect(doc).toContain("## On every pull request");
    expect(doc).toContain("| staging | https://staging.example.com | on every merge |");
    expect(doc).toContain("moves the tag back to the previous digest");
    expect(doc).toContain("`scheduled.yml` checks staging (https://staging.example.com/)");
    expect(doc).toContain("every 15 minutes");
  });

  it("is regenerated by hollow upgrade, since it is The Hollow's file", async () => {
    const dir = copyFixture("python-fastapi");
    expect((await runCli(["init", "--yes", "--target", "docker", "--cwd", dir])).code).toBe(0);
    const docPath = path.join(dir, PIPELINE_DOC);
    expect(readFileSync(docPath, "utf8")).not.toContain("every 15 minutes");
    const config = readFileSync(path.join(dir, "hollow.yml"), "utf8");
    writeFileSync(
      path.join(dir, "hollow.yml"),
      `${config}environments:\n  production:\n    url: https://example.com\n`,
    );
    const upgraded = await runCli(["upgrade", "--cwd", dir]);
    expect(upgraded.code).toBe(0);
    expect(upgraded.stdout).toMatch(/update\s+docs\/PIPELINE\.md/);
    expect(readFileSync(docPath, "utf8")).toContain(
      "production (https://example.com/) every 15 minutes",
    );
  });
});
