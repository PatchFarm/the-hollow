/**
 * Known CI failures, recognised from the job's name, the failed step and its (redacted) log,
 * with no model involved. Each says who can fix it:
 *
 * - you: a setting, secret or permission on GitHub or a deploy target
 * - app: the project's own code, dependencies or lockfile, which the agent never edits
 * - pipeline: the workflow files and hollow.yml, which the repair agent may change (part 3)
 * - retry: a passing problem on the network or a service; running it again is the fix
 */
export type Owner = "you" | "app" | "pipeline" | "retry";

export interface FailureContext {
  workflow: string;
  job: string;
  /** The step that failed, when GitHub reported one. */
  step: string | null;
  /** The cleaned, redacted log lines of the failure. */
  lines: string[];
}

export interface Diagnosis {
  id: string;
  owner: Owner;
  /** What went wrong, in one sentence. */
  cause: string;
  /** What to do about it. */
  fix: string;
}

interface Rule {
  id: string;
  owner: Owner;
  /** The captured text (index 0 is the whole match), or null when the rule does not apply. */
  match: (context: FailureContext, text: string) => Match | null;
  cause: (match: Match, context: FailureContext) => string;
  fix: (match: Match, context: FailureContext) => string;
}

type Match = readonly string[];

/** Run a pattern and return its groups, with missing ones as "". */
function find(pattern: RegExp, text: string): Match | null {
  const result = pattern.exec(text);
  return result === null ? null : [...result].map((part) => part ?? "");
}

const group = (match: Match, index: number): string => match[index] ?? "";
const HIT: Match = [];

const stepIs = (context: FailureContext, pattern: RegExp) =>
  context.step !== null && pattern.test(context.step);

/** Lockfile messages from each package manager, with the command that brings the lockfile up to date. */
const LOCKFILES: { pattern: RegExp; file: string; command: string }[] = [
  {
    pattern: /`npm ci` can only install packages when your package\.json and package-lock\.json/,
    file: "package-lock.json",
    command: "npm install",
  },
  { pattern: /ERR_PNPM_OUTDATED_LOCKFILE/, file: "pnpm-lock.yaml", command: "pnpm install" },
  {
    pattern:
      /The lockfile would have been modified by this install|Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`/,
    file: "yarn.lock",
    command: "yarn install",
  },
  {
    pattern: /lockfile had changes, but lockfile is frozen/,
    file: "bun.lock",
    command: "bun install",
  },
  {
    pattern: /The lockfile at `uv\.lock` needs to be updated/,
    file: "uv.lock",
    command: "uv lock",
  },
  {
    pattern:
      /pyproject\.toml changed significantly since poetry\.lock was last generated|poetry\.lock is not consistent with pyproject\.toml/,
    file: "poetry.lock",
    command: "poetry lock",
  },
];

const RULES: Rule[] = [
  {
    id: "missing-secret",
    owner: "you",
    match: (_c, text) =>
      find(
        /Add (?:the |a |your )?(?:[^.\n]*? as the )?([A-Z][A-Z0-9_]+)(?: and ([A-Z][A-Z0-9_]+))? (secret|variables?)(?: to the ([a-z]+) environment)?/,
        text,
      ),
    cause: (m) =>
      `The ${group(m, 1)}${group(m, 2) ? ` and ${group(m, 2)}` : ""} ${group(m, 3).startsWith("variable") ? "variable" : "secret"}${group(m, 2) ? "s are" : " is"} not set${group(m, 4) ? ` for the ${group(m, 4)} environment` : ""}.`,
    fix: (m) =>
      `Run \`hollow secrets\` to see what is missing and set it${group(m, 4) ? `, or \`hollow secrets set ${group(m, 1)} --env ${group(m, 4)}\`` : ""}. Then re-run the workflow.`,
  },
  {
    id: "lockfile",
    owner: "app",
    match: (_c, text) => {
      const lock = LOCKFILES.find((candidate) => candidate.pattern.test(text));
      return lock === undefined ? null : [lock.file, lock.command];
    },
    cause: (m) => `${group(m, 0)} is out of date with the project's manifest.`,
    fix: (m) =>
      `Run \`${group(m, 1)}\`, commit the updated ${group(m, 0)} and push. CI installs from the lockfile exactly, so it must match.`,
  },
  {
    id: "actions-cannot-open-prs",
    owner: "you",
    match: (_c, text) =>
      find(/GitHub Actions is not permitted to create or approve pull requests/, text),
    cause: () =>
      "The repo does not let GitHub Actions open pull requests, which release-please needs.",
    fix: () =>
      "Run `hollow protect`, or turn on Settings > Actions > General > Allow GitHub Actions to create and approve pull requests.",
  },
  {
    id: "ghcr-denied",
    owner: "you",
    match: (_c, text) =>
      find(
        /denied: permission_denied|installation not allowed to Create organization package|denied: denied/,
        text,
      ),
    cause: () => "The workflow was not allowed to push the image to GitHub Container Registry.",
    fix: () =>
      "If the package already exists, open it on GitHub, then Package settings > Manage Actions access, and give this repo the Write role. For an organization, also allow members to create packages.",
  },
  {
    id: "environment-protection",
    owner: "you",
    match: (_c, text) =>
      find(
        /Branch "([^"]+)" is not allowed to deploy to ([A-Za-z0-9_-]+) due to environment protection rules/,
        text,
      ),
    cause: (m) =>
      `${group(m, 2)} only accepts deploys from the default branch, and this ran on ${group(m, 1)}.`,
    fix: () => "Deploys run from the default branch after merging. Nothing to fix on this branch.",
  },
  {
    id: "host-key",
    owner: "you",
    match: (_c, text) =>
      find(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/, text),
    cause: () => "The server's SSH host key does not match the one saved for this environment.",
    fix: () =>
      "Check the server is the right one, then save its current key with `hollow secrets` (it runs ssh-keyscan and shows the fingerprints first).",
  },
  {
    id: "ssh-auth",
    owner: "you",
    match: (_c, text) => find(/Permission denied \(publickey/, text),
    cause: () => "The server refused the deploy SSH key.",
    fix: () =>
      "Add the public half of the deploy key to the deploy user's ~/.ssh/authorized_keys on the server, or set the right private key with `hollow secrets`.",
  },
  {
    id: "health-check",
    owner: "app",
    match: (_c, text) =>
      find(/(\S+) did not answer without a server error within two minutes/, text),
    cause: (m) =>
      `The new version did not answer at ${group(m, 1)}, so the deploy was rolled back.`,
    fix: () =>
      "Check the app's logs on the target: it may be crashing on start, missing an environment variable, or listening on another port or path (verify.healthPath in hollow.yml).",
  },
  {
    id: "destructive-migration",
    owner: "app",
    match: (_c, text) => find(/This migration (drops|renames|[^.\n]*?)[.,]/, text),
    cause: () => "A new migration makes a change that breaks the code already running.",
    fix: () =>
      "Split it into expand, migrate and contract steps (see docs/migrations.md), or add the override label when the change is safe.",
  },
  {
    id: "secret-leak",
    owner: "app",
    match: (c, text) =>
      find(/leaks found: [1-9]/, text) ??
      (stepIs(c, /secrets/i) && /\bleak/i.test(text) ? HIT : null),
    cause: () => "Gitleaks found a secret in the repo's history.",
    fix: () =>
      "Revoke the secret where it was issued first, then remove it from the code. If it is a false positive, add it to a .gitleaksignore file.",
  },
  {
    id: "vulnerable-dependency",
    owner: "app",
    match: (c) => (c.job.includes("OSV") && stepIs(c, /Fail on|scan/i) ? HIT : null),
    cause: () => "A dependency has a known vulnerability at or above the configured severity.",
    fix: () =>
      "Upgrade the affected packages listed in the log. If one cannot be fixed yet, raise security.failOn in hollow.yml or add an OSV ignore entry with a reason.",
  },
  {
    id: "missing-script",
    owner: "pipeline",
    match: (_c, text) => find(/Missing script: "?([\w:-]+)"?/, text),
    cause: (m) =>
      `The pipeline runs the "${group(m, 1)}" script, which package.json does not have.`,
    fix: (m) =>
      `Add a "${group(m, 1)}" script to package.json, or point hollow.yml at the right command and run \`hollow upgrade\`.`,
  },
  {
    id: "command-not-found",
    owner: "pipeline",
    match: (_c, text) =>
      find(/(?:^|\s)(?:\S+: )?(?:line \d+: )?([\w.-]+): (?:command )?not found/m, text),
    cause: (m) => `The step runs ${group(m, 1)}, which is not installed on the runner.`,
    fix: (m) =>
      `Install ${group(m, 1)} as a project dependency, or fix the command in hollow.yml and run \`hollow upgrade\`.`,
  },
  {
    id: "token-permissions",
    owner: "pipeline",
    match: (_c, text) => find(/Resource not accessible by integration/, text),
    cause: () => "A step needed a permission its job's token was not given.",
    fix: () => "Give the job the permission it needs in the workflow, and nothing broader.",
  },
  {
    id: "transient",
    owner: "retry",
    match: (_c, text) =>
      find(
        /ECONNRESET|ETIMEDOUT|EAI_AGAIN|Could not resolve host|502 Bad Gateway|503 Service Unavailable|The operation was canceled|socket hang up/,
        text,
      ),
    cause: () => "A network call to an outside service failed.",
    fix: () => "Re-run the failed jobs. If it keeps happening, the service may be down.",
  },
  // Checks that the project's own code failed. These come last: a known cause above wins.
  {
    id: "tests",
    owner: "app",
    match: (c) => (stepIs(c, /^(Test|Run the tests|End-to-end)/i) ? HIT : null),
    cause: () => "The tests failed.",
    fix: () =>
      "Read the failing tests in the log and fix the code or the tests. `hollow check --only test` runs them locally.",
  },
  {
    id: "checks",
    owner: "app",
    match: (c) => (stepIs(c, /^(Lint|Format|Type check|Build)\b/i) ? HIT : null),
    cause: (_m, c) => `The ${c.step?.toLowerCase()} step failed on the project's code.`,
    fix: () => "Fix what the log reports. `hollow check` runs the same checks locally.",
  },
];

/** The known cause of a failure, or null when none of the rules recognise it. */
export function diagnose(context: FailureContext): Diagnosis | null {
  const text = context.lines.join("\n");
  for (const rule of RULES) {
    const match = rule.match(context, text);
    if (match !== null) {
      return {
        id: rule.id,
        owner: rule.owner,
        cause: rule.cause(match, context),
        fix: rule.fix(match, context),
      };
    }
  }
  return null;
}

export const OWNER_LABEL: Record<Owner, string> = {
  you: "needs you",
  app: "in the project's code",
  pipeline: "in the pipeline",
  retry: "passing problem",
};
