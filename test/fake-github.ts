import type { ApiResponse, GitHubApi, Method } from "../src/github/api.js";

type Json = Record<string, unknown>;

interface Environment {
  deployment_branch_policy: Json | null;
  reviewers: { type: string; id: number }[] | null;
  prevent_self_review: boolean;
  policies: { name: string; type: string }[];
}

/** The parts of a GitHub repo and account `hollow protect` reads and writes. */
export interface FakeState {
  signedIn: boolean;
  login: string;
  userId: number;
  /** The signed-in user's plan; absent when the token cannot see it. */
  userPlan?: string;
  owner: string;
  ownerType: "User" | "Organization";
  /** The org's plan, visible to org owners only. */
  orgPlan?: string;
  name: string;
  private: boolean;
  admin: boolean;
  defaultBranch: string;
  merge: Json;
  analysis: Json;
  /** Whether a private repo has GitHub Secret Protection. */
  secretProtection: boolean;
  users: Record<string, number>;
  teams: Record<string, number>;
  rulesets: (Json & { id: number })[];
  environments: Record<string, Environment>;
  workflow: { default_workflow_permissions: string; can_approve_pull_request_reviews: boolean };
  alerts: boolean;
  fixes: boolean;
  reporting: boolean;
  classicProtection: boolean;
  files: string[];
  /** Names only: the fake, like GitHub, never hands out secret values. */
  repoSecrets: string[];
  repoVariables: string[];
  envSecrets: Record<string, string[]>;
  envVariables: Record<string, string[]>;
  /** Force a response for `METHOD path` (path without the query string). */
  refuse: Record<string, { status: number; message: string }>;
  /** Workflow runs. Each listing moves a run one state along its `states`, then it stays put. */
  runs: FakeRun[];
  pulls: {
    number: number;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }[];
  comments: { issue: number; body: string }[];
  reruns: number[];
}

export interface FakeJob {
  id: number;
  name: string;
  conclusion: string;
  steps: { name: string; conclusion: string }[];
  log: string;
}

export interface FakeRun {
  id: number;
  name: string;
  head_sha: string;
  /** The branch it ran on, for listings by branch. */
  branch?: string;
  states: { status: string; conclusion: string | null }[];
  jobs: FakeJob[];
}

export interface Request {
  method: Method;
  path: string;
  body: unknown;
}

export function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    signedIn: true,
    login: "octocat",
    userId: 1,
    owner: "octocat",
    ownerType: "User",
    name: "demo",
    private: false,
    admin: true,
    defaultBranch: "main",
    merge: {
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
      squash_merge_commit_message: "COMMIT_MESSAGES",
      delete_branch_on_merge: false,
    },
    analysis: {
      secret_scanning: { status: "disabled" },
      secret_scanning_push_protection: { status: "disabled" },
    },
    secretProtection: false,
    users: { octocat: 1, hubot: 2 },
    teams: {},
    rulesets: [],
    environments: {},
    workflow: { default_workflow_permissions: "write", can_approve_pull_request_reviews: false },
    alerts: false,
    fixes: false,
    reporting: false,
    classicProtection: false,
    files: [".github/workflows/ci.yml", ".github/workflows/pr-title.yml"],
    repoSecrets: [],
    repoVariables: [],
    envSecrets: {},
    envVariables: {},
    refuse: {},
    runs: [],
    pulls: [],
    comments: [],
    reruns: [],
    ...overrides,
  };
}

const PLAN_REQUIRED =
  "Upgrade to GitHub Pro or make this repository public to enable this feature.";

/** A GitHub that keeps its state in memory and logs every request. */
export class FakeGitHub implements GitHubApi {
  readonly requests: Request[] = [];
  private nextId = 100;

  constructor(readonly state: FakeState) {}

  /** Requests that would change something on GitHub. */
  get writes(): Request[] {
    return this.requests.filter((request) => request.method !== "GET");
  }

  async request(method: Method, path: string, body?: unknown): Promise<ApiResponse> {
    this.requests.push({ method, path, body });
    const bare = path.split("?")[0] ?? path;
    const forced = this.state.refuse[`${method} ${bare}`];
    if (forced !== undefined) return { status: forced.status, data: { message: forced.message } };
    return this.route(method, bare, path, body as Json | undefined);
  }

  private readonly polls = new Map<number, number>();

  /** The run as GitHub would show it now, moving it one state along for next time. */
  private advance(run: FakeRun): Json {
    const index = this.polls.get(run.id) ?? 0;
    this.polls.set(run.id, Math.min(index + 1, run.states.length - 1));
    const state = run.states[index] ?? run.states[run.states.length - 1];
    return {
      id: run.id,
      name: run.name,
      status: state?.status,
      conclusion: state?.conclusion,
      html_url: `https://github.com/${this.state.owner}/${this.state.name}/actions/runs/${run.id}`,
    };
  }

  private get freePrivate(): boolean {
    if (!this.state.private) return false;
    const plan = this.state.ownerType === "User" ? this.state.userPlan : this.state.orgPlan;
    return plan === "free";
  }

  private get approvalsAllowed(): boolean {
    if (!this.state.private) return true;
    const plan = this.state.ownerType === "User" ? this.state.userPlan : this.state.orgPlan;
    return plan === "enterprise";
  }

  private route(method: Method, path: string, full: string, body: Json | undefined): ApiResponse {
    const s = this.state;
    const repo = `repos/${s.owner}/${s.name}`;
    const json = (data: unknown, status = 200): ApiResponse => ({ status, data });
    const notFound = json({ message: "Not Found" }, 404);
    const key = `${method} ${path}`;

    if (key === "GET user") {
      if (!s.signedIn) return json({ message: "Requires authentication" }, 401);
      return json({
        login: s.login,
        id: s.userId,
        ...(s.userPlan ? { plan: { name: s.userPlan } } : {}),
      });
    }
    if (method === "GET" && path.startsWith("users/")) {
      const login = path.slice("users/".length);
      const id = s.users[login];
      return id === undefined ? notFound : json({ login, id });
    }
    if (method === "GET" && /^orgs\/[^/]+$/.test(path)) {
      return json(s.orgPlan ? { login: s.owner, plan: { name: s.orgPlan } } : { login: s.owner });
    }
    const team = /^orgs\/([^/]+)\/teams\/([^/]+)$/.exec(path);
    if (method === "GET" && team) {
      const id = s.teams[`${team[1]}/${team[2]}`];
      return id === undefined ? notFound : json({ id, slug: team[2] });
    }
    if (method === "POST" && path === "graphql") {
      const id = (body?.variables as { id?: string } | undefined)?.id;
      const pull = s.pulls.find((p) => `PR_${p.number}` === id);
      if (pull === undefined) return json({ errors: [{ message: "Could not resolve to a node" }] });
      pull.draft = true;
      return json({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } });
    }
    if (!path.startsWith(repo)) return notFound;
    const rest = path.slice(repo.length);

    if (rest === "" && method === "GET") {
      return json({
        full_name: `${s.owner}/${s.name}`,
        private: s.private,
        default_branch: s.defaultBranch,
        owner: { login: s.owner, type: s.ownerType },
        permissions: { admin: s.admin },
        ...s.merge,
        security_and_analysis: s.analysis,
      });
    }
    if (rest === "" && method === "PATCH" && body) {
      const { security_and_analysis: analysis, ...merge } = body;
      if (analysis !== undefined) {
        if (s.private && !s.secretProtection) {
          return json({ message: "Secret scanning is not available for this repository." }, 422);
        }
        Object.assign(s.analysis, analysis);
      }
      Object.assign(s.merge, merge);
      return json({});
    }

    if (rest === "/rulesets") {
      if (this.freePrivate) return json({ message: PLAN_REQUIRED }, 403);
      if (method === "GET") {
        return json(s.rulesets.map(({ id, name, target }) => ({ id, name, target })));
      }
      const ruleset = { ...(body as Json), id: this.nextId++ };
      s.rulesets.push(ruleset);
      return json(ruleset, 201);
    }
    const ruleset = /^\/rulesets\/(\d+)$/.exec(rest);
    if (ruleset) {
      const index = s.rulesets.findIndex((item) => item.id === Number(ruleset[1]));
      if (index < 0) return notFound;
      if (method === "GET") return json(s.rulesets[index]);
      s.rulesets[index] = { ...(body as Json), id: Number(ruleset[1]) };
      return json(s.rulesets[index]);
    }
    if (rest === `/branches/${s.defaultBranch}/protection`) {
      return s.classicProtection ? json({}) : json({ message: "Branch not protected" }, 404);
    }
    if (rest.startsWith("/contents/")) {
      const file = rest.slice("/contents/".length);
      return s.files.includes(file) && full.includes(`ref=${s.defaultBranch}`)
        ? json({})
        : notFound;
    }

    const policies = /^\/environments\/([^/]+)\/deployment-branch-policies$/.exec(rest);
    if (policies) {
      const environment = s.environments[policies[1] as string];
      if (environment === undefined) return notFound;
      if (method === "GET") return json({ branch_policies: environment.policies });
      environment.policies.push(body as { name: string; type: string });
      return json(body);
    }
    const environment = /^\/environments\/([^/]+)$/.exec(rest);
    if (environment) {
      const name = environment[1] as string;
      if (this.freePrivate) return json({ message: PLAN_REQUIRED }, 403);
      const current = s.environments[name];
      if (method === "GET") {
        if (current === undefined) return notFound;
        const rules: Json[] = [];
        if (current.reviewers !== null) {
          rules.push({
            type: "required_reviewers",
            prevent_self_review: current.prevent_self_review,
            reviewers: current.reviewers.map(({ type, id }) => ({ type, reviewer: { id } })),
          });
        }
        return json({
          name,
          deployment_branch_policy: current.deployment_branch_policy,
          protection_rules: rules,
        });
      }
      if (body?.reviewers !== undefined && !this.approvalsAllowed) {
        return json({ message: "Required reviewers are not available for this repository." }, 422);
      }
      const next: Environment = current ?? {
        deployment_branch_policy: null,
        reviewers: null,
        prevent_self_review: false,
        policies: [],
      };
      if (body?.deployment_branch_policy !== undefined) {
        next.deployment_branch_policy = body.deployment_branch_policy as Json;
      }
      if (body?.reviewers !== undefined)
        next.reviewers = body.reviewers as Environment["reviewers"];
      if (body?.prevent_self_review !== undefined)
        next.prevent_self_review = body.prevent_self_review === true;
      s.environments[name] = next;
      return json({ name });
    }

    if (method === "GET" && rest === "/actions/secrets") {
      return json({
        total_count: s.repoSecrets.length,
        secrets: s.repoSecrets.map((name) => ({ name })),
      });
    }
    if (method === "GET" && rest === "/actions/variables") {
      return json({
        total_count: s.repoVariables.length,
        variables: s.repoVariables.map((name) => ({ name, value: "(not read)" })),
      });
    }
    const scoped = /^\/environments\/([^/]+)\/(secrets|variables)$/.exec(rest);
    if (method === "GET" && scoped) {
      const name = scoped[1] as string;
      if (s.environments[name] === undefined) return notFound;
      const list = (scoped[2] === "secrets" ? s.envSecrets : s.envVariables)[name] ?? [];
      return json({
        total_count: list.length,
        [scoped[2] as string]: list.map((n) => ({ name: n })),
      });
    }
    if (rest === "/actions/permissions/workflow") {
      if (method === "GET") return json(s.workflow);
      Object.assign(s.workflow, body);
      return json(null, 204);
    }
    if (rest === "/vulnerability-alerts") {
      if (method === "GET") return s.alerts ? json(null, 204) : notFound;
      s.alerts = true;
      return json(null, 204);
    }
    if (rest === "/automated-security-fixes") {
      if (method === "GET") return json({ enabled: s.fixes, paused: false });
      if (!s.alerts) return json({ message: "Vulnerability alerts are disabled." }, 422);
      s.fixes = true;
      return json(null, 204);
    }
    if (method === "GET" && rest === "/actions/runs") {
      const params = new URL(full, "https://x").searchParams;
      const sha = params.get("head_sha");
      const branch = params.get("branch");
      // "*" stands for whatever commit the test made, which it cannot know in advance.
      const matching = s.runs.filter((run) =>
        sha === null ? run.branch === branch : run.head_sha === sha || run.head_sha === "*",
      );
      return json({
        total_count: matching.length,
        workflow_runs: matching.map((run) => this.advance(run)),
      });
    }
    const runPath = /^\/actions\/runs\/(\d+)(\/jobs)?$/.exec(rest);
    if (method === "GET" && runPath) {
      const run = s.runs.find((r) => r.id === Number(runPath[1]));
      if (run === undefined) return notFound;
      if (runPath[2] === undefined) return json(this.advance(run));
      return json({
        total_count: run.jobs.length,
        jobs: run.jobs.map((job) => ({
          id: job.id,
          name: job.name,
          status: "completed",
          conclusion: job.conclusion,
          html_url: `https://github.com/${s.owner}/${s.name}/actions/runs/${run.id}/job/${job.id}`,
          steps: job.steps.map((step, index) => ({
            ...step,
            number: index + 1,
            status: "completed",
          })),
        })),
      });
    }
    const logPath = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest);
    if (method === "GET" && logPath) {
      const job = s.runs.flatMap((run) => run.jobs).find((j) => j.id === Number(logPath[1]));
      return job === undefined ? notFound : json(job.log);
    }
    if (rest === "/pulls" && method === "GET") {
      const params = new URL(full, "https://x").searchParams;
      const head = params.get("head")?.split(":")[1];
      return json(
        s.pulls
          .filter((pull) => pull.head === head)
          .map((pull) => ({
            ...pull,
            node_id: `PR_${pull.number}`,
            html_url: `https://github.com/${s.owner}/${s.name}/pull/${pull.number}`,
          })),
      );
    }
    if (rest === "/pulls" && method === "POST" && body) {
      const pull = {
        number: this.nextId++,
        head: String(body.head),
        base: String(body.base),
        title: String(body.title),
        body: String(body.body),
      };
      s.pulls.push(pull);
      return json(
        { ...pull, html_url: `https://github.com/${s.owner}/${s.name}/pull/${pull.number}` },
        201,
      );
    }
    const comments = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (method === "POST" && comments && body) {
      s.comments.push({ issue: Number(comments[1]), body: String(body.body) });
      return json({ id: this.nextId++ }, 201);
    }
    const rerun = /^\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(rest);
    if (method === "POST" && rerun) {
      s.reruns.push(Number(rerun[1]));
      return json(null, 201);
    }
    if (rest === "/private-vulnerability-reporting") {
      if (method === "GET") return json({ enabled: s.reporting });
      s.reporting = true;
      return json(null, 204);
    }
    return notFound;
  }
}
