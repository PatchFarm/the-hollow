import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/cli/main.js";
import type { Connect } from "../src/cli/protect-command.js";
import { GitHubError } from "../src/github/api.js";
import { GITHUB_ACTIONS_APP_ID, RULESET_NAME } from "../src/protect/plan.js";
import { FakeGitHub, type FakeState, fakeState } from "./fake-github.js";
import { copyFixture, runCli } from "./helpers.js";

function project(config = ""): string {
  const dir = copyFixture("node-vite-static");
  writeFileSync(
    path.join(dir, "hollow.yml"),
    `version: 1\ndeploy:\n  target: cloudflare-pages\n  projectName: demo\n${config}`,
  );
  return dir;
}

function github(overrides: Partial<FakeState> = {}) {
  const fake = new FakeGitHub(fakeState(overrides));
  const connect: Connect = async (_dir, repo) => ({
    api: fake,
    repo: repo ?? `${fake.state.owner}/${fake.state.name}`,
  });
  return { fake, connect };
}

async function protect(
  args: string[],
  options: { config?: string; overrides?: Partial<FakeState>; answers?: string[] } = {},
) {
  const { fake, connect } = github(options.overrides);
  const dir = project(options.config);
  const result = await runCli(["protect", "--cwd", dir, ...args], {
    connect,
    ...(options.answers === undefined ? {} : { answers: options.answers }),
  });
  return { ...result, fake, dir, connect };
}

describe("hollow protect", () => {
  it("shows every change on --dry-run and changes nothing", async () => {
    const { code, stdout, stderr, fake } = await protect(["--dry-run"]);
    expect(stderr).toBe("");
    expect(code).toBe(EXIT.ok);
    expect(fake.writes).toEqual([]);
    expect(stdout).toContain("Changes to octocat/demo (public):");
    expect(stdout).toContain(`Branch rules for main (new "${RULESET_NAME}" ruleset)`);
    expect(stdout).toContain('Required checks: "CI passed" and "Conventional Commit title"');
    expect(stdout).toContain(
      "with 0 required approvals (raise it with protection.requiredApprovals",
    );
    expect(stdout).toContain("Environment staging");
    expect(stdout).toContain(
      "Every deploy waits for approval from octocat (they can approve deploys they started)",
    );
    expect(stdout).toContain("release-please can open its release pull request");
    expect(stdout).toContain("Private vulnerability reporting");
    expect(stdout).toContain("Dry run: nothing was changed.");
  });

  it("applies everything with --yes, and a second run finds nothing to change", async () => {
    const { code, stdout, stderr, fake, dir, connect } = await protect(["--yes"]);
    expect(stderr).toBe("");
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain("done          Branch rules for main");
    expect(stdout).toContain("octocat/demo is protected.");

    const state = fake.state;
    expect(state.rulesets).toHaveLength(1);
    const ruleset = state.rulesets[0] as Record<string, unknown>;
    expect(ruleset).toMatchObject({
      name: RULESET_NAME,
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    });
    const rules = ruleset.rules as { type: string; parameters?: Record<string, unknown> }[];
    expect(rules.map((rule) => rule.type)).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
    ]);
    expect(rules[2]?.parameters).toMatchObject({
      required_approving_review_count: 0,
      allowed_merge_methods: ["squash"],
    });
    expect(rules[3]?.parameters?.required_status_checks).toEqual([
      { context: "CI passed", integration_id: GITHUB_ACTIONS_APP_ID },
      { context: "Conventional Commit title", integration_id: GITHUB_ACTIONS_APP_ID },
    ]);
    expect(Object.keys(state.environments)).toEqual(["staging", "production"]);
    for (const name of ["staging", "production"]) {
      expect(state.environments[name]).toMatchObject({
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        policies: [{ name: "main", type: "branch" }],
      });
    }
    expect(state.environments.staging?.reviewers).toBeNull();
    expect(state.environments.production).toMatchObject({
      reviewers: [{ type: "User", id: 1 }],
      prevent_self_review: false,
    });
    expect(state.merge).toMatchObject({
      allow_merge_commit: false,
      allow_rebase_merge: false,
      squash_merge_commit_title: "PR_TITLE",
      delete_branch_on_merge: true,
    });
    expect(state.workflow).toEqual({
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: true,
    });
    expect(state.analysis).toMatchObject({
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
    });
    expect([state.alerts, state.fixes, state.reporting]).toEqual([true, true, true]);

    const before = fake.requests.length;
    const again = await runCli(["protect", "--cwd", dir], { connect });
    expect(again.code).toBe(EXIT.ok);
    expect(again.stdout).toContain("Nothing to change: every setting is already in place.");
    expect(fake.requests.slice(before).filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("asks before changing anything and stops on anything but yes", async () => {
    const declined = await protect([], { answers: ["n"] });
    expect(declined.stdout).toContain("Apply these changes to octocat/demo? [y/N]");
    expect(declined.stdout).toContain("Nothing was changed.");
    expect(declined.code).toBe(EXIT.failure);
    expect(declined.fake.writes).toEqual([]);

    const accepted = await protect([], { answers: ["yes"] });
    expect(accepted.code).toBe(EXIT.ok);
    expect(accepted.fake.writes.length).toBeGreaterThan(0);
  });

  it("refuses to apply without a terminal or --yes", async () => {
    const { code, stderr, fake } = await protect([]);
    expect(code).toBe(EXIT.failure);
    expect(stderr).toContain("with --yes to apply without a prompt");
    expect(fake.writes).toEqual([]);
  });

  it("on a private repo on GitHub Free, applies what the plan allows and explains the rest", async () => {
    const { code, stdout, fake } = await protect(["--yes"], {
      overrides: { private: true, userPlan: "free" },
    });
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain("(private, GitHub Free)");
    expect(stdout).toContain(
      "Branch rules for main: not available for private repos on GitHub Free",
    );
    expect(stdout).toContain("Private vulnerability reporting: only available for public repos");
    expect(stdout).toContain("nothing stops a direct push to main");
    expect(stdout).toContain("not available Secret scanning and push protection");
    expect(fake.state.rulesets).toEqual([]);
    expect(fake.state.environments).toEqual({});
    expect(fake.state.alerts).toBe(true);
  });

  it("on a private repo on Pro, sets up environments without deploy approvals", async () => {
    const { code, stdout, fake } = await protect(["--yes"], {
      overrides: { private: true, userPlan: "pro", secretProtection: true },
    });
    expect(code).toBe(EXIT.ok);
    expect(stdout).not.toContain("waits for approval");
    expect(stdout).toContain("deploy approvals on private repos only with Enterprise");
    expect(fake.state.rulesets).toHaveLength(1);
    expect(fake.state.environments.production?.reviewers).toBeNull();
    expect(fake.state.analysis).toMatchObject({ secret_scanning: { status: "enabled" } });
  });

  it("assumes Pro or Team when it cannot read the plan, and says so", async () => {
    const { stdout } = await protect(["--dry-run"], {
      overrides: { private: true, owner: "acme", ownerType: "Organization" },
    });
    expect(stdout).toContain(
      "Could not read the GitHub plan for octocat/demo".replace("octocat", "acme"),
    );
    expect(stdout).toContain("Branch rules for main");
  });

  it("resolves approvers from hollow.yml, including teams, on an Enterprise org", async () => {
    const { code, stdout, fake } = await protect(["--yes"], {
      config:
        "environments:\n  production:\n    approvers: [hubot, acme/release]\n    preventSelfReview: true\n",
      overrides: {
        private: true,
        owner: "acme",
        ownerType: "Organization",
        orgPlan: "enterprise",
        secretProtection: true,
        teams: { "acme/release": 7 },
      },
    });
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain(
      "Every deploy waits for approval from hubot, acme/release (approvers cannot approve deploys they started)",
    );
    expect(fake.state.environments.production).toMatchObject({
      reviewers: [
        { type: "User", id: 2 },
        { type: "Team", id: 7 },
      ],
      prevent_self_review: true,
    });
  });

  it("stops before changing anything when an approver does not exist", async () => {
    const { code, stderr, fake } = await protect(["--yes"], {
      config: "environments:\n  production:\n    approvers: [nobody-here]\n",
    });
    expect(code).toBe(EXIT.failure);
    expect(stderr).toContain(
      "GitHub user nobody-here from environments.production.approvers was not found.",
    );
    expect(fake.writes).toEqual([]);
  });

  it("with required approvals, never lets Actions approve pull requests", async () => {
    const { stdout, fake } = await protect(["--yes"], {
      config: "protection:\n  requiredApprovals: 1\n",
    });
    expect(stdout).toContain("with 1 required approval, reset when new commits are pushed");
    expect(stdout).toContain(
      "add a fine-grained token with Contents and Pull requests write access as the RELEASE_PLEASE_TOKEN secret",
    );
    expect(fake.state.workflow.can_approve_pull_request_reviews).toBe(false);
    const rules = fake.state.rulesets[0]?.rules as {
      type: string;
      parameters?: Record<string, unknown>;
    }[];
    expect(rules.find((rule) => rule.type === "pull_request")?.parameters).toMatchObject({
      required_approving_review_count: 1,
    });

    const warned = await protect(["--dry-run"], {
      config: "protection:\n  requiredApprovals: 1\n",
      overrides: {
        workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: true },
      },
    });
    expect(warned.stdout).toContain("GitHub Actions is allowed to approve pull requests");
  });

  it("updates its own ruleset in place and keeps rules someone added by hand", async () => {
    const existing = {
      id: 5,
      name: RULESET_NAME,
      target: "branch",
      enforcement: "evaluate",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      rules: [{ type: "required_signatures" }],
    };
    const { code, stdout, fake } = await protect(["--yes"], {
      overrides: { rulesets: [existing] },
    });
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain(`Update the existing "${RULESET_NAME}" ruleset to match:`);
    expect(
      fake.writes.some(
        (request) => request.method === "PUT" && request.path.endsWith("/rulesets/5"),
      ),
    ).toBe(true);
    expect(fake.state.rulesets).toHaveLength(1);
    const ruleset = fake.state.rulesets[0] as unknown as {
      enforcement: string;
      rules: { type: string }[];
    };
    expect(ruleset.enforcement).toBe("active");
    expect(ruleset.rules.map((rule) => rule.type)).toContain("required_signatures");
  });

  it("points out classic protection, missing workflows, a branch mismatch and extra deploy branches", async () => {
    const { stdout } = await protect(["--dry-run"], {
      overrides: {
        classicProtection: true,
        rulesets: [
          {
            id: 9,
            name: "Protect main",
            target: "branch",
            enforcement: "active",
            bypass_actors: [],
            conditions: {},
            rules: [],
          },
        ],
        files: [".github/workflows/ci.yml"],
        defaultBranch: "main",
        environments: {
          staging: {
            deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
            reviewers: null,
            prevent_self_review: false,
            policies: [
              { name: "main", type: "branch" },
              { name: "release/*", type: "branch" },
            ],
          },
        },
      },
    });
    expect(stdout).toContain("main also has classic branch protection");
    expect(stdout).toContain('other branch rulesets too ("Protect main")');
    expect(stdout).toContain(".github/workflows/pr-title.yml is not on main yet");
    expect(stdout).toContain("Environment staging also allows deploys from release/*");
    expect(stdout).toContain("Already set: Environment staging");

    const mismatch = await protect(["--dry-run"], { overrides: { defaultBranch: "trunk" } });
    expect(mismatch.stdout).toContain(
      "GitHub's default branch for octocat/demo is trunk, but hollow.yml uses main",
    );
  });

  it("keeps going when one change fails, then reports it", async () => {
    const { code, stdout, stderr, fake } = await protect(["--yes"], {
      overrides: {
        refuse: {
          "PUT repos/octocat/demo/environments/production": {
            status: 500,
            message: "Server Error",
          },
        },
      },
    });
    expect(code).toBe(EXIT.failure);
    expect(stdout).toContain("failed        Environment production: Server Error (HTTP 500)");
    expect(stdout).toContain("done          Dependabot alerts");
    expect(stderr).toContain("1 change failed.");
    expect(fake.state.alerts).toBe(true);
  });

  it("explains what is wrong with gh, the login or access", async () => {
    const signedOut = await protect(["--dry-run"], { overrides: { signedIn: false } });
    expect(signedOut.code).toBe(EXIT.failure);
    expect(signedOut.stderr).toContain("gh is not signed in to GitHub");

    const notAdmin = await protect(["--dry-run"], { overrides: { admin: false } });
    expect(notAdmin.stderr).toContain("needs admin access to octocat/demo");

    const missing = await runCli(["protect", "--cwd", project(), "--repo", "octocat/other"], {
      connect: github().connect,
    });
    expect(missing.stderr).toContain("Could not find octocat/other");

    const noGh = await runCli(["protect", "--cwd", project()], {
      connect: async () => {
        throw new GitHubError("This needs the GitHub CLI (gh).");
      },
    });
    expect(noGh.code).toBe(EXIT.failure);
    expect(noGh.stderr).toContain("This needs the GitHub CLI (gh).");
  });

  it("needs hollow.yml and a valid --repo", async () => {
    const noConfig = await runCli(["protect", "--cwd", copyFixture("node-vite-static")], {
      connect: github().connect,
    });
    expect(noConfig.code).toBe(EXIT.failure);
    expect(noConfig.stderr).toContain("Run `hollow init` first.");

    const badRepo = await runCli(["protect", "--cwd", project(), "--repo", "not a repo"], {
      connect: github().connect,
    });
    expect(badRepo.code).toBe(EXIT.usage);
    expect(badRepo.stderr).toContain("--repo takes a GitHub repo as owner/name.");

    const misplaced = await runCli(["plan", "--repo", "octocat/demo"]);
    expect(misplaced.code).toBe(EXIT.usage);
  });

  it("creates preprod too when hollow.yml turns it on", async () => {
    const { fake } = await protect(["--yes"], {
      config: "environments:\n  preprod:\n    enabled: true\n",
    });
    expect(Object.keys(fake.state.environments)).toEqual(["staging", "preprod", "production"]);
  });
});
