import type { PipelinePlan } from "../pipeline/plan.js";
import { settingsFor } from "../secrets/catalog.js";
import { MARKDOWN_MARKER } from "./render.js";
import { INCIDENT_LABEL } from "./scheduled.js";

export const PIPELINE_DOC = "docs/PIPELINE.md";

const TARGET_NAMES: Record<string, string> = {
  docker: "a container image on GHCR",
  vps: "your server over SSH",
  vercel: "Vercel",
  "cloudflare-workers": "Cloudflare Workers",
  "cloudflare-pages": "Cloudflare Pages",
};

function rollback(plan: PipelinePlan): string {
  switch (plan.deploy?.target) {
    case "docker":
      return "Each environment is a tag (`:staging`, `:production`) on the image. A failed health check moves the tag back to the previous digest automatically. To roll back by hand, run the Release workflow with an earlier version: it deploys that release's own image.";
    case "vps":
      return "A failed health check, or a container that never becomes healthy, puts the previous image back on the server automatically. To roll back by hand, run the Release workflow with an earlier version. Database migrations are not rolled back; see docs/migrations.md.";
    case "vercel":
      return "A failed production health check runs `vercel rollback` to the deployment that was live before. To roll back by hand, use Instant Rollback in the Vercel dashboard, or run the Release workflow with an earlier version to promote that release's deployment.";
    case "cloudflare-workers":
      return "A failed production health check sends all traffic back to the version that served before. To roll back by hand, run `wrangler rollback`, or run the Release workflow with an earlier version.";
    case "cloudflare-pages":
      return "A failed production health check rolls back through the Cloudflare API to the deployment that was live before. To roll back by hand, use the Pages dashboard, or run the Release workflow with an earlier version.";
    default:
      return "Nothing deploys yet. Set deploy.target in hollow.yml and run `npx the-hollow upgrade`.";
  }
}

function table(rows: string[][]): string {
  const [head, ...body] = rows;
  if (head === undefined) return "";
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...body.map((row) => `| ${row.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`),
  ].join("\n");
}

/** `docs/PIPELINE.md`: what each stage does, which secrets to add, and how to roll back. */
export function renderPipelineDoc(plan: PipelinePlan): string {
  const out: string[] = [
    `${MARKDOWN_MARKER} from hollow.yml. Do not edit by hand: change hollow.yml, then run \`npx the-hollow upgrade\`. -->`,
    "",
    "# How this pipeline works",
    "",
    "Every workflow here is generated from `hollow.yml`. To change the pipeline, change `hollow.yml` and run `npx the-hollow upgrade`. `npx the-hollow fix` explains a failing run (and repairs it, if you configured a model), and `npx the-hollow doctor` checks the whole setup.",
    "",
    "## On every pull request",
    "",
    "`ci.yml` runs these jobs, and the `CI passed` check sums them up for branch protection:",
    "",
    `- **Build and test:** installs from the lockfile (\`${plan.install.join(" && ")}\`), then runs:`,
    ...plan.checks.map((check) => `  - ${check.name}: \`${check.run}\``),
  ];
  if (plan.migrations !== null) {
    out.push(`  - the ${plan.migrations.tool} migrations, applied to a throwaway database`);
  }
  out.push(
    "- **Secret scan:** Gitleaks over the whole git history.",
    `- **Dependency scan:** OSV-Scanner on the lockfiles; fails on ${plan.security.failOn} or worse.`,
    `- **SAST:** ${plan.security.sast === "auto" ? "CodeQL on public repos, Semgrep on private ones" : plan.security.sast === "codeql" ? "CodeQL" : "Semgrep"}.`,
  );
  if (plan.dockerfile !== null || plan.release?.artifact.kind === "image") {
    out.push("- **Container:** builds the image and scans it with Trivy.");
  }
  out.push(
    "",
    "`pr-title.yml` requires a Conventional Commit title, since squash merges turn it into the changelog.",
  );
  if (plan.migrations !== null) {
    out.push(
      "",
      `\`migrations.yml\` (the \`Migration safety\` check) fails on destructive migrations unless the pull request has the \`${plan.migrations.label}\` label. See docs/migrations.md.`,
    );
  }
  if (plan.deploy?.previews) {
    out.push(
      "",
      "`preview.yml` deploys a preview of each pull request from a branch in this repo and posts its URL.",
    );
  }

  const deploy = plan.deploy;
  out.push("", "## Releases and deploys", "");
  if (deploy === null) {
    out.push(
      plan.release === null
        ? "No deploy target is set, so nothing is released or deployed."
        : "`release.yml` keeps a release pull request up to date with release-please. Merging it tags a version and publishes one artifact with an SBOM and provenance. No deploy target is set, so nothing is deployed.",
    );
  } else {
    out.push(
      `\`release.yml\` deploys to ${TARGET_NAMES[deploy.target] ?? deploy.target}. Every merge to \`${plan.defaultBranch}\` deploys to staging. release-please keeps a release pull request open; merging it tags a version and promotes the exact build staging ran${deploy.environments.some((e) => e.name === "preprod") ? " to preprod, then" : ""} to production, which waits for approval. Nothing is rebuilt on the way.`,
      "",
      "Production waits for the `production` environment's required reviewers. Where GitHub offers none (private repos without Enterprise), the release stops before production, and someone with write access approves it by running the Release workflow with the version: `gh workflow run release.yml -f version=v1.2.3`.",
      "",
      table([
        ["Environment", "URL", "Deploys"],
        ...deploy.environments.map((environment) => [
          environment.name,
          environment.url ?? "(set in hollow.yml)",
          environment.onRelease ? "on release" : "on every merge",
        ]),
      ]),
      "",
      `After each deploy, the environment's URL plus \`${deploy.healthPath}\` must answer without a server error within two minutes.`,
    );
    if (plan.migrations?.deploy) {
      out.push(
        "",
        "Each deploy applies the database migrations before its new code goes live. See docs/migrations.md.",
      );
    }
  }

  out.push("", "## Rolling back", "", rollback(plan));

  const settings = settingsFor(plan);
  out.push("", "## Secrets and variables", "");
  if (settings.length === 0) {
    out.push("The pipeline needs no secrets beyond the workflow token GitHub provides.");
  } else {
    out.push(
      "`npx the-hollow secrets` lists which are set and offers to set the missing ones. Values never go in a file.",
      "",
      table([
        ["Name", "Kind", "Where", "Needed", "What for"],
        ...settings.map((setting) => [
          `\`${setting.name}\``,
          setting.kind,
          setting.environment === null ? "repo" : `${setting.environment} environment`,
          setting.required ? "yes" : "optional",
          setting.purpose,
        ]),
      ]),
    );
  }

  const ops = plan.operations;
  out.push("", "## Scheduled checks and incidents", "");
  if (ops.synthetic !== null) {
    out.push(
      `\`scheduled.yml\` checks ${ops.synthetic.targets.map((t) => `${t.environment} (${t.url})`).join(", ")} every ${ops.synthetic.every}. GitHub delays scheduled runs when it is busy, and turns off schedules in public repos after 60 days without activity, so treat this as a baseline, not uptime monitoring.`,
    );
  }
  if (ops.nightlyScan !== null) {
    out.push(
      "",
      "Every night it re-scans the default branch's dependencies, since new vulnerabilities are published without any code changing.",
    );
  }
  if (ops.synthetic === null && ops.nightlyScan === null) {
    out.push("No scheduled checks are set up.");
  }
  const where = [
    ops.issues ? `an incident issue labelled \`${INCIDENT_LABEL}\`` : null,
    ops.slackSecret ? "a Slack message" : null,
    ops.discordSecret ? "a Discord message" : null,
  ].filter((part) => part !== null);
  out.push(
    "",
    where.length === 0
      ? "Failures show only in the Actions tab and GitHub's own notifications."
      : `A failing synthetic check, nightly scan or production deploy raises ${where.join(" and ")}. Repeats add a comment instead of a new issue, and the issue closes itself once the check passes again.`,
  );
  return `${out.join("\n")}\n`;
}
