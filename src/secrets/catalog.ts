import type { PipelinePlan } from "../pipeline/plan.js";

/**
 * A secret or variable the generated pipeline reads. Repo-scoped ones are shared by every job;
 * environment-scoped ones differ per environment (each server has its own SSH key, say).
 */
export interface Setting {
  name: string;
  kind: "secret" | "variable";
  /** null for the repo; otherwise the environment that holds it. */
  environment: string | null;
  required: boolean;
  /** What it is for, in a few words. */
  purpose: string;
  /** How to ask for it: hidden for single-line secrets, a file for multi-line ones. */
  input: "hidden" | "visible" | "file" | "keyscan";
  /** Where to find the value, shown when asking. */
  hint?: string;
  /** For host keys: the server to scan. */
  server?: { host: string; port: number };
}

/** Every secret and variable the generated workflows read, worked out from the plan. */
export function settingsFor(plan: PipelinePlan): Setting[] {
  const settings: Setting[] = [];
  const deploy = plan.deploy;
  if (deploy?.vps) {
    const vps = deploy.vps;
    for (const environment of deploy.environments) {
      settings.push(
        {
          name: vps.sshKeySecret,
          kind: "secret",
          environment: environment.name,
          required: true,
          purpose: `SSH private key the ${environment.name} deploy uses to reach ${vps.host}`,
          input: "file",
          hint: `the private key whose public key is in ${vps.user}'s ~/.ssh/authorized_keys on ${vps.host}`,
        },
        {
          name: vps.knownHostsVariable,
          kind: "variable",
          environment: environment.name,
          required: true,
          purpose: `${vps.host}'s SSH host key, so deploys only talk to that server`,
          input: "keyscan",
          hint: `ssh-keyscan -p ${vps.sshPort} ${vps.host}`,
          server: { host: vps.host, port: vps.sshPort },
        },
      );
    }
  }
  if (deploy?.vercel) {
    const vercel = deploy.vercel;
    settings.push(
      {
        name: vercel.tokenSecret,
        kind: "secret",
        environment: null,
        required: true,
        purpose: "Vercel token for builds and deploys",
        input: "hidden",
        hint: "create one at https://vercel.com/account/tokens",
      },
      {
        name: vercel.orgIdVariable,
        kind: "variable",
        environment: null,
        required: true,
        purpose: "Vercel team (org) ID",
        input: "visible",
        hint: "orgId in .vercel/project.json after `npx vercel link`",
      },
      {
        name: vercel.projectIdVariable,
        kind: "variable",
        environment: null,
        required: true,
        purpose: "Vercel project ID",
        input: "visible",
        hint: "projectId in .vercel/project.json after `npx vercel link`",
      },
      {
        name: vercel.bypassSecret,
        kind: "secret",
        environment: null,
        required: false,
        purpose: "lets health checks reach protected Vercel URLs",
        input: "hidden",
        hint: "Project Settings > Deployment Protection > Protection Bypass for Automation",
      },
    );
  }
  if (deploy?.cloudflare) {
    const cf = deploy.cloudflare;
    settings.push(
      {
        name: cf.tokenSecret,
        kind: "secret",
        environment: null,
        required: true,
        purpose: `Cloudflare API token (${cf.kind === "workers" ? "Workers Scripts: Edit" : "Cloudflare Pages: Edit"})`,
        input: "hidden",
        hint: "create one at https://dash.cloudflare.com/profile/api-tokens",
      },
      {
        name: cf.accountIdVariable,
        kind: "variable",
        environment: null,
        required: true,
        purpose: "Cloudflare account ID",
        input: "visible",
        hint: "shown on the Workers & Pages overview in the Cloudflare dashboard",
      },
    );
  }
  const migrations = plan.migrations?.deploy;
  if (migrations?.where === "runner") {
    for (const environment of migrations.environments) {
      // Vercel's preprod serves the staged deployment, which runs with production's settings.
      const shared = deploy?.vercel && environment !== "production";
      settings.push({
        name: migrations.secret,
        kind: "secret",
        environment,
        required: true,
        purpose: shared
          ? `production's database URL: ${environment} runs with production's settings and migrates it first`
          : `${environment}'s database URL, so its deploy applies migrations first`,
        input: "hidden",
        hint: "the connection string the app uses, for example postgresql://user:password@host:5432/app",
      });
    }
  }
  const ops = plan.operations;
  for (const [name, service] of [
    [ops.slackSecret, "Slack"],
    [ops.discordSecret, "Discord"],
  ] as const) {
    if (name === null) continue;
    settings.push({
      name,
      kind: "secret",
      environment: null,
      required: true,
      purpose: `${service} incoming webhook URL for failure and recovery alerts`,
      input: "hidden",
      hint:
        service === "Slack"
          ? "create an incoming webhook for your channel at https://api.slack.com/apps"
          : "Server Settings > Integrations > Webhooks in Discord",
    });
  }
  if (plan.release !== null) {
    settings.push({
      name: plan.release.tokenSecret,
      kind: "secret",
      environment: null,
      required: false,
      purpose: "token release-please uses, so CI runs on release pull requests",
      input: "hidden",
      hint: "a fine-grained token with Contents and Pull requests write access to this repo",
    });
  }
  return settings;
}

export function label(setting: Setting): string {
  return setting.environment === null ? setting.name : `${setting.name} (${setting.environment})`;
}
