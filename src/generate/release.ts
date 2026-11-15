import { DEPLOY_COMPOSE, type DeployEnvironment, type DeployPlan } from "../pipeline/deploy.js";
import type {
  ArchiveArtifact,
  ImageArtifact,
  PipelinePlan,
  ReleasePlan,
} from "../pipeline/plan.js";
import { checkout, installBinary, lines, setupSteps } from "./ci.js";
import { renderCloudflarePipeline } from "./cloudflare.js";
import {
  migrateFromRunner,
  migratesFromRunner,
  SCHEMA_STAYS,
  vpsMigrationLines,
} from "./deploy-migrations.js";
import { addProductionGate, DISPATCH, FROM_RUN, type ReleaseSource } from "./gate.js";
import { ACTIONS, BINARIES } from "./pins.js";
import { expr, renderGenerated } from "./render.js";
import { renderVercelPipeline } from "./vercel.js";

export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

export type Step = Record<string, unknown>;
export type Job = Record<string, unknown>;

export const RELEASE = "needs.release-please.outputs";

/**
 * `.github/workflows/release.yml`: on every push to the default branch, release-please keeps a
 * release pull request up to date. Merging it tags the version and creates the GitHub release,
 * and the artifact job then builds once, publishes, and attaches an SBOM and build provenance.
 * Deploys (M3) will promote exactly this artifact.
 */
export function renderReleaseWorkflow(plan: PipelinePlan, release: ReleasePlan): string {
  if (plan.deploy?.vercel) return renderVercelPipeline(plan, release, plan.deploy);
  if (plan.deploy?.cloudflare) return renderCloudflarePipeline(plan, release, plan.deploy);
  if (release.artifact.kind === "image" && plan.deploy !== null) {
    return renderImagePipeline(plan, release, release.artifact, plan.deploy);
  }
  const workflow = {
    name: "Release",
    on: { push: { branches: [plan.defaultBranch] } },
    permissions: {},
    concurrency: { group: "release", "cancel-in-progress": false },
    jobs: {
      "release-please": releasePleaseJob(release),
      artifact:
        release.artifact.kind === "image"
          ? imageJob(release.artifact)
          : archiveJob(plan, release.artifact),
    },
  };
  return renderGenerated(workflow, {
    about: [
      "Merging the release pull request tags a version and publishes one artifact with an SBOM and provenance.",
    ],
    comments: {
      concurrency: "Releases run one at a time and are never cancelled halfway.",
      "jobs.release-please": `Uses the ${release.tokenSecret} secret when set, so release pull requests run CI; otherwise the workflow token.`,
    },
  });
}

export function releasePleaseJob(release: ReleasePlan, ownConcurrency = false): Job {
  return {
    name: "Release PR and tag",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 10,
    // Image pipelines have no workflow-wide lock (staging deploys run while a release waits for
    // approval), so release-please keeps its own.
    ...(ownConcurrency
      ? { concurrency: { group: "release-please", "cancel-in-progress": false } }
      : {}),
    permissions: { contents: "write", "pull-requests": "write", issues: "write" },
    outputs: {
      released: expr("steps.release.outputs.release_created"),
      tag: expr("steps.release.outputs.tag_name"),
      version: expr("steps.release.outputs.version"),
    },
    steps: [
      {
        id: "release",
        uses: ACTIONS.releasePlease.uses,
        with: {
          "release-type": release.releaseType,
          token: expr(`secrets.${release.tokenSecret} || github.token`),
        },
      },
    ],
  };
}

/** Values every artifact step reads from env, never from `${{ }}` inside a script. */
export function releaseEnv(): Record<string, string> {
  return { TAG: expr(`${RELEASE}.tag`), VERSION: expr(`${RELEASE}.version`) };
}

function artifactJobBase(name: string, permissions: Record<string, string>): Job {
  return {
    name,
    needs: "release-please",
    if: expr(`${RELEASE}.released == 'true'`),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 30,
    permissions,
  };
}

function imageJob(artifact: ImageArtifact): Job {
  const steps: Step[] = [
    checkout({ ref: expr(`${RELEASE}.tag`) }),
    {
      name: "Build and push the image",
      id: "image",
      env: {
        ...releaseEnv(),
        DOCKERFILE: artifact.dockerfile,
        IMAGE_NAME: artifact.image ?? "",
        GH_TOKEN: expr("github.token"),
      },
      run: lines([
        'name="$IMAGE_NAME"',
        'if [ -z "$name" ]; then name="$GITHUB_REPOSITORY"; fi',
        "image=\"ghcr.io/$(echo \"$name\" | tr '[:upper:]' '[:lower:]')\"",
        'echo "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin',
        'docker build --file "$DOCKERFILE" \\',
        '  --label "org.opencontainers.image.source=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" \\',
        '  --label "org.opencontainers.image.revision=$GITHUB_SHA" \\',
        '  --label "org.opencontainers.image.version=$VERSION" \\',
        '  --tag "$image:$VERSION" --tag "$image:sha-$GITHUB_SHA" .',
        'docker push --all-tags "$image"',
        'digest="$(docker inspect --format \'{{index .RepoDigests 0}}\' "$image:$VERSION" | cut -d@ -f2)"',
        'echo "image=$image" >> "$GITHUB_OUTPUT"',
        'echo "digest=$digest" >> "$GITHUB_OUTPUT"',
        'echo "Published $image@$digest ($TAG)" >> "$GITHUB_STEP_SUMMARY"',
      ]),
    },
    installBinary("syft", "Syft", BINARIES.syft, true),
    {
      name: "Generate the SBOM",
      env: { IMAGE: expr("steps.image.outputs.image"), DIGEST: expr("steps.image.outputs.digest") },
      run: '"$RUNNER_TEMP/syft" scan "registry:$IMAGE@$DIGEST" --output "spdx-json=$RUNNER_TEMP/sbom.spdx.json"',
    },
    {
      name: "Attest build provenance",
      uses: ACTIONS.attest.uses,
      with: {
        "subject-name": expr("steps.image.outputs.image"),
        "subject-digest": expr("steps.image.outputs.digest"),
        "push-to-registry": true,
      },
    },
    {
      name: "Attest the SBOM",
      uses: ACTIONS.attest.uses,
      with: {
        "subject-name": expr("steps.image.outputs.image"),
        "subject-digest": expr("steps.image.outputs.digest"),
        "sbom-path": `${expr("runner.temp")}/sbom.spdx.json`,
        "push-to-registry": true,
      },
    },
    {
      name: "Attach the SBOM and image digest to the release",
      env: {
        ...releaseEnv(),
        GH_TOKEN: expr("github.token"),
        IMAGE: expr("steps.image.outputs.image"),
        DIGEST: expr("steps.image.outputs.digest"),
      },
      run: lines([
        'echo "$IMAGE@$DIGEST" > "$RUNNER_TEMP/image-digest.txt"',
        'gh release upload "$TAG" "$RUNNER_TEMP/sbom.spdx.json" "$RUNNER_TEMP/image-digest.txt" --repo "$GITHUB_REPOSITORY" --clobber',
      ]),
    },
  ];
  return {
    ...artifactJobBase("Publish the image", {
      contents: "write",
      packages: "write",
      "id-token": "write",
      attestations: "write",
    }),
    steps,
  };
}

function archiveJob(plan: PipelinePlan, artifact: ArchiveArtifact): Job {
  const steps: Step[] = [checkout({ ref: expr(`${RELEASE}.tag`) })];
  if (artifact.outputDir !== null && artifact.build !== null) {
    steps.push(...setupSteps(plan));
    steps.push({ name: "Install dependencies", run: lines(plan.install) });
    steps.push({ name: "Build", run: artifact.build });
  }
  steps.push({
    name:
      artifact.outputDir === null
        ? "Package the source at the tag"
        : `Package the build output (${artifact.outputDir})`,
    id: "package",
    env: { ...releaseEnv(), OUTPUT_DIR: artifact.outputDir ?? "" },
    run: lines(
      artifact.outputDir === null
        ? [
            'name="$(basename "$GITHUB_REPOSITORY")-$VERSION"',
            'file="$RUNNER_TEMP/$name.tar.gz"',
            'git archive --format=tar.gz --prefix="$name/" --output "$file" HEAD',
            'echo "file=$file" >> "$GITHUB_OUTPUT"',
          ]
        : [
            'file="$RUNNER_TEMP/$(basename "$GITHUB_REPOSITORY")-$VERSION.tar.gz"',
            'tar --create --gzip --file "$file" --directory "$OUTPUT_DIR" .',
            'echo "file=$file" >> "$GITHUB_OUTPUT"',
          ],
    ),
  });
  steps.push(installBinary("syft", "Syft", BINARIES.syft, true), {
    name: "Generate the SBOM",
    run: '"$RUNNER_TEMP/syft" scan dir:. --output "spdx-json=$RUNNER_TEMP/sbom.spdx.json"',
  });
  steps.push(
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
      name: "Attach the archive and SBOM to the release",
      env: {
        ...releaseEnv(),
        GH_TOKEN: expr("github.token"),
        FILE: expr("steps.package.outputs.file"),
      },
      run: 'gh release upload "$TAG" "$FILE" "$RUNNER_TEMP/sbom.spdx.json" --repo "$GITHUB_REPOSITORY" --clobber',
    },
  );
  return {
    ...artifactJobBase("Publish the release archive", {
      contents: "write",
      "id-token": "write",
      attestations: "write",
    }),
    steps,
  };
}

const BUILD = "needs.build.outputs";
export const RELEASED = `${RELEASE}.released == 'true'`;

/**
 * Image targets build once on every merge to the default branch, deploy that image to staging,
 * and promote the very same digest to preprod and production when a release is cut.
 */
function renderImagePipeline(
  plan: PipelinePlan,
  release: ReleasePlan,
  artifact: ImageArtifact,
  deploy: DeployPlan,
): string {
  const jobs: Record<string, Job> = {
    "release-please": releasePleaseJob(release, true),
    build: buildImageJob(artifact),
    "release-assets": releaseAssetsJob(),
  };
  const comments: Record<string, string> = {
    "jobs.release-please": `Uses the ${release.tokenSecret} secret when set, so release pull requests run CI; otherwise the workflow token.`,
    "jobs.build": "Every merge builds the image once. Every environment runs this exact digest.",
    "jobs.release-assets":
      "A release tags the image with its version and attaches the SBOM and digest.",
  };
  let previous: string | null = null;
  let production: DeployEnvironment | null = null;
  for (const environment of deploy.environments) {
    if (environment.name === "production") {
      production = environment;
      continue;
    }
    const id = `deploy-${environment.name}`;
    jobs[id] = deployJob(plan, deploy, environment, previous);
    previous = id;
  }
  const last = previous;
  const productionEnvironment = production as DeployEnvironment;
  comments["jobs.production-gate"] = GATE_COMMENT;
  comments["jobs.report-production"] = REPORT_COMMENT;
  comments["jobs.deploy-production"] =
    "Waits for the production environment's approval, then promotes the same digest.";
  comments["jobs.deploy-production-manual"] = MANUAL_COMMENT;
  const workflow = {
    name: "Release",
    on: { push: { branches: [plan.defaultBranch] }, ...DISPATCH },
    permissions: {},
    jobs: addProductionGate(
      jobs,
      (source) => deployJob(plan, deploy, productionEnvironment, last, source),
      "image",
      plan.operations,
    ),
  };
  return renderGenerated(workflow, {
    about: [
      "Every merge deploys to staging. Merging the release pull request promotes that same image to production.",
    ],
    comments,
  });
}

function imageEnv(): Record<string, string> {
  return { IMAGE: expr(`${BUILD}.image`), DIGEST: expr(`${BUILD}.digest`) };
}

function ghcrLogin(): Step {
  return {
    name: "Log in to GHCR",
    env: { GH_TOKEN: expr("github.token") },
    run: 'echo "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin',
  };
}

function buildImageJob(artifact: ImageArtifact): Job {
  return {
    name: "Build the image",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 30,
    permissions: {
      contents: "read",
      packages: "write",
      "id-token": "write",
      attestations: "write",
    },
    outputs: {
      image: expr("steps.image.outputs.image"),
      digest: expr("steps.image.outputs.digest"),
    },
    steps: [
      checkout(),
      ghcrLogin(),
      {
        name: "Build and push the image",
        id: "image",
        env: { DOCKERFILE: artifact.dockerfile, IMAGE_NAME: artifact.image ?? "" },
        run: lines([
          'name="$IMAGE_NAME"',
          'if [ -z "$name" ]; then name="$GITHUB_REPOSITORY"; fi',
          "image=\"ghcr.io/$(echo \"$name\" | tr '[:upper:]' '[:lower:]')\"",
          'docker build --file "$DOCKERFILE" \\',
          '  --label "org.opencontainers.image.source=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" \\',
          '  --label "org.opencontainers.image.revision=$GITHUB_SHA" \\',
          '  --tag "$image:sha-$GITHUB_SHA" .',
          'docker push "$image:sha-$GITHUB_SHA"',
          'digest="$(docker inspect --format \'{{index .RepoDigests 0}}\' "$image:sha-$GITHUB_SHA" | cut -d@ -f2)"',
          'echo "image=$image" >> "$GITHUB_OUTPUT"',
          'echo "digest=$digest" >> "$GITHUB_OUTPUT"',
          'echo "Built $image@$digest" >> "$GITHUB_STEP_SUMMARY"',
        ]),
      },
      installBinary("syft", "Syft", BINARIES.syft, true),
      {
        name: "Generate the SBOM",
        env: buildStepEnv(),
        run: '"$RUNNER_TEMP/syft" scan "registry:$IMAGE@$DIGEST" --output "spdx-json=$RUNNER_TEMP/sbom.spdx.json"',
      },
      {
        name: "Attest build provenance",
        uses: ACTIONS.attest.uses,
        with: {
          "subject-name": expr("steps.image.outputs.image"),
          "subject-digest": expr("steps.image.outputs.digest"),
          "push-to-registry": true,
        },
      },
      {
        name: "Attest the SBOM",
        uses: ACTIONS.attest.uses,
        with: {
          "subject-name": expr("steps.image.outputs.image"),
          "subject-digest": expr("steps.image.outputs.digest"),
          "sbom-path": `${expr("runner.temp")}/sbom.spdx.json`,
          "push-to-registry": true,
        },
      },
    ],
  };
}

/** Inside the build job the image comes from its own step, not from `needs`. */
function buildStepEnv(): Record<string, string> {
  return { IMAGE: expr("steps.image.outputs.image"), DIGEST: expr("steps.image.outputs.digest") };
}

function releaseAssetsJob(): Job {
  return {
    name: "Attach the release assets",
    needs: ["release-please", "build"],
    if: expr(RELEASED),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 15,
    permissions: { contents: "write", packages: "write" },
    steps: [
      ghcrLogin(),
      {
        name: "Tag the image with the version",
        env: { ...imageEnv(), VERSION: expr(`${RELEASE}.version`) },
        run: 'docker buildx imagetools create --tag "$IMAGE:$VERSION" "$IMAGE@$DIGEST"',
      },
      installBinary("syft", "Syft", BINARIES.syft, true),
      {
        name: "Attach the SBOM and image digest to the release",
        env: { ...imageEnv(), ...releaseEnv(), GH_TOKEN: expr("github.token") },
        run: lines([
          '"$RUNNER_TEMP/syft" scan "registry:$IMAGE@$DIGEST" --output "spdx-json=$RUNNER_TEMP/sbom.spdx.json"',
          'echo "$IMAGE@$DIGEST" > "$RUNNER_TEMP/image-digest.txt"',
          'gh release upload "$TAG" "$RUNNER_TEMP/sbom.spdx.json" "$RUNNER_TEMP/image-digest.txt" --repo "$GITHUB_REPOSITORY" --clobber',
        ]),
      },
    ],
  };
}

export const REPORT_COMMENT =
  "A failed production deploy opens an incident issue (label hollow-incident); the next successful one closes it.";
export const GATE_COMMENT =
  "Production deploys automatically only when its environment has required reviewers. Otherwise the release waits for a manual run.";
export const MANUAL_COMMENT =
  "A person with write access runs this workflow with a release version: that run is the approval, and it deploys the release's own artifact.";

function deployJob(
  plan: PipelinePlan,
  deploy: DeployPlan,
  environment: DeployEnvironment,
  previous: string | null,
  source: ReleaseSource = FROM_RUN,
): Job {
  const needs = environment.onRelease
    ? ["release-please", "build", "release-assets", ...(previous === null ? [] : [previous])]
    : ["build"];
  const job: Job = {
    name: `Deploy to ${environment.name}`,
    needs,
    ...(environment.onRelease ? { if: expr(RELEASED) } : {}),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 20,
    environment:
      environment.url === null
        ? environment.name
        : { name: environment.name, url: environment.url },
    concurrency: { group: `deploy-${environment.name}`, "cancel-in-progress": false },
  };
  if (deploy.vps === null) {
    const migrate = migratesFromRunner(plan, environment.name);
    return {
      ...job,
      permissions: migrate ? { contents: "read", packages: "write" } : { packages: "write" },
      steps: [
        ...(migrate ? migrateFromRunner(plan, environment.name, source) : []),
        ...registrySteps(environment, source, migrate),
      ],
    };
  }
  return {
    ...job,
    permissions: { contents: "read", packages: "read" },
    steps: vpsSteps(plan, deploy, environment, source),
  };
}

/** Docker target: move the environment's tag (`:staging`, `:production`) to the new digest. */
function registrySteps(
  environment: DeployEnvironment,
  source: ReleaseSource,
  migrated: boolean,
): Step[] {
  const env = { IMAGE: source.image, DIGEST: source.digest, TAG_NAME: environment.name };
  const steps: Step[] = [
    ghcrLogin(),
    {
      name: `Point the ${environment.name} tag at this image`,
      id: "promote",
      env,
      run: lines([
        "previous=\"$(docker buildx imagetools inspect \"$IMAGE:$TAG_NAME\" --format '{{json .Manifest}}' 2> /dev/null | jq --raw-output '.digest // empty' || true)\"",
        'echo "previous=$previous" >> "$GITHUB_OUTPUT"',
        'docker buildx imagetools create --tag "$IMAGE:$TAG_NAME" "$IMAGE@$DIGEST"',
        'echo "Deployed $IMAGE@$DIGEST as $TAG_NAME" >> "$GITHUB_STEP_SUMMARY"',
      ]),
    },
  ];
  if (environment.healthUrl !== null) {
    steps.push(healthCheck(environment.healthUrl), {
      name: "Roll back",
      if: expr("failure() && steps.promote.outcome == 'success'"),
      env: { ...env, PREVIOUS: expr("steps.promote.outputs.previous") },
      run: lines([
        'if [ -z "$PREVIOUS" ]; then',
        '  echo "::warning title=Rollback::There is no earlier $TAG_NAME image to roll back to."',
        "  exit 0",
        "fi",
        'docker buildx imagetools create --tag "$IMAGE:$TAG_NAME" "$IMAGE@$PREVIOUS"',
        `echo "::error title=Rolled back::$TAG_NAME is back on $IMAGE@$PREVIOUS.${migrated ? ` ${SCHEMA_STAYS}` : ""}"`,
      ]),
    });
  }
  return steps;
}

/** Checks the URL until it answers without a server error, for up to two minutes. */
export function healthCheck(url: string, bypassSecret?: string): Step {
  // With a bypass secret, send Vercel's protection bypass header so protected deployment URLs
  // answer for real instead of with a login page.
  const probe =
    bypassSecret === undefined
      ? []
      : [
          "probe() {",
          '  if [ -n "$BYPASS" ]; then curl --header "x-vercel-protection-bypass: $BYPASS" "$@"; else curl "$@"; fi',
          "}",
        ];
  const curl = bypassSecret === undefined ? "curl" : "probe";
  return {
    name: `Check ${url}`,
    env: {
      URL: url,
      ...(bypassSecret === undefined ? {} : { BYPASS: expr(`secrets.${bypassSecret}`) }),
    },
    run: lines([
      ...probe,
      "for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do",
      `  code="$(${curl} --silent --location --max-time 10 --output /dev/null --write-out '%{http_code}' "$URL" || true)"`,
      '  if [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; then',
      '    echo "$URL answered $code (attempt $attempt)."',
      "    exit 0",
      "  fi",
      "  sleep 10",
      "done",
      'echo "::error title=Health check::$URL did not answer without a server error within two minutes (last status: $code)."',
      "exit 1",
    ]),
  };
}

/** Shell function every VPS step uses to reach the server, with the pinned host key. */
const REMOTE = [
  "remote() {",
  '  ssh -i "$HOME/.ssh/deploy_key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \\',
  '    -o UserKnownHostsFile="$HOME/.ssh/known_hosts" -p "$SSH_PORT" "$SSH_USER@$HOST" "$@"',
  "}",
  "project=\"$(basename \"$GITHUB_REPOSITORY\" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')-$ENVIRONMENT\"",
];

/** Runs on the server: `docker compose` with the project's .env (if any) and The Hollow's. */
const REMOTE_COMPOSE = [
  "compose() {",
  "  if [ -f .env ]; then",
  '    docker compose --project-name "$project" --env-file .env --env-file .hollow.env "$@"',
  "  else",
  '    docker compose --project-name "$project" --env-file .hollow.env "$@"',
  "  fi",
  "}",
];

function vpsSteps(
  plan: PipelinePlan,
  deploy: DeployPlan,
  environment: DeployEnvironment,
  source: ReleaseSource,
): Step[] {
  const vps = deploy.vps;
  if (vps === null) return [];
  const name = environment.name;
  const migrate = plan.migrations === null ? [] : vpsMigrationLines(plan.migrations);
  const migrated = migrate.length > 0;
  const server = {
    HOST: vps.host,
    SSH_USER: vps.user,
    SSH_PORT: String(vps.sshPort),
    DIR: `${vps.path.replace(/\/+$/, "")}/${name}`,
    ENVIRONMENT: name,
  };
  const steps: Step[] = [
    source.manual ? checkout({ ref: source.tag }) : checkout(),
    {
      name: "Set up SSH",
      env: {
        SSH_KEY: expr(`secrets.${vps.sshKeySecret}`),
        KNOWN_HOSTS: expr(`vars.${vps.knownHostsVariable}`),
      },
      run: lines([
        'if [ -z "$SSH_KEY" ]; then',
        `  echo "::error title=Missing secret::Add the ${vps.sshKeySecret} secret to the ${name} environment (Settings > Environments > ${name})."`,
        "  exit 1",
        "fi",
        'if [ -z "$KNOWN_HOSTS" ]; then',
        `  echo "::error title=Missing variable::Add the ${vps.knownHostsVariable} variable to the ${name} environment, set to the output of: ssh-keyscan -p ${vps.sshPort} ${vps.host}"`,
        "  exit 1",
        "fi",
        'install -d -m 700 "$HOME/.ssh"',
        'printf \'%s\\n\' "$SSH_KEY" > "$HOME/.ssh/deploy_key"',
        'chmod 600 "$HOME/.ssh/deploy_key"',
        'printf \'%s\\n\' "$KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"',
      ]),
    },
    {
      name: `Deploy to ${vps.host}`,
      id: "deploy",
      env: {
        ...server,
        IMAGE_REF: `${source.image}@${source.digest}`,
        APP_PORT: expr(`vars.APP_PORT || '${environment.hostPort}'`),
        GH_TOKEN: expr("github.token"),
      },
      run: lines([
        'case "$APP_PORT" in',
        "  '' | *[!0-9]*)",
        "    echo \"::error title=APP_PORT::The APP_PORT variable must be a port number, not '$APP_PORT'.\"",
        "    exit 1",
        "    ;;",
        "esac",
        ...REMOTE,
        'remote mkdir -p -- "$DIR"',
        'scp -i "$HOME/.ssh/deploy_key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \\',
        '  -o UserKnownHostsFile="$HOME/.ssh/known_hosts" -P "$SSH_PORT" \\',
        `  ${DEPLOY_COMPOSE} "$SSH_USER@$HOST:$DIR/compose.yaml"`,
        'echo "$GH_TOKEN" | remote docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin',
        "trap 'remote docker logout ghcr.io > /dev/null || true' EXIT",
        'remote sh -s -- "$DIR" "$IMAGE_REF" "$project" "$APP_PORT" << \'REMOTE\'',
        "set -eu",
        'cd "$1"',
        'project="$3"',
        ...REMOTE_COMPOSE,
        "if [ -f .hollow.env ]; then cp .hollow.env .hollow.env.previous; fi",
        'printf \'IMAGE=%s\\nAPP_PORT=%s\\n\' "$2" "$4" > .hollow.env',
        "compose pull --quiet",
        ...migrate,
        "if compose up --detach --wait --wait-timeout 120; then",
        '  echo "The new version is up and healthy."',
        "  exit 0",
        "fi",
        'echo "The new version did not become healthy." >&2',
        "if [ -f .hollow.env.previous ]; then",
        "  cp .hollow.env.previous .hollow.env",
        "  compose up --detach --wait --wait-timeout 120 || true",
        `  echo "Rolled back to the previous version.${migrated ? ` ${SCHEMA_STAYS}` : ""}" >&2`,
        "fi",
        "exit 1",
        "REMOTE",
        'echo "Deployed $IMAGE_REF to $ENVIRONMENT on $HOST" >> "$GITHUB_STEP_SUMMARY"',
      ]),
    },
  ];
  if (environment.healthUrl !== null) {
    steps.push(healthCheck(environment.healthUrl), {
      name: "Roll back",
      if: expr("failure() && steps.deploy.outcome == 'success'"),
      env: server,
      run: lines([
        ...REMOTE,
        'remote sh -s -- "$DIR" "$project" << \'REMOTE\'',
        "set -eu",
        'cd "$1"',
        'project="$2"',
        ...REMOTE_COMPOSE,
        "if [ ! -f .hollow.env.previous ]; then",
        '  echo "There is no earlier version to roll back to." >&2',
        "  exit 0",
        "fi",
        "cp .hollow.env.previous .hollow.env",
        "compose up --detach --wait --wait-timeout 120",
        "REMOTE",
        `echo "::error title=Rolled back::$ENVIRONMENT on $HOST is back on the previous version.${migrated ? ` ${SCHEMA_STAYS}` : ""}"`,
      ]),
    });
  }
  return steps;
}
