import { lines } from "./ci.js";
import type { Job, Step } from "./release.js";
import { expr } from "./render.js";

// Kept local (not imported from release.ts, which imports this module) so nothing here depends
// on module load order.
const RELEASE = "needs.release-please.outputs";
const RELEASED = `${RELEASE}.released == 'true'`;
const WORKFLOW_FILE = "release.yml";

/**
 * Where a production job gets the release it deploys.
 *
 * - From this run: the release was just cut, and the artifact comes from earlier jobs.
 * - From the release: a person ran the workflow by hand with a version, and the artifact comes
 *   from that release's assets (image digest, deployment URL, Worker version, build archive).
 *   This is the approval gate for repos where GitHub has no deploy approvals.
 */
export interface ReleaseSource {
  manual: boolean;
  tag: string;
  version: string;
  image: string;
  digest: string;
  deployment: string;
  workerVersion: string;
}

export const FROM_RUN: ReleaseSource = {
  manual: false,
  tag: expr(`${RELEASE}.tag`),
  version: expr(`${RELEASE}.version`),
  image: expr("needs.build.outputs.image"),
  digest: expr("needs.build.outputs.digest"),
  deployment: expr("needs.deploy-staging.outputs.url"),
  workerVersion: expr("needs.deploy-staging.outputs.version"),
};

export const FROM_RELEASE: ReleaseSource = {
  manual: true,
  tag: expr("steps.release.outputs.tag"),
  version: expr("steps.release.outputs.version"),
  image: expr("steps.release.outputs.image"),
  digest: expr("steps.release.outputs.digest"),
  deployment: expr("steps.release.outputs.deployment"),
  workerVersion: expr("steps.release.outputs.worker_version"),
};

/** TAG and VERSION for scripts, from wherever the release comes from. */
export function sourceEnv(source: ReleaseSource): Record<string, string> {
  return { TAG: source.tag, VERSION: source.version };
}

/** The manual trigger: a version to deploy to production. */
export const DISPATCH = {
  workflow_dispatch: {
    inputs: {
      version: {
        description:
          "Release to deploy to production, for example v1.4.0. Running this is the approval.",
        required: true,
        type: "string",
      },
    },
  },
};

/** What a manual run needs from the release's assets. */
export type ReleaseAsset = "image" | "deployment" | "worker" | "archive";

const CHECKS: Record<ReleaseAsset, string[]> = {
  image: [
    'ref="$(cat "$assets/image-digest.txt" 2> /dev/null || true)"',
    "if ! echo \"$ref\" | grep -Eqx 'ghcr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}'; then",
    '  echo "::error title=Release assets::$tag has no valid image-digest.txt, so there is nothing to deploy."',
    "  exit 1",
    "fi",
    'echo "image=$(echo "$ref" | cut -d@ -f1)" >> "$GITHUB_OUTPUT"',
    'echo "digest=$(echo "$ref" | cut -d@ -f2)" >> "$GITHUB_OUTPUT"',
  ],
  deployment: [
    'url="$(cat "$assets/deployment-url.txt" 2> /dev/null || true)"',
    "if ! echo \"$url\" | grep -Eqx 'https://[A-Za-z0-9.-]+'; then",
    '  echo "::error title=Release assets::$tag has no valid deployment-url.txt, so there is nothing to deploy."',
    "  exit 1",
    "fi",
    'echo "deployment=$url" >> "$GITHUB_OUTPUT"',
  ],
  worker: [
    'id="$(cat "$assets/worker-version.txt" 2> /dev/null || true)"',
    "if ! echo \"$id\" | grep -Eqx '[A-Za-z0-9-]+'; then",
    '  echo "::error title=Release assets::$tag has no valid worker-version.txt, so there is nothing to deploy."',
    "  exit 1",
    "fi",
    'echo "worker_version=$id" >> "$GITHUB_OUTPUT"',
  ],
  archive: [
    'if ! ls "$assets"/*.tar.gz > /dev/null 2>&1; then',
    '  echo "::error title=Release assets::$tag has no build archive, so there is nothing to deploy."',
    "  exit 1",
    "fi",
  ],
};

/**
 * Find the release a person asked for, download its assets to $RUNNER_TEMP/assets, and expose
 * what the deploy needs as outputs. Every value is checked against its expected shape first.
 */
export function resolveRelease(asset: ReleaseAsset): Step {
  return {
    name: "Find the release to deploy",
    id: "release",
    env: { INPUT: expr("inputs.version"), GH_TOKEN: expr("github.token") },
    run: lines([
      'case "$INPUT" in',
      "  '' | *[!A-Za-z0-9._-]*)",
      '    echo "::error title=Version::Enter a release version such as v1.4.0."',
      "    exit 1",
      "    ;;",
      "esac",
      'tag="$INPUT"',
      'if ! gh release view "$tag" --repo "$GITHUB_REPOSITORY" > /dev/null 2>&1; then tag="v$INPUT"; fi',
      'if ! gh release view "$tag" --repo "$GITHUB_REPOSITORY" > /dev/null 2>&1; then',
      '  echo "::error title=Version::There is no release $INPUT."',
      "  exit 1",
      "fi",
      'assets="$RUNNER_TEMP/assets"',
      'mkdir -p "$assets"',
      'gh release download "$tag" --repo "$GITHUB_REPOSITORY" --dir "$assets"',
      'echo "tag=$tag" >> "$GITHUB_OUTPUT"',
      'echo "version=$(echo "$tag" | sed \'s/^v//\')" >> "$GITHUB_OUTPUT"',
      ...CHECKS[asset],
      'echo "Deploying release $tag to production, approved by $GITHUB_ACTOR running this workflow." >> "$GITHUB_STEP_SUMMARY"',
    ]),
  };
}

/**
 * Before an automatic production deploy, check that the production environment really has
 * required reviewers. Without them (a private repo without GitHub Enterprise, or `hollow protect`
 * never run) nothing would stop the deploy, so the release waits for someone to run the workflow
 * by hand instead.
 */
export function gateJob(): Job {
  return {
    name: "Check the production approval",
    needs: ["release-please"],
    if: expr(RELEASED),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 5,
    permissions: { actions: "read" },
    outputs: { reviewed: expr("steps.check.outputs.reviewed") },
    steps: [
      {
        name: "Look for required reviewers on production",
        id: "check",
        env: { GH_TOKEN: expr("github.token"), TAG: expr(`${RELEASE}.tag`) },
        run: lines([
          'reviewers="$(gh api "repos/$GITHUB_REPOSITORY/environments/production" --jq \'[.protection_rules[]? | select(.type == "required_reviewers")] | length\' 2> /dev/null || echo 0)"',
          'if [ "$reviewers" -gt 0 ]; then',
          '  echo "reviewed=true" >> "$GITHUB_OUTPUT"',
          '  echo "Production waits for its required reviewers." >> "$GITHUB_STEP_SUMMARY"',
          "  exit 0",
          "fi",
          'echo "reviewed=false" >> "$GITHUB_OUTPUT"',
          "{",
          '  echo "### Production needs a manual approval"',
          '  echo "The production environment has no required reviewers (GitHub offers them on private repos only with Enterprise), so $TAG was not deployed automatically."',
          '  echo "To approve it, someone with write access runs the Release workflow with version $TAG, from the Actions tab or with:"',
          "  echo '```'",
          `  echo "gh workflow run ${WORKFLOW_FILE} -f version=$TAG"`,
          "  echo '```'",
          '} >> "$GITHUB_STEP_SUMMARY"',
          'echo "::warning title=Production not deployed::Run the Release workflow with version $TAG to deploy it to production."',
        ]),
      },
    ],
  };
}

/** Jobs that only belong to pushes get skipped when a person runs the workflow by hand. */
export function pushOnly(job: Job): Job {
  return job.if === undefined ? { ...job, if: expr("github.event_name == 'push'") } : job;
}

/**
 * Add the gate to a release pipeline: the automatic production job runs only when production
 * has required reviewers, and a manual run deploys a chosen release from its assets.
 */
export function addProductionGate(
  jobs: Record<string, Job>,
  production: (source: ReleaseSource) => Job,
  asset: ReleaseAsset,
): Record<string, Job> {
  const gated: Record<string, Job> = {};
  for (const [id, job] of Object.entries(jobs)) gated[id] = pushOnly(job);
  gated["production-gate"] = gateJob();

  const automatic = production(FROM_RUN);
  gated["deploy-production"] = {
    ...automatic,
    needs: [...((automatic.needs as string[] | undefined) ?? []), "production-gate"],
    if: expr(`${RELEASED} && needs.production-gate.outputs.reviewed == 'true'`),
  };

  const manual = production(FROM_RELEASE);
  const { needs: _needs, ...rest } = manual;
  gated["deploy-production-manual"] = {
    ...rest,
    name: "Deploy a release to production (manual approval)",
    if: expr("github.event_name == 'workflow_dispatch'"),
    permissions: {
      ...((manual.permissions as Record<string, string> | undefined) ?? {}),
      contents: "read",
    },
    steps: [resolveRelease(asset), ...(manual.steps as Step[])],
  };
  return gated;
}
