import type {
  ArchiveArtifact,
  ImageArtifact,
  PipelinePlan,
  ReleasePlan,
} from "../pipeline/plan.js";
import { checkout, installBinary, lines, setupSteps } from "./ci.js";
import { ACTIONS, BINARIES } from "./pins.js";
import { expr, renderGenerated } from "./render.js";

export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

const RELEASE = "needs.release-please.outputs";

/**
 * `.github/workflows/release.yml`: on every push to the default branch, release-please keeps a
 * release pull request up to date. Merging it tags the version and creates the GitHub release,
 * and the artifact job then builds once, publishes, and attaches an SBOM and build provenance.
 * Deploys (M3) will promote exactly this artifact.
 */
export function renderReleaseWorkflow(plan: PipelinePlan, release: ReleasePlan): string {
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

function releasePleaseJob(release: ReleasePlan): Job {
  return {
    name: "Release PR and tag",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 10,
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
function releaseEnv(): Record<string, string> {
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
