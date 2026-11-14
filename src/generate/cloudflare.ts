import type { CloudflarePlan, DeployEnvironment, DeployPlan } from "../pipeline/deploy.js";
import type { PipelinePlan, ReleasePlan } from "../pipeline/plan.js";
import { checkout, installBinary, lines, setupSteps } from "./ci.js";
import { addProductionGate, DISPATCH, FROM_RUN, type ReleaseSource, sourceEnv } from "./gate.js";
import { ACTIONS, BINARIES, NPM_TOOLS } from "./pins.js";
import {
  GATE_COMMENT,
  healthCheck,
  type Job,
  MANUAL_COMMENT,
  RELEASED,
  releaseEnv,
  releasePleaseJob,
  type Step,
} from "./release.js";
import { expr, renderGenerated } from "./render.js";
import { renderPreview } from "./vercel.js";

const ASSETS = "release-assets";

/**
 * Cloudflare Workers: every merge uploads a new version of the production Worker without
 * serving it (`wrangler versions upload`). Its Version URL is staging. A release deploys that
 * exact version to 100%, so production runs the bundle staging ran. Version URLs use the
 * production Worker's bindings, and are public unless the Worker is behind Cloudflare Access.
 *
 * Cloudflare Pages: every merge builds once and deploys the output to the `staging` branch (a
 * preview deployment with its own variables). A release deploys that same output to the
 * production branch.
 */
export function renderCloudflarePipeline(
  plan: PipelinePlan,
  release: ReleasePlan,
  deploy: DeployPlan,
): string {
  const cf = deploy.cloudflare as CloudflarePlan;
  const workers = cf.kind === "workers";
  const jobs: Record<string, Job> = { "release-please": releasePleaseJob(release, true) };
  const staging = deploy.environments.find((environment) => environment.name === "staging");
  if (staging !== undefined) {
    jobs["deploy-staging"] = workers
      ? workersStagingJob(plan, deploy, cf, staging)
      : pagesStagingJob(plan, deploy, cf, staging);
  }
  jobs[ASSETS] = releaseAssetsJob(workers);
  let previous = "deploy-staging";
  for (const environment of deploy.environments) {
    if (environment.name === "staging" || environment.name === "production") continue;
    const id = `deploy-${environment.name}`;
    jobs[id] = pagesReleaseJob(plan, deploy, cf, environment, previous, FROM_RUN);
    previous = id;
  }
  const production = deploy.environments.find((environment) => environment.name === "production");
  const last = previous;
  const gated = addProductionGate(
    jobs,
    (source) =>
      workers
        ? workersProductionJob(plan, cf, production as DeployEnvironment, last, source)
        : pagesReleaseJob(plan, deploy, cf, production as DeployEnvironment, last, source),
    workers ? "worker" : "archive",
  );
  return renderGenerated(
    {
      name: "Release",
      on: { push: { branches: [plan.defaultBranch] }, ...DISPATCH },
      permissions: {},
      jobs: gated,
    },
    {
      about: [
        workers
          ? "Every merge uploads a new Worker version for staging. Merging the release pull request deploys that same version."
          : "Every merge builds once and deploys to the staging branch. Merging the release pull request deploys that same output to production.",
      ],
      comments: {
        "jobs.release-please": `Uses the ${release.tokenSecret} secret when set, so release pull requests run CI; otherwise the workflow token.`,
        "jobs.deploy-staging": workers
          ? "Uploads a version of the production Worker without serving it. Its Version URL is staging, and a release deploys this exact version."
          : "Builds once, attests the output, and deploys it as a preview on the staging branch.",
        [`jobs.${ASSETS}`]:
          "A release attaches the build, its SBOM and what was deployed. Provenance was attested when it was built.",
        "jobs.deploy-production": workers
          ? "Waits for the production environment's approval, then sends all traffic to the staged version."
          : "Waits for the production environment's approval, then deploys the staged output to the production branch.",
        "jobs.production-gate": GATE_COMMENT,
        "jobs.deploy-production-manual": MANUAL_COMMENT,
      },
    },
  );
}

function cloudflareEnv(cf: CloudflarePlan): Record<string, string> {
  return {
    CLOUDFLARE_API_TOKEN: expr(`secrets.${cf.tokenSecret}`),
    CLOUDFLARE_ACCOUNT_ID: expr(`vars.${cf.accountIdVariable}`),
  };
}

/** Install dependencies (and the pinned wrangler when the project has none), then check setup. */
function prepare(plan: PipelinePlan, cf: CloudflarePlan, source?: ReleaseSource): Step[] {
  // A manual run deploys an older release, so it works from that release's tag.
  const steps: Step[] = [
    source?.manual ? checkout({ ref: source.tag }) : checkout(),
    ...setupSteps(plan),
  ];
  steps.push({ name: "Install dependencies", run: lines(plan.install) });
  if (cf.pinnedWrangler) {
    const pin = NPM_TOOLS.wrangler;
    steps.push({
      name: `Install wrangler ${pin.version}`,
      env: { URL: pin.url, SHA512: pin.sha512 },
      run: lines([
        'curl --fail --silent --show-error --location --retry 3 --output "$RUNNER_TEMP/wrangler.tgz" "$URL"',
        'echo "$SHA512  $RUNNER_TEMP/wrangler.tgz" | sha512sum --check --strict',
        'npm install --global --ignore-scripts --no-audit --no-fund "$RUNNER_TEMP/wrangler.tgz"',
      ]),
    });
  }
  steps.push({
    name: "Confirm the Cloudflare token and account ID",
    env: cloudflareEnv(cf),
    run: lines([
      'if [ -z "$CLOUDFLARE_API_TOKEN" ]; then',
      `  echo "::error title=Missing secret::Add a Cloudflare API token as the ${cf.tokenSecret} secret (Settings > Secrets and variables > Actions)."`,
      "  exit 1",
      "fi",
      'if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then',
      `  echo "::error title=Missing variable::Add your Cloudflare account ID as the ${cf.accountIdVariable} variable."`,
      "  exit 1",
      "fi",
    ]),
  });
  return steps;
}

/** Tar a folder, write an SBOM, attest both, and keep them for the release. */
function attestAndKeep(folder: string, id: string): Step[] {
  return [
    {
      name: "Package what was built",
      id,
      env: { FOLDER: folder },
      run: lines([
        'file="$RUNNER_TEMP/$(basename "$GITHUB_REPOSITORY")-$GITHUB_SHA.tar.gz"',
        'tar --create --gzip --file "$file" --directory "$FOLDER" .',
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
      with: { "subject-path": expr(`steps.${id}.outputs.file`) },
    },
    {
      name: "Attest the SBOM",
      uses: ACTIONS.attest.uses,
      with: {
        "subject-path": expr(`steps.${id}.outputs.file`),
        "sbom-path": `${expr("runner.temp")}/sbom.spdx.json`,
      },
    },
    {
      name: "Keep the build and SBOM for the release",
      uses: ACTIONS.uploadArtifact.uses,
      with: {
        name: ASSETS,
        path: `${expr(`steps.${id}.outputs.file`)}\n${expr("runner.temp")}/sbom.spdx.json\n`,
        "retention-days": 30,
        "if-no-files-found": "error",
      },
    },
  ];
}

function stagingBase(environment: DeployEnvironment, outputs: Record<string, string>): Job {
  return {
    name: "Deploy to staging",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 30,
    environment:
      environment.url === null
        ? environment.name
        : { name: environment.name, url: environment.url },
    concurrency: { group: "deploy-staging", "cancel-in-progress": false },
    permissions: { contents: "read", "id-token": "write", attestations: "write" },
    outputs,
  };
}

/** Check staging's own URL when hollow.yml sets one, otherwise the URL the deploy reported. */
function stagingCheck(deploy: DeployPlan, staging: DeployEnvironment, reported: string): Step {
  if (staging.healthUrl !== null) return healthCheck(staging.healthUrl);
  return {
    ...healthCheck(`${expr(reported)}${deploy.healthPath}`),
    if: expr(`${reported} != ''`),
  };
}

function workersStagingJob(
  plan: PipelinePlan,
  deploy: DeployPlan,
  cf: CloudflarePlan,
  staging: DeployEnvironment,
): Job {
  return {
    ...stagingBase(staging, {
      version: expr("steps.upload.outputs.version"),
      url: expr("steps.upload.outputs.url"),
    }),
    steps: [
      ...prepare(plan, cf),
      {
        name: "Upload a new version without serving it",
        id: "upload",
        env: cloudflareEnv(cf),
        run: lines([
          'export WRANGLER_OUTPUT_FILE_PATH="$RUNNER_TEMP/wrangler.ndjson"',
          `${cf.wrangler} versions upload --preview-alias staging --tag "$GITHUB_SHA" --message "Staging $GITHUB_SHA" --outdir "$RUNNER_TEMP/bundle"`,
          'entry="$(jq --compact-output \'select(.type == "version-upload")\' "$WRANGLER_OUTPUT_FILE_PATH" | tail -n 1)"',
          'version="$(echo "$entry" | jq --raw-output \'.version_id // empty\')"',
          'url="$(echo "$entry" | jq --raw-output \'.preview_alias_url // .preview_url // empty\')"',
          'if [ -z "$version" ]; then',
          '  echo "::error title=Upload::wrangler did not report the uploaded version."',
          "  exit 1",
          "fi",
          'echo "version=$version" >> "$GITHUB_OUTPUT"',
          'echo "url=$url" >> "$GITHUB_OUTPUT"',
          'if [ -z "$url" ]; then',
          '  echo "::warning title=No Version URL::Set preview_urls = true in the Wrangler config so staging can be checked. Workers with Durable Objects never get one."',
          "fi",
          'echo "Uploaded version $version for staging: $url" >> "$GITHUB_STEP_SUMMARY"',
        ]),
      },
      ...attestAndKeep(`${expr("runner.temp")}/bundle`, "package"),
      stagingCheck(deploy, staging, "steps.upload.outputs.url"),
    ],
  };
}

function pagesDeployRun(cf: CloudflarePlan, folder: string, branch: string): string {
  return lines([
    'export WRANGLER_OUTPUT_FILE_PATH="$RUNNER_TEMP/wrangler.ndjson"',
    `${cf.wrangler} pages deploy "${folder}" --project-name "$PROJECT" --branch "${branch}" --commit-hash "$GITHUB_SHA"`,
    'entry="$(jq --compact-output \'select(.type == "pages-deploy-detailed")\' "$WRANGLER_OUTPUT_FILE_PATH" | tail -n 1)"',
    'url="$(echo "$entry" | jq --raw-output \'.alias // .url // empty\')"',
    'environment="$(echo "$entry" | jq --raw-output \'.environment // empty\')"',
    'echo "url=$url" >> "$GITHUB_OUTPUT"',
    'echo "environment=$environment" >> "$GITHUB_OUTPUT"',
    'echo "Deployed to $environment: $url" >> "$GITHUB_STEP_SUMMARY"',
  ]);
}

function pagesStagingJob(
  plan: PipelinePlan,
  deploy: DeployPlan,
  cf: CloudflarePlan,
  staging: DeployEnvironment,
): Job {
  return {
    ...stagingBase(staging, { url: expr("steps.deploy.outputs.url") }),
    steps: [
      ...prepare(plan, cf),
      { name: "Build", run: cf.build as string },
      ...attestAndKeep(cf.outputDir as string, "package"),
      {
        name: "Deploy to the staging branch",
        id: "deploy",
        env: {
          ...cloudflareEnv(cf),
          PROJECT: cf.projectName as string,
          OUTPUT_DIR: cf.outputDir as string,
        },
        run: pagesDeployRun(cf, "$OUTPUT_DIR", "staging"),
      },
      stagingCheck(deploy, staging, "steps.deploy.outputs.url"),
    ],
  };
}

function releaseAssetsJob(workers: boolean): Job {
  const deployed = workers
    ? 'echo "$VERSION_ID" > "$RUNNER_TEMP/assets/worker-version.txt"'
    : 'echo "$STAGING_URL" > "$RUNNER_TEMP/assets/staging-url.txt"';
  return {
    name: "Attach the release assets",
    needs: ["release-please", "deploy-staging"],
    if: expr(RELEASED),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 10,
    permissions: { contents: "write" },
    steps: [
      {
        name: "Fetch the build and SBOM",
        uses: ACTIONS.downloadArtifact.uses,
        with: { name: ASSETS, path: `${expr("runner.temp")}/assets` },
      },
      {
        name: "Attach them to the release",
        env: {
          ...releaseEnv(),
          GH_TOKEN: expr("github.token"),
          ...(workers
            ? { VERSION_ID: expr("needs.deploy-staging.outputs.version") }
            : { STAGING_URL: expr("needs.deploy-staging.outputs.url") }),
        },
        run: lines([
          deployed,
          'gh release upload "$TAG" "$RUNNER_TEMP"/assets/* --repo "$GITHUB_REPOSITORY" --clobber',
        ]),
      },
    ],
  };
}

function releaseJobBase(environment: DeployEnvironment, previous: string): Job {
  return {
    name: `Deploy to ${environment.name}`,
    needs: [
      "release-please",
      "deploy-staging",
      ASSETS,
      ...(previous === "deploy-staging" ? [] : [previous]),
    ],
    if: expr(RELEASED),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 20,
    environment:
      environment.url === null
        ? environment.name
        : { name: environment.name, url: environment.url },
    concurrency: { group: `deploy-${environment.name}`, "cancel-in-progress": false },
    permissions: { contents: "read" },
  };
}

function workersProductionJob(
  plan: PipelinePlan,
  cf: CloudflarePlan,
  environment: DeployEnvironment,
  previous: string,
  source: ReleaseSource,
): Job {
  const steps: Step[] = [
    ...prepare(plan, cf, source),
    {
      name: "Note the version production serves now",
      id: "current",
      env: cloudflareEnv(cf),
      run: lines([
        `previous="$(${cf.wrangler} deployments status --json 2> /dev/null | jq --raw-output '[.. | objects | select(has("percentage") and .percentage == 100) | (.version_id // .versionId // empty)][0] // empty' || true)"`,
        'echo "previous=$previous" >> "$GITHUB_OUTPUT"',
      ]),
    },
    {
      name: "Send all traffic to the staged version",
      id: "promote",
      env: {
        ...cloudflareEnv(cf),
        ...sourceEnv(source),
        VERSION_ID: source.workerVersion,
      },
      run: lines([
        `${cf.wrangler} versions deploy "$VERSION_ID@100%" --yes --message "Release $TAG"`,
        'echo "Deployed version $VERSION_ID ($TAG) to production" >> "$GITHUB_STEP_SUMMARY"',
      ]),
    },
  ];
  if (environment.healthUrl !== null) {
    steps.push(healthCheck(environment.healthUrl), {
      name: "Roll back",
      if: expr("failure() && steps.promote.outcome == 'success'"),
      env: {
        ...cloudflareEnv(cf),
        ...sourceEnv(source),
        PREVIOUS: expr("steps.current.outputs.previous"),
      },
      run: lines([
        'if [ -z "$PREVIOUS" ]; then',
        '  echo "::warning title=Rollback::Could not tell which version production served before, so nothing was rolled back."',
        "  exit 0",
        "fi",
        `${cf.wrangler} versions deploy "$PREVIOUS@100%" --yes --message "Roll back $TAG"`,
        'echo "::error title=Rolled back::Production is back on version $PREVIOUS."',
      ]),
    });
  }
  return { ...releaseJobBase(environment, previous), steps };
}

/** Pages preprod and production: deploy the staged output (not a rebuild) to their branch. */
function pagesReleaseJob(
  plan: PipelinePlan,
  deploy: DeployPlan,
  cf: CloudflarePlan,
  environment: DeployEnvironment,
  previous: string,
  source: ReleaseSource,
): Job {
  const production = environment.name === "production";
  const api = `https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PROJECT`;
  // A fresh object per step: shared objects would render as YAML anchors.
  const env = () => ({ ...cloudflareEnv(cf), PROJECT: cf.projectName as string });
  const steps: Step[] = [...prepare(plan, cf, source)];
  // A manual run already has the release's archive in $RUNNER_TEMP/assets.
  if (!source.manual) {
    steps.push({
      name: "Fetch the staged build",
      uses: ACTIONS.downloadArtifact.uses,
      with: { name: ASSETS, path: `${expr("runner.temp")}/assets` },
    });
  }
  steps.push({
    name: "Unpack it",
    run: lines([
      'mkdir -p "$RUNNER_TEMP/site"',
      'tar --extract --gzip --file "$(ls "$RUNNER_TEMP"/assets/*.tar.gz)" --directory "$RUNNER_TEMP/site"',
    ]),
  });
  if (production && environment.healthUrl !== null) {
    steps.push({
      name: "Note the deployment production serves now",
      id: "current",
      env: env(),
      run: lines([
        `previous="$(curl --fail --silent --show-error --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "${api}" | jq --raw-output '.result.canonical_deployment.id // empty' || true)"`,
        'echo "previous=$previous" >> "$GITHUB_OUTPUT"',
      ]),
    });
  }
  const branch = production ? plan.defaultBranch : environment.name;
  steps.push({
    name: `Deploy the staged build to the ${branch} branch`,
    id: "promote",
    env: env(),
    run: lines([
      pagesDeployRun(cf, "$RUNNER_TEMP/site", branch).trimEnd(),
      ...(production
        ? [
            'if [ "$environment" != "production" ]; then',
            `  echo "::error title=Not production::Cloudflare made a $environment deployment. Set the Pages project's production branch to ${branch}."`,
            "  exit 1",
            "fi",
          ]
        : []),
    ]),
  });
  const checked =
    environment.healthUrl ?? `${expr("steps.promote.outputs.url")}${deploy.healthPath}`;
  steps.push(healthCheck(checked));
  if (production && environment.healthUrl !== null) {
    steps.push({
      name: "Roll back",
      if: expr("failure() && steps.promote.outcome == 'success'"),
      env: { ...env(), PREVIOUS: expr("steps.current.outputs.previous") },
      run: lines([
        'if [ -z "$PREVIOUS" ]; then',
        '  echo "::warning title=Rollback::Could not tell which deployment production served before, so nothing was rolled back."',
        "  exit 0",
        "fi",
        `curl --fail --silent --show-error --request POST --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "${api}/deployments/$PREVIOUS/rollback" > /dev/null`,
        'echo "::error title=Rolled back::Production is back on deployment $PREVIOUS."',
      ]),
    });
  }
  return { ...releaseJobBase(environment, previous), steps };
}

/** Pages previews: build the pull request and deploy it to its own preview branch. */
export function renderPagesPreview(plan: PipelinePlan, cf: CloudflarePlan): string {
  const steps = prepare(plan, cf).slice(1 + setupSteps(plan).length);
  return renderPreview(
    plan,
    [
      ...steps,
      { name: "Build", run: cf.build as string },
      {
        name: "Deploy to a preview branch",
        id: "deploy",
        env: {
          ...cloudflareEnv(cf),
          PROJECT: cf.projectName as string,
          OUTPUT_DIR: cf.outputDir as string,
          PR: expr("github.event.pull_request.number"),
        },
        run: pagesDeployRun(cf, "$OUTPUT_DIR", "pr-$PR"),
      },
    ],
    "A Cloudflare Pages preview for each pull request from a branch in this repo, using the preview environment's variables.",
  );
}
