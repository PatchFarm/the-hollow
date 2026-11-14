import type { DeployEnvironment, DeployPlan, VercelPlan } from "../pipeline/deploy.js";
import type { PipelinePlan, ReleasePlan } from "../pipeline/plan.js";
import { checkout, installBinary, lines, setupSteps } from "./ci.js";
import { ACTIONS, BINARIES, NPM_TOOLS } from "./pins.js";
import {
  healthCheck,
  type Job,
  RELEASED,
  releaseEnv,
  releasePleaseJob,
  type Step,
} from "./release.js";
import { expr, renderGenerated } from "./render.js";

export const PREVIEW_WORKFLOW = ".github/workflows/preview.yml";
export const VERCEL_JSON = "vercel.json";

const ASSETS = "release-assets";

/**
 * Vercel: every merge makes one production build and deploys it staged (`--skip-domain`), which
 * is staging. A release promotes that exact deployment, so production runs the build staging
 * ran, with no rebuild. Staging therefore uses production's environment variables; previews
 * (preview.yml) use Preview's.
 */
export function renderVercelPipeline(
  plan: PipelinePlan,
  release: ReleasePlan,
  deploy: DeployPlan,
): string {
  const vercel = deploy.vercel as VercelPlan;
  const staging = deploy.environments.find((environment) => environment.name === "staging");
  const jobs: Record<string, Job> = {
    "release-please": releasePleaseJob(release, true),
  };
  if (staging !== undefined) jobs["deploy-staging"] = stagingJob(plan, deploy, vercel, staging);
  jobs[ASSETS] = releaseAssetsJob();
  let previous = "deploy-staging";
  for (const environment of deploy.environments) {
    if (environment.name === "staging") continue;
    const id = `deploy-${environment.name}`;
    jobs[id] =
      environment.name === "production"
        ? productionJob(vercel, environment, previous)
        : aliasJob(deploy, vercel, environment, previous);
    previous = id;
  }
  return renderGenerated(
    { name: "Release", on: { push: { branches: [plan.defaultBranch] } }, permissions: {}, jobs },
    {
      about: [
        "Every merge deploys a staged production build to staging. Merging the release pull request promotes that same deployment.",
      ],
      comments: {
        "jobs.release-please": `Uses the ${release.tokenSecret} secret when set, so release pull requests run CI; otherwise the workflow token.`,
        "jobs.deploy-staging":
          "Builds once with production settings and deploys without taking the production domains. This deployment is what a release promotes.",
        [`jobs.${ASSETS}`]:
          "A release attaches the build output, its SBOM and the deployment URL. Provenance was attested when it was built.",
        "jobs.deploy-production":
          "Waits for the production environment's approval, then promotes the staged deployment. Nothing is rebuilt.",
      },
    },
  );
}

/** Project and team IDs for every Vercel CLI call, so it needs no `vercel link`. */
function projectEnv(vercel: VercelPlan): Record<string, string> {
  return {
    VERCEL_ORG_ID: expr(`vars.${vercel.orgIdVariable}`),
    VERCEL_PROJECT_ID: expr(`vars.${vercel.projectIdVariable}`),
  };
}

function tokenEnv(vercel: VercelPlan): Record<string, string> {
  return { ...projectEnv(vercel), VERCEL_TOKEN: expr(`secrets.${vercel.tokenSecret}`) };
}

function installVercel(): Step {
  const pin = NPM_TOOLS.vercel;
  return {
    name: `Install the Vercel CLI ${pin.version}`,
    env: { URL: pin.url, SHA512: pin.sha512 },
    run: lines([
      'curl --fail --silent --show-error --location --retry 3 --output "$RUNNER_TEMP/vercel.tgz" "$URL"',
      'echo "$SHA512  $RUNNER_TEMP/vercel.tgz" | sha512sum --check --strict',
      'npm install --global --ignore-scripts --no-audit --no-fund "$RUNNER_TEMP/vercel.tgz"',
    ]),
  };
}

/** Pull the environment's settings and variables; stops with a clear message if setup is missing. */
function pullSettings(vercel: VercelPlan, environment: "production" | "preview"): Step {
  return {
    name: `Pull the ${environment} settings from Vercel`,
    env: tokenEnv(vercel),
    run: lines([
      'if [ -z "$VERCEL_TOKEN" ]; then',
      `  echo "::error title=Missing secret::Add a Vercel token as the ${vercel.tokenSecret} secret (Settings > Secrets and variables > Actions)."`,
      "  exit 1",
      "fi",
      'if [ -z "$VERCEL_ORG_ID" ] || [ -z "$VERCEL_PROJECT_ID" ]; then',
      `  echo "::error title=Missing variables::Add the ${vercel.orgIdVariable} and ${vercel.projectIdVariable} variables (the orgId and projectId from .vercel/project.json after \\\`vercel link\\\`)."`,
      "  exit 1",
      "fi",
      `vercel pull --yes --environment=${environment} --token "$VERCEL_TOKEN"`,
    ]),
  };
}

/** Deploy the prebuilt output and write its URL to the step's `url` output. */
function deployStep(vercel: VercelPlan, flags: string, summary: string): Step {
  return {
    name: "Deploy",
    id: "deploy",
    env: tokenEnv(vercel),
    run: lines([
      `vercel deploy --prebuilt ${flags}--token "$VERCEL_TOKEN" > "$RUNNER_TEMP/deploy.out"`,
      // The CLI prints the URL, or a JSON document in non-interactive mode; both contain it.
      'host="$(grep -Eo \'[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.vercel\\.app\' "$RUNNER_TEMP/deploy.out" | head -n 1 || true)"',
      'if [ -z "$host" ]; then',
      '  echo "::error title=Deploy::Could not find the deployment URL in the Vercel CLI output:"',
      '  cat "$RUNNER_TEMP/deploy.out"',
      "  exit 1",
      "fi",
      'echo "url=https://$host" >> "$GITHUB_OUTPUT"',
      `echo "${summary} https://$host" >> "$GITHUB_STEP_SUMMARY"`,
    ]),
  };
}

function environmentKey(environment: DeployEnvironment): string | { name: string; url: string } {
  return environment.url === null
    ? environment.name
    : { name: environment.name, url: environment.url };
}

function hostOf(url: string): string {
  return new URL(url).host;
}

function stagingJob(
  plan: PipelinePlan,
  deploy: DeployPlan,
  vercel: VercelPlan,
  staging: DeployEnvironment,
): Job {
  const steps: Step[] = [
    checkout(),
    ...setupSteps(plan),
    installVercel(),
    pullSettings(vercel, "production"),
    {
      // No token here: the build runs the project's own scripts.
      name: "Build with production settings",
      env: projectEnv(vercel),
      run: "vercel build --prod",
    },
    {
      name: "Package the build output",
      id: "package",
      run: lines([
        'file="$RUNNER_TEMP/$(basename "$GITHUB_REPOSITORY")-$GITHUB_SHA.tar.gz"',
        'tar --create --gzip --file "$file" --directory .vercel/output .',
        'echo "file=$file" >> "$GITHUB_OUTPUT"',
      ]),
    },
    installBinary("syft", "Syft", BINARIES.syft, true),
    {
      name: "Generate the SBOM",
      run: '"$RUNNER_TEMP/syft" scan dir:. --output "spdx-json=$RUNNER_TEMP/sbom.spdx.json"',
    },
    {
      name: "Attest build provenance",
      uses: ACTIONS.attest.uses,
      with: { "subject-path": expr("steps.package.outputs.file") },
    },
    {
      name: "Attest the SBOM",
      uses: ACTIONS.attest.uses,
      with: {
        "subject-path": expr("steps.package.outputs.file"),
        "sbom-path": `${expr("runner.temp")}/sbom.spdx.json`,
      },
    },
    {
      name: "Keep the build output and SBOM for the release",
      uses: ACTIONS.uploadArtifact.uses,
      with: {
        name: ASSETS,
        path: `${expr("steps.package.outputs.file")}\n${expr("runner.temp")}/sbom.spdx.json\n`,
        "retention-days": 30,
        "if-no-files-found": "error",
      },
    },
    deployStep(vercel, "--prod --skip-domain ", "Staged production deployment:"),
  ];
  let checked = `${expr("steps.deploy.outputs.url")}${deploy.healthPath}`;
  if (staging.url !== null) {
    steps.push(aliasStep(vercel, expr("steps.deploy.outputs.url"), hostOf(staging.url)));
    checked = staging.healthUrl ?? checked;
  }
  steps.push(healthCheck(checked, vercel.bypassSecret));
  return {
    name: "Deploy to staging",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 30,
    environment: environmentKey(staging),
    concurrency: { group: "deploy-staging", "cancel-in-progress": false },
    permissions: { contents: "read", "id-token": "write", attestations: "write" },
    outputs: { url: expr("steps.deploy.outputs.url") },
    steps,
  };
}

function aliasStep(vercel: VercelPlan, deployment: string, host: string): Step {
  return {
    name: `Point ${host} at the deployment`,
    env: { ...tokenEnv(vercel), DEPLOYMENT: deployment, HOST: host },
    run: 'vercel alias set "$DEPLOYMENT" "$HOST" --token "$VERCEL_TOKEN"',
  };
}

function releaseAssetsJob(): Job {
  return {
    name: "Attach the release assets",
    needs: ["release-please", "deploy-staging"],
    if: expr(RELEASED),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 10,
    permissions: { contents: "write" },
    steps: [
      {
        name: "Fetch the build output and SBOM",
        uses: ACTIONS.downloadArtifact.uses,
        with: { name: ASSETS, path: `${expr("runner.temp")}/assets` },
      },
      {
        name: "Attach them to the release",
        env: {
          ...releaseEnv(),
          GH_TOKEN: expr("github.token"),
          DEPLOYMENT: expr("needs.deploy-staging.outputs.url"),
        },
        run: lines([
          'echo "$DEPLOYMENT" > "$RUNNER_TEMP/assets/deployment-url.txt"',
          'gh release upload "$TAG" "$RUNNER_TEMP"/assets/* --repo "$GITHUB_REPOSITORY" --clobber',
        ]),
      },
    ],
  };
}

function releaseJob(name: string, environment: DeployEnvironment, previous: string): Job {
  return {
    name,
    needs: [
      "release-please",
      "deploy-staging",
      ASSETS,
      ...(previous === "deploy-staging" ? [] : [previous]),
    ],
    if: expr(RELEASED),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 20,
    environment: environmentKey(environment),
    concurrency: { group: `deploy-${environment.name}`, "cancel-in-progress": false },
    permissions: {},
  };
}

/** Preprod: point its domain at the staged deployment and check it before production. */
function aliasJob(
  deploy: DeployPlan,
  vercel: VercelPlan,
  environment: DeployEnvironment,
  previous: string,
): Job {
  const url = environment.url as string;
  return {
    ...releaseJob(`Deploy to ${environment.name}`, environment, previous),
    steps: [
      installVercel(),
      aliasStep(vercel, expr("needs.deploy-staging.outputs.url"), hostOf(url)),
      healthCheck(environment.healthUrl ?? `${url}${deploy.healthPath}`, vercel.bypassSecret),
    ],
  };
}

/** Production: promote the staged deployment, check it, and roll back to the previous one. */
function productionJob(vercel: VercelPlan, environment: DeployEnvironment, previous: string): Job {
  const deployment = expr("needs.deploy-staging.outputs.url");
  const steps: Step[] = [installVercel()];
  const host = environment.url === null ? null : hostOf(environment.url);
  if (host !== null) {
    steps.push({
      name: `Note what ${host} serves now`,
      id: "current",
      env: { ...tokenEnv(vercel), HOST: host },
      run: lines([
        'previous="$(vercel inspect "$HOST" --token "$VERCEL_TOKEN" 2>&1 | grep -Eo \'[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.vercel\\.app\' | grep -v -x -F "$HOST" | head -n 1 || true)"',
        'echo "previous=$previous" >> "$GITHUB_OUTPUT"',
      ]),
    });
  }
  steps.push({
    name: "Promote the staged deployment",
    id: "promote",
    env: { ...tokenEnv(vercel), DEPLOYMENT: deployment },
    run: lines([
      'vercel promote "$DEPLOYMENT" --yes --timeout 5m --token "$VERCEL_TOKEN"',
      'echo "Promoted $DEPLOYMENT to production" >> "$GITHUB_STEP_SUMMARY"',
    ]),
  });
  if (environment.healthUrl !== null) {
    steps.push(healthCheck(environment.healthUrl, vercel.bypassSecret), {
      name: "Roll back",
      if: expr("failure() && steps.promote.outcome == 'success'"),
      env: { ...tokenEnv(vercel), PREVIOUS: expr("steps.current.outputs.previous") },
      run: lines([
        'if [ -z "$PREVIOUS" ]; then',
        '  echo "::warning title=Rollback::Could not tell which deployment production served before, so nothing was rolled back."',
        "  exit 0",
        "fi",
        'vercel rollback "https://$PREVIOUS" --timeout 5m --token "$VERCEL_TOKEN"',
        'echo "::error title=Rolled back::Production is back on https://$PREVIOUS."',
      ]),
    });
  }
  return { ...releaseJob("Deploy to production", environment, previous), steps };
}

/**
 * `.github/workflows/preview.yml`: a Preview deploy for each pull request from a branch in this
 * repo, with the URL in a PR comment. Fork pull requests never get the token, so they are skipped,
 * as are Dependabot's (Dependabot runs get no Actions secrets).
 */
export function renderPreviewWorkflow(plan: PipelinePlan, vercel: VercelPlan): string {
  const marker = "<!-- hollow-preview -->";
  const job: Job = {
    name: "Preview deploy",
    if: expr(
      "github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'",
    ),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 30,
    permissions: { contents: "read", "pull-requests": "write" },
    steps: [
      checkout(),
      ...setupSteps(plan),
      installVercel(),
      pullSettings(vercel, "preview"),
      { name: "Build with preview settings", env: projectEnv(vercel), run: "vercel build" },
      deployStep(vercel, "", "Preview deployment:"),
      {
        name: "Post the preview URL on the pull request",
        env: {
          GH_TOKEN: expr("github.token"),
          PR: expr("github.event.pull_request.number"),
          SHA: expr("github.event.pull_request.head.sha"),
          URL: expr("steps.deploy.outputs.url"),
          MARKER: marker,
        },
        run: lines([
          'body="$(printf \'%s\\n\\nPreview of %s: %s\' "$MARKER" "$SHA" "$URL")"',
          'id="$(gh api "repos/$GITHUB_REPOSITORY/issues/$PR/comments" --paginate --jq ".[] | select(.body | startswith(\\"$MARKER\\")) | .id" | head -n 1)"',
          'if [ -n "$id" ]; then',
          '  gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$body" > /dev/null',
          "else",
          '  gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$PR/comments" -f body="$body" > /dev/null',
          "fi",
        ]),
      },
    ],
  };
  return renderGenerated(
    {
      name: "Preview",
      on: { pull_request: { types: ["opened", "synchronize", "reopened"] } },
      permissions: {},
      concurrency: {
        group: `preview-${expr("github.event.pull_request.number")}`,
        "cancel-in-progress": true,
      },
      jobs: { preview: job },
    },
    {
      about: [
        "A Vercel Preview deploy for each pull request from a branch in this repo, using Preview's environment variables.",
      ],
      comments: { concurrency: "A new push replaces the preview that was still building." },
    },
  );
}

/** Starter vercel.json: turns off Vercel's own Git deploys, so only the pipeline deploys. */
export function renderVercelJson(): string {
  return `${JSON.stringify(
    { $schema: "https://openapi.vercel.sh/vercel.json", git: { deploymentEnabled: false } },
    null,
    2,
  )}\n`;
}
