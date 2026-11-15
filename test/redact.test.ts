import { describe, expect, it } from "vitest";
import { localSecretValues, REDACTED, redact } from "../src/agent/redact.js";
import { ProjectFiles } from "../src/util/project-files.js";
import { tempProject } from "./helpers.js";

/** Build fake tokens at run time so no token-shaped string sits in the source. */
const fake = (prefix: string, length: number, char = "a") => `${prefix}${char.repeat(length)}`;

describe("redaction", () => {
  it("hides tokens by their shape", () => {
    const samples = [
      fake("ghp_", 36),
      fake("gho_", 40),
      fake("github_pat_", 60),
      fake("sk-ant-api03-", 40),
      fake("sk-proj-", 48),
      fake("sk-", 48),
      fake("AIza", 35),
      fake("gsk_", 52),
      fake("xai-", 40),
      fake("AKIA", 16, "A"),
      fake("xoxb-", 40, "1"),
      fake("sk_live_", 24),
      fake("npm_", 36),
      fake("pypi-", 60),
      fake("dckr_pat_", 27),
      fake("glpat-", 20),
      `eyJ${"a".repeat(20)}.${"b".repeat(30)}.${"c".repeat(30)}`,
      `https://hooks.slack.com/services/T000/B000/${"x".repeat(24)}`,
      `https://discord.com/api/webhooks/123456/${"y".repeat(60)}`,
    ];
    for (const token of samples) {
      const out = redact(`error: request failed with ${token} in it`);
      expect(out, token).not.toContain(token);
      expect(out).toContain(REDACTED);
      expect(out).toContain("error: request failed with");
    }
  });

  it("hides whole private keys, even cut off at the end of a log", () => {
    const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"b3BlbnNzaC".repeat(8)}\n-----END OPENSSH PRIVATE KEY-----`;
    expect(redact(`before\n${key}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    expect(redact("x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow")).toBe(`x\n${REDACTED}`);
  });

  it("hides passwords in URLs and credentials in headers, keeping what helps a repair", () => {
    expect(redact("connect postgresql://app:hunter22@db:5432/app failed")).toBe(
      `connect postgresql://app:${REDACTED}@db:5432/app failed`,
    );
    expect(redact("Authorization: Bearer abc.def.ghi")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redact(`curl -H "Authorization: token ${"z".repeat(30)}"`)).not.toContain(
      "z".repeat(30),
    );
  });

  it("hides the values of secret-looking settings, but not references to them", () => {
    expect(redact("API_KEY=abc123def456")).toBe(`API_KEY=${REDACTED}`);
    expect(redact('  "client_secret": "s3cr3t-value",')).toBe(`  "client_secret": ${REDACTED},`);
    expect(redact("DATABASE_URL: mysql://root@localhost/app")).toBe(`DATABASE_URL: ${REDACTED}`);
    expect(redact("db_password = 'pa55word'")).toBe(`db_password = ${REDACTED}`);
    // What a workflow repair needs to see stays.
    for (const kept of [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow expression, on purpose
      "GH_TOKEN: ${{ github.token }}",
      "VERCEL_TOKEN: $VERCEL_TOKEN",
      "persist-credentials: false",
      "tokenSecret: VERCEL_TOKEN",
      "API_KEY=***",
    ]) {
      expect(redact(kept)).toBe(kept);
    }
  });

  it("hides exact values wherever they appear, longest first", () => {
    const out = redact("using abcdef-ghijkl and abcdef here", {
      values: ["abcdef", "abcdef-ghijkl", "abc"],
    });
    expect(out).toBe(`using ${REDACTED} and ${REDACTED} here`);
    // Very short values would hide ordinary words, so they are left alone.
    expect(redact("abc", { values: ["abc"] })).toBe("abc");
  });

  it("leaves ordinary log lines alone", () => {
    const log = [
      "Run npm ci",
      "added 512 packages in 9s",
      "Error: Cannot find module 'next'",
      "##[error]Process completed with exit code 1.",
      "  at Object.<anonymous> (/home/runner/work/app/app/test/a.test.ts:3:1)",
    ].join("\n");
    expect(redact(log)).toBe(log);
  });
});

describe("local .env values", () => {
  it("collects values (never names) from .env files, skipping examples", () => {
    const dir = tempProject({
      ".env":
        'export STRIPE_KEY="value-one-long"\nPORT=3000\n# comment\nNAME=plain-value-two # note\n',
      ".env.local": "SINGLE='quoted three'\n",
      ".env.example": "EXAMPLE=not-a-secret-at-all\n",
      "notes.env": "IGNORED=because-the-name\n",
    });
    const values = localSecretValues(new ProjectFiles(dir));
    expect(values.sort()).toEqual(["plain-value-two", "quoted three", "value-one-long"]);
    expect(redact("token value-one-long leaked", { values })).toBe(`token ${REDACTED} leaked`);
  });
});
