import type { PipelinePlan, Service } from "../pipeline/plan.js";
import { ACTIONS, BINARIES, type BinaryPin, IMAGES, TOOL_VERSIONS } from "./pins.js";
import { renderGenerated } from "./render.js";

export const CI_WORKFLOW = ".github/workflows/ci.yml";

type Step = Record<string, unknown>;
type Job = Record<string, unknown>;

const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;
/** CVSS base score where each severity starts. */
const CVSS_FLOOR = { low: "0.1", medium: "4.0", high: "7.0", critical: "9.0" } as const;

/**
 * `.github/workflows/ci.yml`: build, quality, tests and security scanning on every pull request
 * and every push to the default branch. One stable `CI passed` check sums it up for branch
 * protection.
 */
export function renderCiWorkflow(plan: PipelinePlan): string {
  const jobs: Record<string, Job> = { build: buildJob(plan) };
  const comments: Record<string, string> = {
    permissions: "Nothing by default; each job asks for what it needs.",
    "jobs.ci-passed":
      "One stable check name to require in branch protection, whatever jobs run above.",
  };

  jobs.secrets = secretsJob();
  jobs.dependencies = dependenciesJob(plan);
  const { sast, codeqlLanguages } = plan.security;
  if (sast === "auto" || sast === "codeql") {
    jobs.codeql = codeqlJob(codeqlLanguages, sast === "auto");
    if (sast === "auto") comments["jobs.codeql"] = "CodeQL is free on public repositories.";
  }
  if (sast === "auto" || sast === "semgrep") {
    jobs.semgrep = semgrepJob(plan, sast === "auto");
    if (sast === "auto") {
      comments["jobs.semgrep"] =
        "Private repositories need GitHub Advanced Security for CodeQL, so they get Semgrep instead.";
    }
  }
  if (plan.dockerfile !== null) jobs.container = containerJob(plan, plan.dockerfile);
  jobs["ci-passed"] = summaryJob(Object.keys(jobs));

  const workflow = {
    name: "CI",
    on: {
      pull_request: null,
      push: { branches: [plan.defaultBranch] },
    },
    permissions: {},
    concurrency: {
      group: `ci-${expr("github.workflow")}-${expr("github.event.pull_request.number || github.ref")}`,
      "cancel-in-progress": expr("github.event_name == 'pull_request'"),
    },
    jobs,
  };
  return renderGenerated(workflow, {
    about: [
      "Runs on every pull request and every push to the default branch.",
      "Every action is pinned to a commit SHA and every downloaded tool is checked against its checksum.",
    ],
    comments,
  });
}

function checkout(options: { fetchDepth?: number } = {}): Step {
  const withInputs: Record<string, unknown> = { "persist-credentials": false };
  if (options.fetchDepth !== undefined) withInputs["fetch-depth"] = options.fetchDepth;
  return { uses: ACTIONS.checkout.uses, with: withInputs };
}

function buildJob(plan: PipelinePlan): Job {
  const steps: Step[] = [checkout(), ...setupSteps(plan)];
  steps.push({ name: "Install dependencies", run: lines(plan.install) });
  for (const check of plan.checks) steps.push({ name: check.name, run: check.run });

  const job: Job = {
    name: "Build and test",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 30,
    permissions: { contents: "read" },
  };
  if (plan.services.length > 0) {
    job.services = Object.fromEntries(plan.services.map((s) => [s.engine, serviceContainer(s)]));
    job.env = Object.assign({}, ...plan.services.map((s) => s.env));
  }
  job.steps = steps;
  return job;
}

function setupSteps(plan: PipelinePlan): Step[] {
  const tc = plan.toolchain;
  const steps: Step[] = [];
  if (tc.kind === "node") {
    if (tc.packageManager === "bun") {
      if (tc.bunVersion === null) throw new Error("bun toolchain without a version");
      return [
        { uses: ACTIONS.setupBun.uses, with: { [tc.bunVersion.input]: tc.bunVersion.value } },
      ];
    }
    if (tc.packageManager === "pnpm") {
      steps.push(
        tc.pnpmVersion === null
          ? { uses: ACTIONS.setupPnpm.uses }
          : { uses: ACTIONS.setupPnpm.uses, with: { version: tc.pnpmVersion } },
      );
    }
    if (tc.corepack) steps.push({ name: "Enable Corepack (Yarn 2+)", run: "corepack enable" });
    const withInputs: Record<string, unknown> = { [tc.version.input]: tc.version.value };
    if (tc.cache !== null) withInputs.cache = tc.cache;
    else withInputs["package-manager-cache"] = false;
    steps.push({ uses: ACTIONS.setupNode.uses, with: withInputs });
    return steps;
  }

  if (tc.packageManager === "uv") {
    const withInputs: Record<string, unknown> = { "enable-cache": true };
    if (tc.version !== null) withInputs["python-version"] = tc.version.value;
    return [{ uses: ACTIONS.setupUv.uses, with: withInputs }];
  }
  if (tc.packageManager === "poetry") {
    steps.push({ name: "Install Poetry", run: `pipx install poetry==${TOOL_VERSIONS.poetry}` });
  }
  const withInputs: Record<string, unknown> = {};
  if (tc.version !== null) withInputs[tc.version.input] = tc.version.value;
  if (tc.cache !== null) withInputs.cache = tc.cache;
  if (tc.cacheDependencyPath.length > 0) {
    withInputs["cache-dependency-path"] = lines(tc.cacheDependencyPath);
  }
  steps.push({ uses: ACTIONS.setupPython.uses, with: withInputs });
  return steps;
}

function serviceContainer(service: Service): Record<string, unknown> {
  switch (service.engine) {
    case "postgres":
      return {
        image: IMAGES.postgres.image,
        env: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "app" },
        ports: ["5432:5432"],
        options: health("pg_isready -U postgres"),
      };
    case "mysql":
      return {
        image: IMAGES.mysql.image,
        env: { MYSQL_ROOT_PASSWORD: "root", MYSQL_DATABASE: "app" },
        ports: ["3306:3306"],
        options: health("mysqladmin ping -h 127.0.0.1 -proot"),
      };
    case "redis":
      return {
        image: IMAGES.redis.image,
        ports: ["6379:6379"],
        options: health("redis-cli ping"),
      };
    case "sqlite":
      throw new Error("sqlite needs no service container");
  }
}

function health(command: string): string {
  return `--health-cmd "${command}" --health-interval 5s --health-timeout 5s --health-retries 20`;
}

/** Steps that download a pinned binary and refuse to continue if its checksum does not match. */
function installBinary(name: string, label: string, pin: BinaryPin, archive: boolean): Step {
  const file = archive ? `$RUNNER_TEMP/${name}.tar.gz` : `$RUNNER_TEMP/${name}`;
  const script = [
    `curl --fail --silent --show-error --location --retry 3 --output "${file}" "$URL"`,
    `echo "$SHA256  ${file}" | sha256sum --check --strict`,
    archive
      ? `tar --extract --gzip --file "${file}" --directory "$RUNNER_TEMP" ${name}`
      : `chmod +x "${file}"`,
  ];
  return {
    name: `Install ${label} ${pin.version}`,
    env: { URL: pin.url, SHA256: pin.sha256 },
    run: lines(script),
  };
}

function secretsJob(): Job {
  return {
    name: "Secret scan (Gitleaks)",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 15,
    permissions: { contents: "read" },
    steps: [
      checkout({ fetchDepth: 0 }),
      installBinary("gitleaks", "Gitleaks", BINARIES.gitleaks, true),
      {
        name: "Scan the git history for secrets",
        run: '"$RUNNER_TEMP/gitleaks" git --redact --verbose --exit-code 1 .',
      },
    ],
  };
}

function dependenciesJob(plan: PipelinePlan): Job {
  const failOn = plan.security.failOn;
  // Unscored advisories only block when every finding should block.
  const unknownBlocks = failOn === "low" ? "1" : "0";
  const script = [
    "set +e",
    '"$RUNNER_TEMP/osv-scanner" scan source --recursive --format json --output "$RUNNER_TEMP/osv.json" .',
    "code=$?",
    "set -e",
    'if [ "$code" -eq 128 ]; then',
    '  echo "::warning title=OSV-Scanner::No lockfiles or manifests found to scan."',
    "  exit 0",
    "fi",
    'if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then',
    '  echo "::error title=OSV-Scanner::The scan itself failed (exit code $code)."',
    '  exit "$code"',
    "fi",
    'jq --raw-output \'.results[]?.packages[]? as $p | $p.groups[]? | [$p.package.ecosystem, ($p.package.name + "@" + $p.package.version), (.ids | join(",")), (if (.max_severity // "") == "" then "unknown" else .max_severity end)] | @tsv\' "$RUNNER_TEMP/osv.json" > "$RUNNER_TEMP/findings.tsv"',
    'if [ ! -s "$RUNNER_TEMP/findings.tsv" ]; then',
    '  echo "No known vulnerabilities in dependencies."',
    "  exit 0",
    "fi",
    `awk -F '\\t' -v min="$MIN_CVSS" -v unknown_blocks="$UNKNOWN_BLOCKS" '`,
    "  {",
    '    blocking = ($4 == "unknown") ? (unknown_blocks == 1) : ($4 + 0 >= min + 0)',
    '    level = blocking ? "error" : "warning"',
    '    printf "::%s title=Vulnerable dependency::%s %s (%s), CVSS %s\\n", level, $1, $2, $3, $4',
    "    if (blocking) failed = 1",
    "  }",
    "  END { exit failed }",
    `' "$RUNNER_TEMP/findings.tsv"`,
  ];
  return {
    name: "Dependency scan (OSV-Scanner)",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 15,
    permissions: { contents: "read" },
    steps: [
      checkout(),
      installBinary("osv-scanner", "OSV-Scanner", BINARIES.osvScanner, false),
      {
        name: `Fail on ${failOn} or worse`,
        env: { MIN_CVSS: CVSS_FLOOR[failOn], UNKNOWN_BLOCKS: unknownBlocks },
        run: lines(script),
      },
    ],
  };
}

function codeqlJob(languages: string[], publicOnly: boolean): Job {
  const job: Job = { name: "SAST (CodeQL)" };
  if (publicOnly) job.if = expr("!github.event.repository.private");
  Object.assign(job, {
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 30,
    permissions: { contents: "read", actions: "read", "security-events": "write" },
    steps: [
      checkout(),
      {
        uses: ACTIONS.codeqlInit.uses,
        with: { languages: languages.join(", "), "build-mode": "none" },
      },
      { uses: ACTIONS.codeqlAnalyze.uses },
    ],
  });
  return job;
}

function semgrepJob(plan: PipelinePlan, privateOnly: boolean): Job {
  const job: Job = { name: "SAST (Semgrep)" };
  if (privateOnly) job.if = expr("github.event.repository.private");
  const severities = semgrepSeverities(plan.security.failOn);
  Object.assign(job, {
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 30,
    permissions: { contents: "read" },
    container: { image: IMAGES.semgrep.image },
    steps: [
      checkout(),
      {
        name: `Fail on ${plan.security.failOn} or worse`,
        run: [
          "semgrep scan --config p/default --metrics off --error",
          ...severities.map((s) => `--severity ${s}`),
        ].join(" "),
      },
    ],
  });
  return job;
}

function semgrepSeverities(failOn: PipelinePlan["security"]["failOn"]): string[] {
  if (failOn === "critical" || failOn === "high") return ["ERROR"];
  if (failOn === "medium") return ["ERROR", "WARNING"];
  return [];
}

function containerJob(plan: PipelinePlan, dockerfile: string): Job {
  const from = SEVERITY_ORDER.indexOf(plan.security.failOn);
  const severities = SEVERITY_ORDER.slice(from)
    .map((s) => s.toUpperCase())
    .join(",");
  return {
    name: "Container scan (Trivy)",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 20,
    permissions: { contents: "read" },
    steps: [
      checkout(),
      {
        name: "Build the image",
        env: { DOCKERFILE: dockerfile },
        run: 'docker build --file "$DOCKERFILE" --tag hollow-ci:scan .',
      },
      installBinary("trivy", "Trivy", BINARIES.trivy, true),
      {
        name: `Fail on ${plan.security.failOn} or worse (fixable findings)`,
        env: { SEVERITY: severities },
        run: '"$RUNNER_TEMP/trivy" image --severity "$SEVERITY" --ignore-unfixed --exit-code 1 --no-progress hollow-ci:scan',
      },
    ],
  };
}

function summaryJob(needs: string[]): Job {
  return {
    name: "CI passed",
    if: expr("always()"),
    needs,
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 2,
    permissions: {},
    steps: [
      {
        name: "Fail unless every job succeeded or was skipped on purpose",
        env: { RESULTS: expr("join(needs.*.result, ' ')") },
        run: lines([
          'echo "Job results: $RESULTS"',
          "bad=$(echo \"$RESULTS\" | tr ' ' '\\n' | grep --invert-match --extended-regexp '^(success|skipped)$' || true)",
          'if [ -n "$bad" ]; then',
          '  echo "::error::A required job did not succeed: $bad"',
          "  exit 1",
          "fi",
        ]),
      },
    ],
  };
}

/** A GitHub Actions expression, `${{ ... }}`. */
function expr(expression: string): string {
  return `\${{ ${expression} }}`;
}

/** Join shell lines into one `run:` block. A single line stays inline. */
function lines(parts: readonly string[]): string {
  return parts.length === 1 ? (parts[0] ?? "") : `${parts.join("\n")}\n`;
}
