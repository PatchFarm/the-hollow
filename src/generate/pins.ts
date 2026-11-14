/**
 * Every third-party action, binary and image the generated pipeline uses, pinned in one place.
 *
 * Rules (from CONTRIBUTING.md and the PatchFarm standards):
 * - actions are pinned to a full commit SHA, with the release tag in a trailing comment
 * - binaries are downloaded over https and checked against the publisher's SHA-256 checksum
 * - images are pinned by digest
 * - a release must be at least two weeks old before it is pinned here
 *
 * Updating a pin is its own pull request. `hollow upgrade` carries new pins into projects.
 */

export interface ActionPin {
  /** `owner/repo@<40-char sha>`, ready for a `uses:` line. */
  uses: string;
  /** Release tag the SHA belongs to, written as a trailing comment. */
  version: string;
}

export interface BinaryPin {
  version: string;
  url: string;
  sha256: string;
}

export interface ImagePin {
  /** `name@sha256:<digest>`. */
  image: string;
  version: string;
}

const action = (repo: string, sha: string, version: string): ActionPin => ({
  uses: `${repo}@${sha}`,
  version,
});

export const ACTIONS = {
  checkout: action("actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"),
  setupNode: action("actions/setup-node", "949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"),
  setupPython: action("actions/setup-python", "6d4fd22b20465ccc0f7354476588e8df7c9ca0e0", "v7.1.0"),
  setupUv: action("astral-sh/setup-uv", "68559e99cc807c1eb7e9238fd43a15bba460eec2", "v10.3.3"),
  setupPnpm: action("pnpm/action-setup", "ea17c68df8912ef543352723c149a84f56e3d413", "v6.1.0"),
  setupBun: action("oven-sh/setup-bun", "0c5077e51419868618aeaa5fe8019c62421857d6", "v2.2.0"),
  codeqlInit: action(
    "github/codeql-action/init",
    "9b3254085494b55a0f7c4c2b3d2d52cc712ce370",
    "v4.39.1",
  ),
  codeqlAnalyze: action(
    "github/codeql-action/analyze",
    "9b3254085494b55a0f7c4c2b3d2d52cc712ce370",
    "v4.39.1",
  ),
} as const satisfies Record<string, ActionPin>;

export const BINARIES = {
  gitleaks: {
    version: "8.30.1",
    url: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz",
    sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  },
  osvScanner: {
    version: "2.7.0",
    url: "https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_linux_amd64",
    sha256: "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b",
  },
  trivy: {
    version: "0.76.1",
    url: "https://github.com/aquasecurity/trivy/releases/download/v0.76.1/trivy_0.76.1_Linux-64bit.tar.gz",
    sha256: "c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0",
  },
} as const satisfies Record<string, BinaryPin>;

export const IMAGES = {
  semgrep: {
    image:
      "semgrep/semgrep@sha256:2e45517a85e13a9cca14a2a00df6bb48affd66b8ebfae1b0991cd57578362fb0",
    version: "1.183.0",
  },
  postgres: {
    image: "postgres@sha256:b9f6b8ff03b62f3cfd9d9ba3fe56226a9991c79d3fb46fd46536263bf02be553",
    version: "18",
  },
  mysql: {
    image: "mysql@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902",
    version: "8.4",
  },
  redis: {
    image: "redis@sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53",
    version: "8",
  },
} as const satisfies Record<string, ImagePin>;

/** Package-manager versions installed when the project does not pin one itself. */
export const TOOL_VERSIONS = {
  poetry: "2.5.1",
  pnpmMajor: "12",
} as const;

/** Value to trailing-comment map, so rendered YAML shows the version next to each pin. */
export function pinComments(): Map<string, string> {
  const comments = new Map<string, string>();
  for (const pin of Object.values(ACTIONS)) comments.set(pin.uses, pin.version);
  for (const pin of Object.values(IMAGES)) comments.set(pin.image, pin.version);
  return comments;
}
