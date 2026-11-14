import { type ApiResponse, errorMessage, type GitHubApi, type Method } from "../github/api.js";

/** Name of the ruleset The Hollow owns. Reruns find it by this name and update it in place. */
export const RULESET_NAME = "The Hollow";
/** GitHub Actions' app id: required checks must come from Actions, so no other app can fake them. */
export const GITHUB_ACTIONS_APP_ID = 15368;
/** Job names from the generated ci.yml and pr-title.yml. */
export const REQUIRED_CHECKS = ["CI passed", "Conventional Commit title"] as const;

/**
 * What GitHub offers depends on visibility and plan:
 * - public, any plan: everything
 * - private on Free: no branch rules, no environments
 * - private on Pro or Team: branch rules and environments, but no deploy approvals
 * - private on Enterprise: everything
 */
export type Tier = "public" | "private-free" | "private-paid" | "private-enterprise";

export interface ProtectInput {
  /** `owner/name` */
  repo: string;
  defaultBranch: string;
  requiredApprovals: number;
  approvers: string[];
  preventSelfReview: boolean;
  preprod: boolean;
  /** Secret release-please reads, or null when release.yml is not generated. */
  releaseTokenSecret: string | null;
}

export interface Step {
  group: string;
  title: string;
  status: "change" | "ok" | "skip";
  /** What will change, in plain words. */
  changes: string[];
  /** Why a step is skipped. */
  reason?: string;
  /** True when the plan may not include this; a refusal from GitHub is then reported, not failed. */
  mayBeUnavailable?: boolean;
  apply?: () => Promise<void>;
}

export interface ProtectPlan {
  repo: string;
  tier: Tier;
  steps: Step[];
  notes: string[];
}

export type PlanResult = { status: "ok"; plan: ProtectPlan } | { status: "error"; error: string };

/** A request GitHub refused while applying a step. */
export class StepError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objectAt = (value: unknown, key: string): Json | undefined => {
  const inner = isObject(value) ? value[key] : undefined;
  return isObject(inner) ? inner : undefined;
};
const stringAt = (value: unknown, key: string): string | undefined => {
  const inner = isObject(value) ? value[key] : undefined;
  return typeof inner === "string" ? inner : undefined;
};
const numberAt = (value: unknown, key: string): number | undefined => {
  const inner = isObject(value) ? value[key] : undefined;
  return typeof inner === "number" ? inner : undefined;
};
const arrayAt = (value: unknown, key: string): unknown[] => {
  const inner = isObject(value) ? value[key] : undefined;
  return Array.isArray(inner) ? inner : [];
};
const ok = (response: ApiResponse) => response.status >= 200 && response.status < 300;

async function send(api: GitHubApi, method: Method, path: string, body?: unknown): Promise<void> {
  const response = await api.request(method, path, body);
  if (!ok(response)) throw new StepError(errorMessage(response), response.status);
}

interface Reviewer {
  type: "User" | "Team";
  id: number;
  label: string;
}

/**
 * Read the repo's current settings and work out what `hollow protect` would change. Makes only
 * GET requests; every change waits in a step's `apply` until the developer confirms.
 */
export async function planProtection(api: GitHubApi, input: ProtectInput): Promise<PlanResult> {
  const user = await api.request("GET", "user");
  if (user.status === 401) {
    return {
      status: "error",
      error: "gh is not signed in to GitHub. Sign in with `gh auth login`, then run again.",
    };
  }
  if (!ok(user))
    return { status: "error", error: `Could not read your GitHub account: ${errorMessage(user)}` };
  const login = stringAt(user.data, "login") ?? "";

  const repoResponse = await api.request("GET", `repos/${input.repo}`);
  if (repoResponse.status === 404) {
    return {
      status: "error",
      error: `Could not find ${input.repo}, or your gh login (${login}) cannot see it.`,
    };
  }
  if (!ok(repoResponse)) {
    return {
      status: "error",
      error: `Could not read ${input.repo}: ${errorMessage(repoResponse)}`,
    };
  }
  const repo = repoResponse.data;
  if (objectAt(repo, "permissions")?.admin !== true) {
    return {
      status: "error",
      error: `Changing these settings needs admin access to ${input.repo}, and your gh login (${login}) does not have it.`,
    };
  }

  const notes: string[] = [];
  const { tier, known } = await readTier(api, repo, user.data);
  const repoBranch = stringAt(repo, "default_branch");
  if (repoBranch !== undefined && repoBranch !== input.defaultBranch) {
    notes.push(
      `GitHub's default branch for ${input.repo} is ${repoBranch}, but hollow.yml uses ${input.defaultBranch}. These rules protect ${input.defaultBranch}.`,
    );
  }
  if (!known) {
    notes.push(
      `Could not read the GitHub plan for ${input.repo}, so The Hollow assumed Pro or Team. Anything the plan does not include is reported when it is applied.`,
    );
  }

  const branchRules = tier !== "private-free";
  const approvals = tier === "public" || tier === "private-enterprise";

  let reviewers: Reviewer[] | null = null;
  if (approvals) {
    const resolved = await resolveReviewers(api, input.approvers, user.data);
    if (typeof resolved === "string") return { status: "error", error: resolved };
    reviewers = resolved;
  }

  const steps: Step[] = [mergeStep(api, input, repo)];
  if (branchRules) {
    steps.push(await rulesetStep(api, input, notes, !known));
    if (await hasClassicProtection(api, input)) {
      notes.push(
        `${input.defaultBranch} also has classic branch protection. Both apply; once the "${RULESET_NAME}" ruleset works for you, you can remove the classic one (Settings > Branches).`,
      );
    }
    const missing = await missingWorkflows(api, input);
    if (missing.length > 0) {
      notes.push(
        `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not on ${input.defaultBranch} yet, and the required checks come from ${missing.length === 1 ? "it" : "them"}. Merge the pull request that adds The Hollow's workflows first; until then, pull requests without them cannot merge.`,
      );
    }
    const names = ["staging", ...(input.preprod ? ["preprod"] : []), "production"];
    for (const name of names) {
      steps.push(
        await environmentStep(
          api,
          input,
          name,
          name === "production" ? reviewers : null,
          notes,
          !known,
        ),
      );
    }
  } else {
    steps.push(
      skipped("Branch rules", `Branch rules for ${input.defaultBranch}`, PRIVATE_FREE),
      skipped("Environments", "Environments staging and production", PRIVATE_FREE),
    );
    notes.push(
      `${input.repo} is private on GitHub Free, which has no branch rules or environments for private repos, so nothing stops a direct push to ${input.defaultBranch}. Make the repo public, or move to GitHub Pro or Team, then run \`hollow protect\` again.`,
    );
  }
  if (branchRules && !approvals) {
    notes.push(
      "GitHub offers deploy approvals on private repos only with Enterprise, so production has no approval rule here. The deploy workflow (coming in milestone M3) gates production behind a manual run instead, which only people with write access can start.",
    );
  }

  steps.push(await actionsStep(api, input, notes));
  steps.push(...(await securitySteps(api, input, repo, tier)));
  return { status: "ok", plan: { repo: input.repo, tier, steps, notes } };
}

const PRIVATE_FREE = "not available for private repos on GitHub Free";

function skipped(group: string, title: string, reason: string): Step {
  return { group, title, status: "skip", changes: [], reason };
}

async function readTier(
  api: GitHubApi,
  repo: unknown,
  user: unknown,
): Promise<{ tier: Tier; known: boolean }> {
  if (isObject(repo) && repo.private !== true) return { tier: "public", known: true };
  const owner = objectAt(repo, "owner");
  const ownerLogin = stringAt(owner, "login") ?? "";
  let planName: string | undefined;
  if (
    stringAt(owner, "type") === "User" &&
    ownerLogin.toLowerCase() === (stringAt(user, "login") ?? "").toLowerCase()
  ) {
    planName = stringAt(objectAt(user, "plan"), "name");
  } else if (stringAt(owner, "type") === "Organization") {
    const org = await api.request("GET", `orgs/${ownerLogin}`);
    if (ok(org)) planName = stringAt(objectAt(org.data, "plan"), "name");
  }
  if (planName === undefined) return { tier: "private-paid", known: false };
  const name = planName.toLowerCase();
  if (name === "free") return { tier: "private-free", known: true };
  if (name.includes("enterprise") || name === "business_plus") {
    return { tier: "private-enterprise", known: true };
  }
  return { tier: "private-paid", known: true };
}

async function resolveReviewers(
  api: GitHubApi,
  approvers: string[],
  user: unknown,
): Promise<Reviewer[] | string> {
  const login = stringAt(user, "login") ?? "";
  const names = approvers.length > 0 ? approvers.map((name) => name.replace(/^@/, "")) : [login];
  const reviewers: Reviewer[] = [];
  for (const name of names) {
    if (name.includes("/")) {
      const [org, slug] = name.split("/") as [string, string];
      const team = await api.request("GET", `orgs/${org}/teams/${slug}`);
      const id = numberAt(team.data, "id");
      if (!ok(team) || id === undefined) {
        return `Team ${name} from environments.production.approvers was not found, or your gh login cannot see it.`;
      }
      reviewers.push({ type: "Team", id, label: name });
    } else if (name.toLowerCase() === login.toLowerCase() && numberAt(user, "id") !== undefined) {
      reviewers.push({ type: "User", id: numberAt(user, "id") as number, label: login });
    } else {
      const found = await api.request("GET", `users/${name}`);
      const id = numberAt(found.data, "id");
      if (!ok(found) || id === undefined) {
        return `GitHub user ${name} from environments.production.approvers was not found.`;
      }
      reviewers.push({ type: "User", id, label: stringAt(found.data, "login") ?? name });
    }
  }
  return reviewers;
}

const MERGE_SETTINGS = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "PR_BODY",
  delete_branch_on_merge: true,
} as const;

function mergeStep(api: GitHubApi, input: ProtectInput, repo: unknown): Step {
  const differs = (...keys: (keyof typeof MERGE_SETTINGS)[]) =>
    keys.some((key) => isObject(repo) && repo[key] !== MERGE_SETTINGS[key]);
  const changes: string[] = [];
  if (differs("allow_squash_merge", "allow_merge_commit", "allow_rebase_merge")) {
    changes.push("Squash merging only, so each pull request lands as one commit");
  }
  if (differs("squash_merge_commit_title", "squash_merge_commit_message")) {
    changes.push(
      "The squash commit takes the pull request's title and description, so the Conventional Commit title becomes the commit message and the changelog entry",
    );
  }
  if (differs("delete_branch_on_merge")) changes.push("Delete branches once they are merged");
  return {
    group: "Merge settings",
    title: "Merge settings",
    status: changes.length > 0 ? "change" : "ok",
    changes,
    apply: () => send(api, "PATCH", `repos/${input.repo}`, MERGE_SETTINGS),
  };
}

function desiredRules(input: ProtectInput): Json[] {
  return [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: input.requiredApprovals,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["squash"],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: REQUIRED_CHECKS.map((context) => ({
          context,
          integration_id: GITHUB_ACTIONS_APP_ID,
        })),
      },
    },
  ];
}

/** Deep equality for the JSON values in a ruleset, ignoring array order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const key = (value: unknown) => JSON.stringify(value);
    const left = a.map(key).sort();
    const right = b.map(key).sort();
    return left.every((value, i) => value === right[i]);
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameJson(a[key], b[key]));
  }
  return a === b;
}

/** True when every rule The Hollow sets is present with the same parameters. Extra rules are fine. */
function rulesMatch(current: unknown[], desired: Json[]): boolean {
  return desired.every((rule) => {
    const found = current.find((item) => stringAt(item, "type") === rule.type);
    if (found === undefined) return false;
    const want = objectAt(rule, "parameters");
    if (want === undefined) return true;
    const have = objectAt(found, "parameters") ?? {};
    return Object.entries(want).every(([key, value]) => sameJson(have[key], value));
  });
}

async function rulesetStep(
  api: GitHubApi,
  input: ProtectInput,
  notes: string[],
  mayBeUnavailable: boolean,
): Promise<Step> {
  const branch = input.defaultBranch;
  const title = `Branch rules for ${branch}`;
  const list = await api.request(
    "GET",
    `repos/${input.repo}/rulesets?includes_parents=false&per_page=100`,
  );
  if (!ok(list)) return skipped("Branch rules", title, errorMessage(list));
  const rulesets = Array.isArray(list.data) ? list.data : [];
  const others = rulesets
    .filter(
      (item) => stringAt(item, "name") !== RULESET_NAME && stringAt(item, "target") === "branch",
    )
    .map((item) => `"${stringAt(item, "name")}"`);
  if (others.length > 0) {
    notes.push(
      `This repo has other branch rulesets too (${others.join(", ")}). The Hollow adds its own "${RULESET_NAME}" ruleset and leaves those alone; where several apply to ${branch}, GitHub enforces the strictest rule from each.`,
    );
  }
  const summary = rulesets.find(
    (item) => stringAt(item, "name") === RULESET_NAME && stringAt(item, "target") === "branch",
  );
  const id = numberAt(summary, "id");
  let current: unknown;
  if (id !== undefined) {
    const detail = await api.request("GET", `repos/${input.repo}/rulesets/${id}`);
    if (ok(detail)) current = detail.data;
  }

  const desired = desiredRules(input);
  const include = [`refs/heads/${branch}`];
  const currentRules = arrayAt(current, "rules");
  const matches =
    current !== undefined &&
    stringAt(current, "enforcement") === "active" &&
    arrayAt(current, "bypass_actors").length === 0 &&
    sameJson(arrayAt(objectAt(objectAt(current, "conditions"), "ref_name"), "include"), include) &&
    arrayAt(objectAt(objectAt(current, "conditions"), "ref_name"), "exclude").length === 0 &&
    rulesMatch(currentRules, desired);

  // Keep any rules someone added to this ruleset by hand (signed commits, for example).
  const ours = new Set(desired.map((rule) => rule.type));
  const extra = currentRules.filter((rule) => !ours.has(stringAt(rule, "type") ?? ""));
  const body = {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include, exclude: [] } },
    rules: [...desired, ...extra],
  };
  const approvals = input.requiredApprovals;
  const changes = [
    ...(current === undefined ? [] : [`Update the existing "${RULESET_NAME}" ruleset to match:`]),
    `Changes to ${branch} only through pull requests, with ${approvals} required approval${approvals === 1 ? "" : "s"}${approvals === 0 ? " (raise it with protection.requiredApprovals in hollow.yml)" : ", reset when new commits are pushed"}`,
    `Required checks: ${REQUIRED_CHECKS.map((check) => `"${check}"`).join(" and ")}, accepted only from GitHub Actions`,
    `Review conversations resolved before merging, squash merges only, no force pushes or deleting ${branch}, and no one can bypass these rules`,
  ];
  return {
    group: "Branch rules",
    title: current === undefined ? `${title} (new "${RULESET_NAME}" ruleset)` : title,
    status: matches ? "ok" : "change",
    changes: matches ? [] : changes,
    mayBeUnavailable,
    apply: () =>
      id === undefined
        ? send(api, "POST", `repos/${input.repo}/rulesets`, body)
        : send(api, "PUT", `repos/${input.repo}/rulesets/${id}`, body),
  };
}

async function hasClassicProtection(api: GitHubApi, input: ProtectInput): Promise<boolean> {
  const response = await api.request(
    "GET",
    `repos/${input.repo}/branches/${input.defaultBranch}/protection`,
  );
  return response.status === 200;
}

async function missingWorkflows(api: GitHubApi, input: ProtectInput): Promise<string[]> {
  const missing: string[] = [];
  for (const file of [".github/workflows/ci.yml", ".github/workflows/pr-title.yml"]) {
    const response = await api.request(
      "GET",
      `repos/${input.repo}/contents/${file}?ref=${encodeURIComponent(input.defaultBranch)}`,
    );
    if (response.status === 404) missing.push(file);
  }
  return missing;
}

function reviewerKeys(environment: unknown): string[] {
  const rule = arrayAt(environment, "protection_rules").find(
    (item) => stringAt(item, "type") === "required_reviewers",
  );
  return arrayAt(rule, "reviewers").map(
    (item) => `${stringAt(item, "type")}:${numberAt(objectAt(item, "reviewer"), "id")}`,
  );
}

function preventsSelfReview(environment: unknown): boolean {
  const rule = arrayAt(environment, "protection_rules").find(
    (item) => stringAt(item, "type") === "required_reviewers",
  );
  return isObject(rule) && rule.prevent_self_review === true;
}

async function environmentStep(
  api: GitHubApi,
  input: ProtectInput,
  name: string,
  reviewers: Reviewer[] | null,
  notes: string[],
  mayBeUnavailable: boolean,
): Promise<Step> {
  const branch = input.defaultBranch;
  const base = `repos/${input.repo}/environments/${name}`;
  const current = await api.request("GET", base);
  const exists = current.status === 200;
  if (!exists && current.status !== 404) {
    return skipped("Environments", `Environment ${name}`, errorMessage(current));
  }

  let policies: unknown[] = [];
  if (exists) {
    const response = await api.request("GET", `${base}/deployment-branch-policies?per_page=100`);
    if (ok(response)) policies = arrayAt(response.data, "branch_policies");
  }
  const policy = objectAt(current.data, "deployment_branch_policy");
  const customPolicy =
    policy?.custom_branch_policies === true && policy.protected_branches === false;
  const isOurs = (item: unknown) =>
    stringAt(item, "name") === branch && (stringAt(item, "type") ?? "branch") === "branch";
  const hasBranch = policies.some(isOurs);
  const others = policies.filter((item) => !isOurs(item)).map((item) => stringAt(item, "name"));
  if (others.length > 0) {
    notes.push(
      `Environment ${name} also allows deploys from ${others.join(", ")}. The Hollow left ${others.length === 1 ? "it" : "them"} in place; remove ${others.length === 1 ? "it" : "them"} if only ${branch} should deploy.`,
    );
  }

  const changes: string[] = [];
  if (!exists) changes.push(`Create it, with deploys allowed only from ${branch}`);
  else if (!customPolicy || !hasBranch) changes.push(`Allow deploys only from ${branch}`);

  if (reviewers !== null) {
    const want = reviewers.map((reviewer) => `${reviewer.type}:${reviewer.id}`);
    const sameReviewers = exists && sameJson(reviewerKeys(current.data), want);
    const sameSelfReview = exists && preventsSelfReview(current.data) === input.preventSelfReview;
    if (!sameReviewers || !sameSelfReview) {
      const who = reviewers.map((reviewer) => reviewer.label).join(", ");
      const self = input.preventSelfReview
        ? "approvers cannot approve deploys they started"
        : `${reviewers.length === 1 ? "they" : "approvers"} can approve deploys they started`;
      changes.push(`Every deploy waits for approval from ${who} (${self})`);
    }
  }

  const body: Json = {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  if (reviewers !== null) {
    body.reviewers = reviewers.map((reviewer) => ({ type: reviewer.type, id: reviewer.id }));
    body.prevent_self_review = input.preventSelfReview;
  }
  return {
    group: "Environments",
    title: `Environment ${name}`,
    status: changes.length > 0 ? "change" : "ok",
    changes,
    mayBeUnavailable,
    apply: async () => {
      await send(api, "PUT", base, body);
      if (!hasBranch) {
        await send(api, "POST", `${base}/deployment-branch-policies`, {
          name: branch,
          type: "branch",
        });
      }
    },
  };
}

async function actionsStep(api: GitHubApi, input: ProtectInput, notes: string[]): Promise<Step> {
  const path = `repos/${input.repo}/actions/permissions/workflow`;
  const title = "GitHub Actions";
  const current = await api.request("GET", path);
  if (!ok(current)) return skipped(title, title, errorMessage(current));
  const readOnly = stringAt(current.data, "default_workflow_permissions") === "read";
  const canOpenPrs =
    isObject(current.data) && current.data.can_approve_pull_request_reviews === true;
  const secret = input.releaseTokenSecret;
  // The one setting that lets Actions open pull requests also lets it approve them, which would
  // get around a required review. So it is only turned on when no approval is required.
  const wantPrs = secret !== null && input.requiredApprovals === 0;

  if (secret !== null && input.requiredApprovals > 0 && !canOpenPrs) {
    notes.push(
      `release-please needs a token to open its release pull request here: add a fine-grained token with Contents and Pull requests write access as the ${secret} secret. (GitHub's setting that would also allow it lets workflows approve pull requests, which would get around your required review.)`,
    );
  }
  if (input.requiredApprovals > 0 && canOpenPrs) {
    notes.push(
      `GitHub Actions is allowed to approve pull requests, which can get around the required review. Consider turning it off (Settings > Actions > General)${secret === null ? "" : ` and giving release-please the ${secret} secret instead`}.`,
    );
  }

  const changes: string[] = [];
  if (!readOnly) {
    changes.push(
      "Workflow tokens are read-only unless a workflow asks for more (The Hollow's workflows ask for exactly what they need)",
    );
  }
  if (wantPrs && !canOpenPrs) {
    changes.push(
      "GitHub Actions can open pull requests, so release-please can open its release pull request",
    );
  }
  return {
    group: title,
    title,
    status: changes.length > 0 ? "change" : "ok",
    changes,
    apply: () =>
      send(api, "PUT", path, {
        default_workflow_permissions: "read",
        can_approve_pull_request_reviews: wantPrs || canOpenPrs,
      }),
  };
}

async function securitySteps(
  api: GitHubApi,
  input: ProtectInput,
  repo: unknown,
  tier: Tier,
): Promise<Step[]> {
  const group = "Security";
  const base = `repos/${input.repo}`;
  const steps: Step[] = [];

  const analysis = objectAt(repo, "security_and_analysis");
  const scanning = stringAt(objectAt(analysis, "secret_scanning"), "status") === "enabled";
  const pushProtection =
    stringAt(objectAt(analysis, "secret_scanning_push_protection"), "status") === "enabled";
  const scanningChanges: string[] = [];
  if (!scanning)
    scanningChanges.push("Secret scanning: alerts for tokens and keys committed to the repo");
  if (!pushProtection) {
    scanningChanges.push("Push protection: pushes that contain a recognised secret are blocked");
  }
  if (scanningChanges.length > 0 && tier !== "public") {
    scanningChanges.push(
      "(private repos need GitHub Secret Protection; skipped if the plan does not include it)",
    );
  }
  steps.push({
    group,
    title: "Secret scanning and push protection",
    status: scanningChanges.length > 0 ? "change" : "ok",
    changes: scanningChanges,
    mayBeUnavailable: tier !== "public",
    apply: () =>
      send(api, "PATCH", base, {
        security_and_analysis: {
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "enabled" },
        },
      }),
  });

  const alerts = await api.request("GET", `${base}/vulnerability-alerts`);
  steps.push({
    group,
    title: "Dependabot alerts",
    status: alerts.status === 204 ? "ok" : "change",
    changes:
      alerts.status === 204
        ? []
        : ["Dependabot alerts for known vulnerabilities in your dependencies"],
    apply: () => send(api, "PUT", `${base}/vulnerability-alerts`),
  });

  const fixes = await api.request("GET", `${base}/automated-security-fixes`);
  const fixesOn = ok(fixes) && isObject(fixes.data) && fixes.data.enabled === true;
  steps.push({
    group,
    title: "Dependabot security fixes",
    status: fixesOn ? "ok" : "change",
    changes: fixesOn
      ? []
      : ["Dependabot security fixes: pull requests that update vulnerable dependencies"],
    apply: () => send(api, "PUT", `${base}/automated-security-fixes`),
  });

  if (tier === "public") {
    const reporting = await api.request("GET", `${base}/private-vulnerability-reporting`);
    const reportingOn =
      ok(reporting) && isObject(reporting.data) && reporting.data.enabled === true;
    steps.push({
      group,
      title: "Private vulnerability reporting",
      status: reportingOn ? "ok" : "change",
      changes: reportingOn
        ? []
        : [
            "Private vulnerability reporting, so people can report security issues without posting them in public",
          ],
      apply: () => send(api, "PUT", `${base}/private-vulnerability-reporting`),
    });
  } else {
    steps.push(
      skipped(group, "Private vulnerability reporting", "only available for public repos"),
    );
  }
  return steps;
}

export type StepOutcome =
  | { step: Step; status: "done" }
  | { step: Step; status: "unavailable" | "failed"; message: string };

/** Apply every step that has changes, in order. A failed step does not stop the others. */
export async function applyProtection(
  plan: ProtectPlan,
  report: (outcome: StepOutcome) => void,
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const step of plan.steps) {
    if (step.status !== "change" || step.apply === undefined) continue;
    let outcome: StepOutcome;
    try {
      await step.apply();
      outcome = { step, status: "done" };
    } catch (error) {
      const message = (error as Error).message;
      const refused =
        error instanceof StepError &&
        [403, 404, 422].includes(error.status) &&
        step.mayBeUnavailable === true;
      outcome = { step, status: refused ? "unavailable" : "failed", message };
    }
    outcomes.push(outcome);
    report(outcome);
  }
  return outcomes;
}
