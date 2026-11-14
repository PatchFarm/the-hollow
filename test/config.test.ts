import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config/load.js";
import { hollowJsonSchema } from "../src/config/schema.js";
import { tempProject } from "./helpers.js";

const errorsOf = (text: string) => {
  const result = parseConfig(text);
  return result.status === "invalid" ? result.errors : [];
};

describe("hollow.yml", () => {
  it("fills in safe defaults from a minimal file", () => {
    const result = parseConfig("version: 1\ndeploy:\n  target: vercel\n");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.config).toEqual({
      version: 1,
      project: {},
      environments: {
        staging: {},
        preprod: { enabled: false },
        production: { approvers: [] },
      },
      deploy: { target: "vercel", tokenSecret: "VERCEL_TOKEN" },
      release: { tokenSecret: "RELEASE_PLEASE_TOKEN" },
      security: { failOn: "high", sast: "auto" },
      database: { migrations: "auto", destructiveChangeLabel: "allow-destructive-migration" },
      notifications: { incidentIssues: true },
      agent: { ai: true, maxRepairAttempts: 3, maxSpendUsd: 2 },
    });
  });

  it("accepts a full VPS config", () => {
    const result = parseConfig(`
version: 1
project:
  language: python
  packageManager: uv
  runtimeVersion: "3.13"
environments:
  staging:
    url: https://staging.example.com
  preprod:
    enabled: true
  production:
    url: https://example.com
    approvers: [octocat, my-org/release-team]
deploy:
  target: vps
  host: 203.0.113.10
  port: 2222
  path: /srv/api
security:
  failOn: critical
  sast: semgrep
notifications:
  slackWebhookSecret: SLACK_WEBHOOK_URL
agent:
  ai: false
`);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.config.deploy).toEqual({
      target: "vps",
      host: "203.0.113.10",
      user: "deploy",
      port: 2222,
      path: "/srv/api",
      sshKeySecret: "VPS_SSH_KEY",
    });
    expect(result.config.environments.preprod.enabled).toBe(true);
  });

  it("rejects unknown keys so typos are caught", () => {
    expect(errorsOf("version: 1\ndeploy: { target: vercel }\nenviroments: {}\n")).toEqual([
      expect.stringContaining("enviroments"),
    ]);
  });

  it("requires version 1 and a deploy target", () => {
    const errors = errorsOf("project: {}\n");
    expect(errors.some((e) => e.startsWith("version:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("deploy:"))).toBe(true);
  });

  it("rejects an unknown deploy target", () => {
    expect(errorsOf("version: 1\ndeploy:\n  target: heroku\n")[0]).toMatch(/^deploy\.target:/);
  });

  it("refuses secret values where a secret name belongs", () => {
    const errors = errorsOf(
      "version: 1\ndeploy: { target: vercel }\nnotifications:\n  slackWebhookSecret: https://hooks.slack.com/services/T000/B000/XXXX\n",
    );
    expect(errors).toEqual([expect.stringContaining("NAME of a GitHub secret")]);
  });

  it("requires https URLs", () => {
    expect(
      errorsOf(
        "version: 1\ndeploy: { target: vercel }\nenvironments:\n  staging:\n    url: http://x.dev\n",
      ),
    ).toEqual([expect.stringContaining("https://")]);
  });

  it("blocks path traversal in the VPS deploy path", () => {
    expect(
      errorsOf("version: 1\ndeploy:\n  target: vps\n  host: example.com\n  path: /srv/../etc\n"),
    ).toEqual([expect.stringContaining("..")]);
  });

  it("caps agent retries and spend", () => {
    const errors = errorsOf(
      "version: 1\ndeploy: { target: vercel }\nagent:\n  maxRepairAttempts: 50\n  maxSpendUsd: 1000\n",
    );
    expect(errors).toHaveLength(2);
  });

  it("reports YAML syntax errors and duplicate keys", () => {
    expect(errorsOf("version: 1\ndeploy: [unclosed\n")[0]).toMatch(/^YAML:/);
    expect(errorsOf("version: 1\nversion: 1\ndeploy: { target: vercel }\n")[0]).toMatch(/^YAML:/);
  });

  it("rejects an empty file", () => {
    expect(errorsOf("")).toEqual(["hollow.yml is empty."]);
  });

  it("loads from a project directory", () => {
    expect(loadConfig(tempProject({})).status).toBe("missing");
    const dir = tempProject({ "hollow.yml": "version: 1\ndeploy:\n  target: docker\n" });
    const result = loadConfig(dir);
    expect(result.status === "ok" && result.config.deploy).toEqual({
      target: "docker",
      registry: "ghcr.io",
    });
  });
});

describe("JSON Schema", () => {
  it("matches the checked-in schema/hollow.schema.json (run `npm run schema` to update)", () => {
    const checkedIn = JSON.parse(
      readFileSync(new URL("../schema/hollow.schema.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(checkedIn).toEqual(hollowJsonSchema());
  });
});
