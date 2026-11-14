import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/cli/main.js";
import type { Connect } from "../src/cli/protect-command.js";
import type { Setting } from "../src/secrets/catalog.js";
import type { HostKeyTools, Writer } from "../src/secrets/github.js";
import { FakeGitHub, type FakeState, fakeState } from "./fake-github.js";
import { copyFixture, runCli, tempProject } from "./helpers.js";

const VPS = "deploy:\n  target: vps\n  host: app.example.com\n";
const VERCEL = "deploy:\n  target: vercel\n";

interface Written {
  repo: string;
  name: string;
  kind: string;
  environment: string | null;
  value: string;
}

function setup(config: string, overrides: Partial<FakeState> = {}, fixture = "python-django") {
  const dir = copyFixture(fixture);
  writeFileSync(path.join(dir, "hollow.yml"), `version: 1\n${config}`);
  const fake = new FakeGitHub(fakeState(overrides));
  const connect: Connect = async (_dir, repo) => ({ api: fake, repo: repo ?? "octocat/demo" });
  const written: Written[] = [];
  // Records what would be sent to gh, and updates the fake so a recheck sees it.
  const writer = (): Writer => async (repo: string, setting: Setting, value: string) => {
    written.push({
      repo,
      name: setting.name,
      kind: setting.kind,
      environment: setting.environment,
      value,
    });
    const s = fake.state;
    if (setting.environment === null) {
      (setting.kind === "secret" ? s.repoSecrets : s.repoVariables).push(setting.name);
    } else {
      const map = setting.kind === "secret" ? s.envSecrets : s.envVariables;
      map[setting.environment] = [...(map[setting.environment] ?? []), setting.name];
    }
  };
  const scans: string[] = [];
  const hostKeys: HostKeyTools = {
    scan: async (host, port) => {
      scans.push(`${host}:${port}`);
      return `${host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n`;
    },
    fingerprints: async () => "256 SHA256:abc123 app.example.com (ED25519)",
  };
  const env = (name: string) => ({
    deployment_branch_policy: null,
    reviewers: null,
    prevent_self_review: false,
    policies: [],
    name,
  });
  fake.state.environments = { staging: env("staging"), production: env("production") };
  return { dir, fake, connect, written, writer, hostKeys, scans };
}

describe("hollow secrets", () => {
  it("lists what the pipeline reads, per environment, as set or missing, by name only", async () => {
    const t = setup(VPS, {
      envSecrets: { staging: ["VPS_SSH_KEY"] },
      repoVariables: ["VPS_KNOWN_HOSTS"],
    });
    const result = await runCli(["secrets", "--cwd", t.dir], {
      connect: t.connect,
      io: { secretsWriter: t.writer, hostKeys: t.hostKeys },
    });
    expect(result.stdout).toContain("Secrets and variables the pipeline reads, on octocat/demo:");
    expect(result.stdout).toMatch(/set\s+VPS_SSH_KEY \(staging\)\s+secret/);
    expect(result.stdout).toMatch(/missing\s+VPS_SSH_KEY \(production\)\s+secret/);
    expect(result.stdout).toMatch(/set \(repo\)\s+VPS_KNOWN_HOSTS \(staging\)\s+variable/);
    expect(result.stdout).toMatch(/optional\s+RELEASE_PLEASE_TOKEN/);
    expect(result.stdout).not.toContain("(not read)");
    // No terminal: list, show how to set from a script, and fail while something is missing.
    expect(result.stdout).toContain("npx the-hollow secrets set VPS_SSH_KEY --env production");
    expect(result.stdout).toContain("npx the-hollow secrets set RELEASE_PLEASE_TOKEN   # optional");
    expect(result.stdout).toContain("1 required value is still missing: VPS_SSH_KEY (production).");
    expect(result.code).toBe(EXIT.failure);
    expect(t.written).toEqual([]);
  });

  it("passes once everything required is set", async () => {
    const t = setup(
      VERCEL,
      {
        repoSecrets: ["VERCEL_TOKEN"],
        repoVariables: ["VERCEL_ORG_ID", "VERCEL_PROJECT_ID"],
        envSecrets: { production: ["DATABASE_URL"] },
      },
      "node-next-prisma",
    );
    const result = await runCli(["secrets", "--cwd", t.dir], {
      connect: t.connect,
      io: { secretsWriter: t.writer },
    });
    expect(result.stdout).toContain("Everything the pipeline needs is set.");
    expect(result.code).toBe(EXIT.ok);
  });

  it("offers to set the missing ones, hiding secret values and skipping on Enter", async () => {
    const t = setup(VERCEL, {}, "node-next-prisma");
    const result = await runCli(["secrets", "--cwd", t.dir], {
      connect: t.connect,
      // token, org, project, skip the bypass secret, production's database URL, skip release token
      answers: [
        "y",
        "vercel-token-value",
        "team_123",
        "prj_456",
        "",
        "postgresql://u:pw@db/app",
        "",
      ],
      io: { secretsWriter: t.writer, hostKeys: t.hostKeys },
    });
    expect(result.stdout).toContain("Set the missing ones now? [y/N]");
    expect(result.stdout).toContain("Value, not shown (Enter to skip)");
    expect(result.stdout).not.toContain("vercel-token-value");
    expect(result.stdout).not.toContain("postgresql://u:pw@db/app");
    expect(t.written).toEqual([
      {
        repo: "octocat/demo",
        name: "VERCEL_TOKEN",
        kind: "secret",
        environment: null,
        value: "vercel-token-value",
      },
      {
        repo: "octocat/demo",
        name: "VERCEL_ORG_ID",
        kind: "variable",
        environment: null,
        value: "team_123",
      },
      {
        repo: "octocat/demo",
        name: "VERCEL_PROJECT_ID",
        kind: "variable",
        environment: null,
        value: "prj_456",
      },
      {
        repo: "octocat/demo",
        name: "DATABASE_URL",
        kind: "secret",
        environment: "production",
        value: "postgresql://u:pw@db/app",
      },
    ]);
    expect(result.stdout).toContain("skipped  VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(result.stdout).toContain("Everything the pipeline needs is set.");
    expect(result.code).toBe(EXIT.ok);
  });

  it("reads SSH keys from a file and checks host key fingerprints before saving them", async () => {
    const t = setup(VPS);
    const keyFile = path.join(
      tempProject({
        id_ed25519: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
      }),
      "id_ed25519",
    );
    const result = await runCli(["secrets", "--cwd", t.dir], {
      connect: t.connect,
      // yes; staging key file; staging host key matches; production key file; production host key does not match; skip release token
      answers: ["y", keyFile, "y", keyFile, "n", ""],
      io: { secretsWriter: t.writer, hostKeys: t.hostKeys },
    });
    expect(t.scans).toEqual(["app.example.com:22", "app.example.com:22"]);
    expect(result.stdout).toContain("256 SHA256:abc123 app.example.com (ED25519)");
    expect(result.stdout).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(t.written.map((w) => `${w.name}@${w.environment}`)).toEqual([
      "VPS_SSH_KEY@staging",
      "VPS_KNOWN_HOSTS@staging",
      "VPS_SSH_KEY@production",
    ]);
    expect(t.written[0]?.value).toContain("PRIVATE KEY");
    expect(t.written[1]?.value).toContain("ssh-ed25519");
    expect(result.stdout).toContain("still missing: VPS_KNOWN_HOSTS (production)");
    expect(result.code).toBe(EXIT.failure);
  });

  it("refuses a file that is not a private key for an SSH key", async () => {
    const t = setup(VPS);
    const notKey = path.join(tempProject({ "notes.txt": "hello\n" }), "notes.txt");
    const result = await runCli(["secrets", "--cwd", t.dir], {
      connect: t.connect,
      answers: ["y", notKey, "n", "", "n", ""],
      io: { secretsWriter: t.writer, hostKeys: t.hostKeys },
    });
    expect(result.stdout).toContain("does not look like a private key");
    expect(t.written).toEqual([]);
  });

  it("asks to run hollow protect first when an environment does not exist", async () => {
    const t = setup(VPS);
    t.fake.state.environments = {};
    const result = await runCli(["secrets", "--cwd", t.dir], {
      connect: t.connect,
      io: { secretsWriter: t.writer },
    });
    expect(result.stdout).toMatch(/no env\s+VPS_SSH_KEY \(staging\)/);
    expect(result.stdout).toContain("Run `hollow protect` to create them");
    expect(result.code).toBe(EXIT.failure);
  });

  it("sets one value from stdin with `secrets set`, trimming single-line values", async () => {
    const t = setup(VERCEL, {}, "node-next-prisma");
    const result = await runCli(["secrets", "set", "VERCEL_TOKEN", "--cwd", t.dir], {
      connect: t.connect,
      io: { secretsWriter: t.writer, readStdin: async () => "tok-123\n" },
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Set VERCEL_TOKEN on octocat/demo.");
    expect(t.written).toEqual([
      {
        repo: "octocat/demo",
        name: "VERCEL_TOKEN",
        kind: "secret",
        environment: null,
        value: "tok-123",
      },
    ]);
  });

  it("keeps multi-line values whole and needs --env for environment values", async () => {
    const t = setup(VPS);
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
    const io = { secretsWriter: t.writer, readStdin: async () => key };
    const missingEnv = await runCli(["secrets", "set", "VPS_SSH_KEY", "--cwd", t.dir], {
      connect: t.connect,
      io,
    });
    expect(missingEnv.code).toBe(EXIT.usage);
    expect(missingEnv.stderr).toContain("Pass --env with one of: staging, production");

    const ok = await runCli(
      ["secrets", "set", "VPS_SSH_KEY", "--env", "production", "--cwd", t.dir],
      {
        connect: t.connect,
        io,
      },
    );
    expect(ok.code).toBe(EXIT.ok);
    expect(t.written[0]).toMatchObject({ environment: "production", value: key });
  });

  it("only sets what the pipeline reads, and rejects bad arguments", async () => {
    const t = setup(VERCEL, {}, "node-next-prisma");
    const unknown = await runCli(["secrets", "set", "AWS_SECRET", "--cwd", t.dir], {
      connect: t.connect,
      io: { secretsWriter: t.writer, readStdin: async () => "x" },
    });
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.stderr).toContain("AWS_SECRET is not something this pipeline reads");

    const repoWide = await runCli(
      ["secrets", "set", "VERCEL_TOKEN", "--env", "staging", "--cwd", t.dir],
      {
        connect: t.connect,
        io: { secretsWriter: t.writer, readStdin: async () => "x" },
      },
    );
    expect(repoWide.stderr).toContain("set for the whole repo, so it takes no --env");

    const empty = await runCli(["secrets", "set", "VERCEL_TOKEN", "--cwd", t.dir], {
      connect: t.connect,
      io: { secretsWriter: t.writer, readStdin: async () => "  \n" },
    });
    expect(empty.stderr).toContain("Nothing came in on stdin");
    expect(t.written).toEqual([]);

    expect((await runCli(["secrets", "set"])).code).toBe(EXIT.usage);
    expect((await runCli(["secrets", "--env", "staging"])).stderr).toContain("--env only applies");
  });

  it("reports gh failures without printing the value", async () => {
    const t = setup(VERCEL, {}, "node-next-prisma");
    const failing = (): Writer => async () => {
      throw new Error("HTTP 403: Resource not accessible by integration");
    };
    const result = await runCli(["secrets", "set", "VERCEL_TOKEN", "--cwd", t.dir], {
      connect: t.connect,
      io: { secretsWriter: failing, readStdin: async () => "super-secret" },
    });
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toContain("HTTP 403");
    expect(result.stdout + result.stderr).not.toContain("super-secret");
  });

  it("names the token permission it needs when GitHub refuses to list secrets", async () => {
    const t = setup(
      VERCEL,
      {
        refuse: {
          "GET repos/octocat/demo/actions/secrets": {
            status: 403,
            message: "Resource not accessible by personal access token",
          },
        },
      },
      "node-next-prisma",
    );
    const result = await runCli(["secrets", "--cwd", t.dir], {
      connect: t.connect,
      io: { secretsWriter: t.writer },
    });
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toContain(
      'A fine-grained token needs the "Secrets" repository permission',
    );
  });

  it("says when the pipeline reads nothing of its own", async () => {
    const dir = tempProject({
      "package.json": JSON.stringify({ name: "x" }),
      "package-lock.json": "{}",
      "hollow.yml":
        "version: 1\ndeploy:\n  target: cloudflare-pages\n  projectName: x\nrelease:\n  tokenSecret: RELEASE_PLEASE_TOKEN\n",
    });
    // Pages without a build has no deploy, but release-please still reads its optional token.
    const result = await runCli(["secrets", "--cwd", dir], {
      connect: setup(VERCEL).connect,
      io: { secretsWriter: setup(VERCEL).writer },
    });
    expect(result.stdout).toMatch(/optional\s+RELEASE_PLEASE_TOKEN/);
    expect(result.code).toBe(EXIT.ok);
  });
});
