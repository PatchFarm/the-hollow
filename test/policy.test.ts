import { describe, expect, it } from "vitest";
import { type HollowConfigInput, hollowConfigSchema } from "../src/config/schema.js";
import { detectProject } from "../src/detect/index.js";
import { generateFiles } from "../src/generate/index.js";
import { planPipeline } from "../src/pipeline/plan.js";
import { checkWorkflow, formatViolations, type PolicyRule } from "../src/verify/policy.js";
import { copyFixture, fixture, runCli } from "./helpers.js";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const CHECKOUT = `actions/checkout@${SHA}`;

/** A minimal passing workflow, with the given job body spliced in. */
function workflow(job: string, top = "on: push\npermissions: {}\n"): string {
  return `${top}jobs:\n  build:\n    runs-on: ubuntu-latest\n${job}`;
}

const rules = (content: string): PolicyRule[] => checkWorkflow(content).map((v) => v.rule);

describe("workflow policy rules", () => {
  it("passes a workflow that follows every rule", () => {
    const ok = workflow(
      `    permissions:\n      contents: read\n    services:\n      db:\n        image: postgres@sha256:${"a".repeat(64)}\n    steps:\n      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n      - env:\n          TITLE: \${{ github.event.pull_request.title }}\n        run: echo "$TITLE"\n`,
    );
    expect(checkWorkflow(ok)).toEqual([]);
  });

  it("requires actions and reusable workflows pinned to a full commit SHA", () => {
    expect(rules(workflow("    steps:\n      - uses: actions/setup-node@v4\n"))).toEqual([
      "unpinned-action",
    ]);
    expect(rules(workflow("    steps:\n      - uses: docker://alpine:3\n"))).toEqual([
      "unpinned-action",
    ]);
    expect(
      rules(workflow(`    steps:\n      - uses: docker://alpine@sha256:${"b".repeat(64)}\n`)),
    ).toEqual([]);
    expect(rules(workflow("    steps:\n      - uses: ./.github/actions/local\n"))).toEqual([]);
    expect(
      rules(
        "on: push\npermissions: {}\njobs:\n  call:\n    uses: org/repo/.github/workflows/x.yml@main\n",
      ),
    ).toEqual(["unpinned-action"]);
  });

  it("requires service and container images pinned to a digest", () => {
    expect(rules(workflow("    container: node:22\n    steps:\n      - run: echo hi\n"))).toEqual([
      "unpinned-image",
    ]);
    expect(
      rules(
        workflow(
          "    services:\n      db:\n        image: postgres:18\n    steps:\n      - run: echo\n",
        ),
      ),
    ).toEqual(["unpinned-image"]);
  });

  it("requires top-level permissions that grant no writes, and no blanket permissions", () => {
    expect(rules(workflow("    steps:\n      - run: echo\n", "on: push\n"))).toEqual([
      "permissions-missing",
    ]);
    expect(
      rules(workflow("    steps:\n      - run: echo\n", "on: push\npermissions: write-all\n")),
    ).toEqual(["permissions-broad"]);
    expect(
      rules(
        workflow("    steps:\n      - run: echo\n", "on: push\npermissions:\n  contents: write\n"),
      ),
    ).toEqual(["permissions-broad"]);
    expect(rules(workflow("    permissions: write-all\n    steps:\n      - run: echo\n"))).toEqual([
      "permissions-broad",
    ]);
    // Jobs may ask for the write scopes they need.
    expect(
      rules(workflow("    permissions:\n      contents: write\n    steps:\n      - run: echo\n")),
    ).toEqual([]);
  });

  it("blocks checking out pull request code where secrets and a write token are available", () => {
    const prt = "on: pull_request_target\npermissions: {}\n";
    expect(
      rules(
        workflow(
          `    steps:\n      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n          ref: \${{ github.event.pull_request.head.sha }}\n`,
          prt,
        ),
      ),
    ).toEqual(["untrusted-checkout"]);
    expect(
      rules(
        workflow(
          `    steps:\n      - env:\n          TOKEN: \${{ secrets.DEPLOY_TOKEN }}\n        run: echo\n`,
          prt,
        ),
      ),
    ).toEqual(["secrets-to-forks"]);
    expect(
      rules(
        "on: push\npermissions: {}\njobs:\n  call:\n    uses: org/repo/.github/workflows/x.yml@" +
          SHA +
          "\n    secrets: inherit\n",
      ),
    ).toEqual(["secrets-to-forks"]);
  });

  it("blocks expressions inside scripts, including github-script", () => {
    expect(
      rules(workflow(`    steps:\n      - run: echo "\${{ github.event.pull_request.title }}"\n`)),
    ).toEqual(["script-injection"]);
    expect(
      rules(
        workflow(
          `    steps:\n      - uses: actions/github-script@${SHA}\n        with:\n          script: console.log("\${{ github.head_ref }}")\n`,
        ),
      ),
    ).toEqual(["script-injection"]);
  });

  it("blocks piping a download into an interpreter, but not downloading then checking it", () => {
    for (const run of [
      "curl -fsSL https://example.com/install.sh | sh",
      "curl -fsSL https://example.com/install.sh | sudo bash",
      "wget -qO- https://example.com/x | python3",
      "bash <(curl -s https://example.com/x)",
      'eval "$(curl -s https://example.com/x)"',
    ]) {
      expect(rules(workflow(`    steps:\n      - run: ${JSON.stringify(run)}\n`))).toEqual([
        "remote-script",
      ]);
    }
    expect(
      rules(
        workflow(
          '    steps:\n      - run: |\n          curl -fsSL --output tool.tgz "$URL"\n          echo "$SHA  tool.tgz" | sha256sum --check\n',
        ),
      ),
    ).toEqual([]);
  });

  it("requires checkouts that do not keep the token", () => {
    expect(rules(workflow(`    steps:\n      - uses: ${CHECKOUT}\n`))).toEqual([
      "checkout-credentials",
    ]);
  });

  it("reports invalid YAML and workflows without jobs", () => {
    expect(rules("on: [push\n")).toEqual(["invalid-workflow"]);
    expect(rules("on: push\n")).toEqual(["invalid-workflow"]);
  });

  it("says where each problem is", () => {
    const text = formatViolations(
      "ci.yml",
      checkWorkflow(
        workflow("    steps:\n      - name: Set up\n        uses: actions/setup-node@v4\n"),
      ),
    );
    expect(text).toContain("ci.yml: jobs.build.steps[0] (Set up): [unpinned-action]");
  });
});

/** Every target, with preprod and URLs on, so each optional job is rendered too. */
const TARGETS: HollowConfigInput["deploy"][] = [
  { target: "docker" },
  { target: "vps", host: "app.example.com" },
  { target: "vercel" },
  { target: "cloudflare-workers" },
  { target: "cloudflare-pages", projectName: "site" },
];

describe("every template passes the policy", () => {
  const fixtures = [
    "node-next-prisma",
    "node-vite-static",
    "node-hono-workers",
    "python-fastapi",
    "python-django",
  ];
  for (const name of fixtures) {
    it(name, () => {
      let checked = 0;
      for (const deploy of TARGETS) {
        const config = hollowConfigSchema.parse({
          version: 1,
          deploy,
          environments: {
            staging: { url: "https://staging.example.com" },
            preprod: { enabled: true, url: "https://preprod.example.com" },
            production: { url: "https://example.com" },
          },
        });
        const result = planPipeline(detectProject(fixture(name)), config);
        if (result.status !== "ok") continue;
        for (const file of generateFiles(result.plan)) {
          if (!file.workflow) continue;
          expect(formatViolations(file.path, checkWorkflow(file.content))).toBe("");
          // A shared object renders as a YAML anchor and alias, which is valid but hard to read.
          expect(file.content, file.path).not.toMatch(/: [&*]a\d+$/m);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(10);
    });
  }
});

describe("init and upgrade", () => {
  it("check the policy before writing, and pass on The Hollow's own templates", async () => {
    const dir = copyFixture("python-fastapi");
    const result = await runCli(["init", "--yes", "--target", "docker", "--cwd", dir]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("workflow policy");
  });
});
