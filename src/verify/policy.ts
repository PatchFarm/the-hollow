import { parse } from "yaml";

/**
 * The Hollow's workflow policy: the rules every workflow it writes or repairs must pass before it
 * is written (SECURITY.md, "Generated pipelines are insecure"). The rules are deliberately strict:
 * they hold The Hollow's own templates and the agent's edits, not every workflow in the wild.
 */
export type PolicyRule =
  | "invalid-workflow"
  | "unpinned-action"
  | "unpinned-image"
  | "permissions-missing"
  | "permissions-broad"
  | "untrusted-checkout"
  | "secrets-to-forks"
  | "script-injection"
  | "remote-script"
  | "checkout-credentials";

export interface PolicyViolation {
  rule: PolicyRule;
  /** Where in the workflow, such as `jobs.build.steps[2]`. */
  where: string;
  message: string;
}

const SHA = /^[^@\s]+@[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const EXPRESSION = /\$\{\{/;
/** Remote content piped or fed straight into an interpreter. */
const REMOTE_SCRIPT = [
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:env\s+)?(?:ba|z|da|k)?sh\b/,
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby)\b/,
  /\b(?:ba|z)?sh\s+(?:-s\s+)?<\(\s*(?:curl|wget)\b/,
  /\beval\s+"?\$\(\s*(?:curl|wget)\b/,
];
/** Expressions that name the pull request's own code. */
const PR_HEAD =
  /github\.event\.pull_request\.head\.|github\.head_ref|github\.event\.workflow_run\.head_|refs\/pull\//;

type Map = Record<string, unknown>;

function isMap(value: unknown): value is Map {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function triggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((t): t is string => typeof t === "string");
  if (isMap(on)) return Object.keys(on);
  return [];
}

/** True when a permissions value grants write access to anything. */
function grantsWrite(permissions: unknown): boolean {
  if (permissions === "write-all") return true;
  return isMap(permissions) && Object.values(permissions).some((level) => level === "write");
}

function isCheckout(uses: unknown): boolean {
  return typeof uses === "string" && /^actions\/checkout@/.test(uses);
}

/** Check one workflow's text against every rule. An empty list means it passes. */
export function checkWorkflow(content: string): PolicyViolation[] {
  let workflow: unknown;
  try {
    workflow = parse(content);
  } catch (error) {
    return [
      {
        rule: "invalid-workflow",
        where: "(file)",
        message: `The workflow is not valid YAML: ${(error as Error).message.split("\n")[0]}`,
      },
    ];
  }
  if (!isMap(workflow) || !isMap(workflow.jobs)) {
    return [{ rule: "invalid-workflow", where: "(file)", message: "The workflow has no jobs." }];
  }
  const found: PolicyViolation[] = [];
  const add = (rule: PolicyRule, where: string, message: string) =>
    found.push({ rule, where, message });

  const on = triggers(workflow.on);
  const privileged = on.includes("pull_request_target") || on.includes("workflow_run");

  if (!("permissions" in workflow)) {
    add(
      "permissions-missing",
      "permissions",
      "Set top-level permissions (`permissions: {}`), so jobs get only what they ask for instead of the repo's default token rights.",
    );
  } else if (workflow.permissions === "read-all" || grantsWrite(workflow.permissions)) {
    add(
      "permissions-broad",
      "permissions",
      "Top-level permissions must grant no write access. Give each job the scopes it needs instead.",
    );
  }

  for (const [id, raw] of Object.entries(workflow.jobs)) {
    if (!isMap(raw)) continue;
    const job = raw;
    const at = `jobs.${id}`;
    if (job.permissions === "write-all" || job.permissions === "read-all") {
      add(
        "permissions-broad",
        `${at}.permissions`,
        `Job ${id} asks for ${job.permissions}. List only the scopes it needs.`,
      );
    }
    if (typeof job.uses === "string" && !job.uses.startsWith("./") && !SHA.test(job.uses)) {
      add(
        "unpinned-action",
        `${at}.uses`,
        `${job.uses} is not pinned to a full commit SHA. Tags and branches can be moved to other code.`,
      );
    }
    if (job.secrets === "inherit") {
      add(
        "secrets-to-forks",
        `${at}.secrets`,
        "Pass a reusable workflow only the secrets it needs, not `secrets: inherit`.",
      );
    }
    const images: [string, unknown][] = [[`${at}.container`, job.container]];
    if (isMap(job.services)) {
      for (const [name, service] of Object.entries(job.services)) {
        images.push([`${at}.services.${name}`, service]);
      }
    }
    for (const [where, value] of images) {
      const image = isMap(value) ? value.image : value;
      if (typeof image === "string" && !DIGEST.test(image) && !EXPRESSION.test(image)) {
        add(
          "unpinned-image",
          `${where}.image`,
          `${image} is not pinned to a digest (image@sha256:...).`,
        );
      }
    }
    if (privileged && JSON.stringify(job).includes("secrets.")) {
      add(
        "secrets-to-forks",
        at,
        `Job ${id} reads secrets in a ${on.includes("pull_request_target") ? "pull_request_target" : "workflow_run"} workflow, which also runs for pull requests from forks.`,
      );
    }
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step: unknown, index: number) => {
      if (!isMap(step)) return;
      const where = `${at}.steps[${index}]${typeof step.name === "string" ? ` (${step.name})` : ""}`;
      const uses = step.uses;
      const inputs = isMap(step.with) ? step.with : {};
      if (typeof uses === "string") {
        const pinned = uses.startsWith("./") || SHA.test(uses) || DIGEST.test(uses);
        if (!pinned) {
          add(
            "unpinned-action",
            where,
            `${uses} is not pinned to a full commit SHA${uses.startsWith("docker://") ? " or digest" : ""}. Tags and branches can be moved to other code.`,
          );
        }
      }
      if (isCheckout(uses)) {
        if (inputs["persist-credentials"] !== false) {
          add(
            "checkout-credentials",
            where,
            "Check out with `persist-credentials: false`, so later steps cannot reuse the token git keeps.",
          );
        }
        const ref = `${String(inputs.ref ?? "")} ${String(inputs.repository ?? "")}`;
        if (privileged && PR_HEAD.test(ref)) {
          add(
            "untrusted-checkout",
            where,
            "This checks out the pull request's code in a workflow that has secrets and a write token. Use a pull_request workflow instead.",
          );
        }
      }
      for (const [field, script] of [
        ["run", step.run],
        [
          "with.script",
          typeof uses === "string" && /github-script@/.test(uses) ? inputs.script : undefined,
        ],
      ] as const) {
        if (typeof script !== "string") continue;
        if (EXPRESSION.test(script)) {
          add(
            "script-injection",
            `${where}.${field}`,
            `Pass values into scripts through \`env:\` and use them as shell variables. A \`\${{ }}\` expression is pasted into the script before it runs, so text from a branch name or PR title could run as code.`,
          );
        }
        if (field === "run" && REMOTE_SCRIPT.some((pattern) => pattern.test(script))) {
          add(
            "remote-script",
            `${where}.run`,
            "Download the file, check its published checksum, then run it. Piping a download straight into an interpreter runs whatever the server sends.",
          );
        }
      }
    });
  }
  return found;
}

/** One line per violation, for error messages. */
export function formatViolations(file: string, violations: PolicyViolation[]): string {
  return violations.map((v) => `  ${file}: ${v.where}: [${v.rule}] ${v.message}`).join("\n");
}
