import { describe, expect, it } from "vitest";
import { diagnose, type FailureContext } from "../src/agent/diagnose.js";
import { cleanLog, errorLines, failureExcerpt } from "../src/agent/logs.js";

const context = (
  lines: string[],
  step: string | null = "Install dependencies",
  job = "Build and test",
) => ({ workflow: "CI", job, step, lines }) satisfies FailureContext;

describe("log cleanup", () => {
  it("drops timestamps, colour codes and progress rewrites", () => {
    expect(
      cleanLog(
        "﻿2026-11-15T10:00:00.1234567Z \u001b[31mred\u001b[0m text\n2026-11-15T10:00:01Z 10%\r50%\r100%",
      ),
    ).toEqual(["red text", "100%"]);
  });

  it("collects error messages once each", () => {
    expect(errorLines(["ok", "##[error]boom", "##[error]boom", "##[error]second"])).toEqual([
      "boom",
      "second",
    ]);
  });

  it("cuts to the failing step, up to its first error", () => {
    const lines = [
      "##[group]Run actions/checkout@abc",
      "checked out",
      "##[endgroup]",
      "##[group]Run npm ci",
      "npm ci",
      "##[endgroup]",
      "npm error something broke",
      "##[error]Process completed with exit code 1.",
      "Post job cleanup.",
    ];
    expect(failureExcerpt(lines)).toEqual([
      "Run npm ci",
      "npm ci",
      "npm error something broke",
      "##[error]Process completed with exit code 1.",
    ]);
    expect(failureExcerpt(lines, 2)).toEqual([
      "npm error something broke",
      "##[error]Process completed with exit code 1.",
    ]);
  });
});

describe("known failures", () => {
  it("names a missing secret, its environment, and the command that sets it", () => {
    const d = diagnose(
      context(
        [
          "##[error]Add the VPS_SSH_KEY secret to the production environment (Settings > Environments > production).",
        ],
        "Set up SSH",
      ),
    );
    expect(d).toMatchObject({ id: "missing-secret", owner: "you" });
    expect(d?.cause).toBe("The VPS_SSH_KEY secret is not set for the production environment.");
    expect(d?.fix).toContain("hollow secrets set VPS_SSH_KEY --env production");

    const vars = diagnose(
      context([
        "##[error]Add the VERCEL_ORG_ID and VERCEL_PROJECT_ID variables (the orgId and projectId from .vercel/project.json).",
      ]),
    );
    expect(vars?.cause).toBe("The VERCEL_ORG_ID and VERCEL_PROJECT_ID variables are not set.");
    expect(
      diagnose(
        context(["##[error]Add a Vercel token as the VERCEL_TOKEN secret (Settings > ...)."]),
      )?.cause,
    ).toBe("The VERCEL_TOKEN secret is not set.");
  });

  it("recognises each package manager's out-of-date lockfile", () => {
    for (const [line, file] of [
      [
        "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.",
        "package-lock.json",
      ],
      ["ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile", "pnpm-lock.yaml"],
      [
        "YN0028: The lockfile would have been modified by this install, which is explicitly forbidden.",
        "yarn.lock",
      ],
      ["error: lockfile had changes, but lockfile is frozen", "bun.lock"],
      [
        "error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.",
        "uv.lock",
      ],
      ["pyproject.toml changed significantly since poetry.lock was last generated.", "poetry.lock"],
    ] as const) {
      const d = diagnose(context([line]));
      expect(d?.id, line).toBe("lockfile");
      expect(d?.owner).toBe("app");
      expect(d?.cause).toContain(file);
    }
  });

  it("recognises settings, deploy and network problems", () => {
    const cases: [string, string, string][] = [
      [
        "GitHub Actions is not permitted to create or approve pull requests.",
        "actions-cannot-open-prs",
        "you",
      ],
      ["denied: permission_denied: write_package", "ghcr-denied", "you"],
      [
        'Branch "hollow/pipeline" is not allowed to deploy to production due to environment protection rules.',
        "environment-protection",
        "you",
      ],
      ["Host key verification failed.", "host-key", "you"],
      ["deploy@app.example.com: Permission denied (publickey).", "ssh-auth", "you"],
      [
        "##[error]https://example.com/healthz did not answer without a server error within two minutes (last status: 502).",
        "health-check",
        "app",
      ],
      ["leaks found: 2", "secret-leak", "app"],
      ['npm error Missing script: "typecheck"', "missing-script", "pipeline"],
      [
        "/home/runner/work/_temp/x.sh: line 2: ruff: command not found",
        "command-not-found",
        "pipeline",
      ],
      ["HttpError: Resource not accessible by integration", "token-permissions", "pipeline"],
      ["npm error network request failed, reason: socket hang up ECONNRESET", "transient", "retry"],
    ];
    for (const [line, id, owner] of cases) {
      expect(diagnose(context([line], null)), line).toMatchObject({ id, owner });
    }
    expect(diagnose(context(["ruff: command not found"], null))?.cause).toContain("runs ruff");
  });

  it("falls back to the step for failed checks, but a known cause wins", () => {
    expect(diagnose(context(["FAIL test/a.test.ts"], "Test"))).toMatchObject({
      id: "tests",
      owner: "app",
    });
    expect(diagnose(context(["src/a.ts:1 error"], "Type check"))?.cause).toBe(
      "The type check step failed on the project's code.",
    );
    expect(diagnose(context(["ECONNRESET while fetching"], "Test"))?.id).toBe("transient");
    expect(
      diagnose(context(["something"], "Fail on high or worse", "Dependency scan (OSV-Scanner)"))
        ?.id,
    ).toBe("vulnerable-dependency");
  });

  it("returns nothing for a failure it does not know", () => {
    expect(diagnose(context(["segmentation fault"], "Deploy"))).toBeNull();
  });
});
