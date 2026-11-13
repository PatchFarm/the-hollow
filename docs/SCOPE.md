# The Hollow: Scope

> Status: draft for approval, 2026-11-13. Nothing here is built yet.
>
> Naming: the project is **The Hollow** (npm package `the-hollow`, GitHub repo `PatchFarm/the-hollow`). The command it installs is `hollow`, and the rest of this document calls the tool hollow.

## 1. Objective

Give any developer a **controlled, repeatable, secure and traceable** deployment pipeline in one command, so that every code change is validated before it reaches a live environment.

hollow does this by reading a repository, working out what it needs, and generating a complete CI/CD setup on GitHub Actions. An AI agent then runs that pipeline and fixes it until it passes. The result is opened as a pull request the developer reviews and merges, so hollow never changes a project behind anyone's back.

## 2. What hollow is (and is not)

**hollow is a pipeline author and installer.** It writes, configures, verifies and repairs the pipeline. After setup, the pipeline runs entirely on GitHub Actions and the developer's own deploy targets. hollow does not need to keep running.

**hollow is not** a CI service, a hosting platform, or an observability product. Where the brief calls for things like logging, metrics or incident tooling, hollow **wires the pipeline into** those systems (health checks, alerts, deploy markers, rollback). It does not build them.

**Class:** AI agent, shipped as a command line tool. Fixed, coded logic handles detection and the common cases with no AI calls. The model (Claude, bring your own API key) is used only to fill gaps and to repair failing runs. `--no-ai` runs the fixed logic alone.

## 3. Decisions already made

| Decision | Choice |
|---|---|
| CI platform | GitHub Actions only (others later) |
| Scope | Full CI and CD |
| Deploy targets | Vercel, Cloudflare (Workers and Pages), Docker images, VPS over SSH |
| Project types at launch | Node/TypeScript and Python |
| How people run it | `npx`, written in TypeScript on Node |
| Environments | `staging` and `production` by default, `preprod` opt-in |
| Delivery | Always a pull request, never a direct push to `main` |
| License | Apache-2.0 |
| Standards | PatchFarm engineering standards, contribution guide and security policy (in `PatchFarm/.github`), plus this repo's `SECURITY.md` threat model and `CONTRIBUTING.md` rules |

**Package name:** `the-hollow` on npm (free as of 2026-11-13; plain `hollow` is taken by an abandoned package). It installs a `hollow` command, so people run `npx the-hollow init`, or `hollow init` after `npm i -g the-hollow`. No npm organization is needed.

## 4. Pipeline principles

These apply to everything hollow generates. They are what make the pipeline controlled, secure and traceable.

1. **Build once, promote the same artifact.** One immutable build (image digest or bundle hash) moves through staging, pre-production and production. Nothing is rebuilt per environment.
2. **Every change goes through a pull request.** Protected `main`, required reviews, required status checks.
3. **Gates are explicit.** Each environment has entry conditions. Production needs a human approval.
4. **Everything is traceable.** Commit SHA, artifact version, image digest, approver, and deploy time are linked through GitHub Deployments and release notes.
5. **Least privilege by default.** Workflows declare minimal `permissions`, third-party actions are pinned to full commit SHAs, secrets are scoped to environments, and OIDC is used where a target supports it.
6. **Fail safe.** A failed post-deploy check triggers automatic rollback to the last good release.
7. **Regenerable.** `hollow.yml` in the repo is the source of truth. Generated workflows can be re-created from it and are marked as generated.

## 5. Lifecycle coverage

How each stage of your brief maps to what hollow sets up.

| # | Stage | What hollow sets up | Release |
|---|---|---|---|
| 1 | Development and code authoring | Pre-commit hooks (format, lint, secret check), `.editorconfig`, a `hollow check` command that runs the CI checks locally | v1 |
| 2 | Source code management | Branch protection on `main`, required reviews and status checks, PR template, CODEOWNERS stub, Conventional Commits check | v1 |
| 3 | Continuous integration | `ci.yml` on every PR and push, with concurrency control and caching | v1 |
| 4 | Build and dependency resolution | Locked installs (`npm ci`, `pnpm --frozen-lockfile`, `uv sync --locked`), dependency caching, compile and package step | v1 |
| 5 | Automated quality assurance | Lint, format check, type and static checks, unit, integration, API and E2E tests, coverage report | v1 |
| 6 | Artifact management | Semantic versioning and tags, changelog, container images on GHCR (or Docker Hub), SBOM, build provenance attestation | v1 |
| 7 | Staging deployment (UAT) | Automatic deploy of every merge to `main` into a `staging` environment, plus per-PR preview deploys where the target supports them | v1 |
| 8 | Pre-production validation | Optional `preprod` environment that mirrors production, with E2E and regression tests against it | v1 (opt-in) |
| 9 | Release approval | GitHub Environment protection on `production`: required reviewers and optional wait timer | v1 |
| 10 | Production deployment | Promote the approved artifact to production on the chosen target | v1 |
| 11 | Post-deployment verification | Health checks and smoke tests against the live URL, automatic rollback on failure | v1 |
| 12 | Monitoring, feedback and continuous improvement | Scheduled synthetic checks, failure alerts, an auto-opened incident issue with logs and rollback details, nightly security re-scans | v1 basic, more in v2 |

## 6. Capability coverage

### Source and version control (v1)
- Branch protection, required reviews and checks applied through the GitHub API (with the developer's consent)
- PR template, CODEOWNERS stub, Conventional Commits title check

### Build (v1)
- Package manager detection: npm, pnpm, yarn, bun; pip, uv, poetry
- Runtime version from `.nvmrc`, `engines`, `.python-version` or `pyproject.toml`
- Compile and package: framework builds (Next.js, Vite), `tsc`, Python wheels, Dockerfile builds

### Code quality (v1)
- Node: ESLint or Biome, Prettier, `tsc --noEmit`
- Python: Ruff (lint and format), mypy or pyright when configured
- hollow uses the project's existing tools first and only proposes new ones when none exist

### Testing (v1)
- Unit: Vitest, Jest, pytest
- Integration: real service containers in CI (Postgres, MySQL, Redis) when the project uses them
- API: runs the project's API tests against a started server
- E2E and regression: Playwright or Cypress, run against staging and preprod
- If a project has no tests, hollow says so in the PR and adds a passing placeholder with a clear TODO. It never invents fake coverage.

### Security (v1)
| Area | Default tool | Notes |
|---|---|---|
| SAST | CodeQL | Free on public repos. Private repos need GitHub Advanced Security, so hollow falls back to Semgrep Community Edition |
| SCA | OSV-Scanner, plus Dependabot config | Covers npm and PyPI |
| Secret scanning | Gitleaks (binary) | Runs in CI and as a pre-commit hook |
| Container scanning | Trivy | On every image build and nightly |

Severity thresholds (block on critical and high, report the rest) are set in `hollow.yml`.

### Artifact management (v1)
- Versioning from Conventional Commits (release-please style), git tags, generated changelog
- Images pushed to GHCR by default, tagged with version and commit SHA, deployed by digest
- SBOM (Syft) and build provenance attestation attached to each release

### Infrastructure (v1 config, v2 provisioning)
- **v1:** target configuration as code: `vercel.json`, `wrangler.toml`, `Dockerfile`, `compose.yaml`, and a VPS bootstrap script (Docker, a deploy user, firewall, reverse proxy)
- **v1:** configuration injection per environment from GitHub Environment secrets and variables into each target (Vercel env, Wrangler secrets, `.env` on the VPS)
- **v2:** provisioning with OpenTofu/Terraform (DNS, managed databases, servers)

### Deployment (v1)
| Target | Staging / preview | Production | Rollback |
|---|---|---|---|
| Vercel | Preview deploy per PR, staging deploy on merge | Promote the prebuilt deployment | Promote the previous deployment |
| Cloudflare Workers | `wrangler deploy --env staging` | `wrangler deploy --env production` | Roll back to the previous version |
| Cloudflare Pages | Preview branch deploys | Production branch deploy | Redeploy the previous build |
| Docker | Build, scan and publish the image once | Same image digest promoted | Previous digest |
| VPS over SSH | Pull image, `docker compose up` with health check | Same, behind approval | Restart on previous image tag |

VPS deploys use an SSH key stored as an environment secret and a pinned `known_hosts` entry. Container orchestration in v1 means Docker Compose. Kubernetes is out of scope for v1.

### Database (v1)
- Detects the migration tool: Prisma, Drizzle, Alembic, Django migrations
- CI applies all migrations to a throwaway database to prove they run cleanly
- Destructive change check: flags dropped tables or columns, renames, and non-null columns without defaults, and requires an explicit override label on the PR
- Deploy order: migrate before the new code goes live, with a backup or snapshot step for the VPS target
- Backward compatibility guidance (expand, migrate, contract) in the generated docs

### Verification (v1)
- Health check endpoint test and smoke tests after every deploy
- Scheduled synthetic checks on key URLs (GitHub Actions schedule, minimum every 5 minutes and not exact to the minute)
- Rollback on a failed check

### Operations (v1 basic, v2 more)
- **v1:** failure notifications (Slack or Discord webhook, email via GitHub), an incident issue opened on failed production deploys, deploy markers through GitHub Deployments
- **v2:** OpenTelemetry starter setup, integrations with Sentry, Better Stack and Grafana, DORA metrics report (deploy frequency, lead time, change failure rate, time to restore)
- Building logging, metrics, tracing or paging systems is out of scope. hollow connects to them.

## 7. Generated output

A typical run adds the following files in one pull request:

```
hollow.yml                       # source of truth for the pipeline
.github/workflows/ci.yml         # PR and push: build, quality, tests, security
.github/workflows/release.yml    # main: version, artifact, staging, preprod, approval, production, verify
.github/workflows/scheduled.yml  # nightly security scans and synthetic checks
.github/dependabot.yml
.github/pull_request_template.md
.github/CODEOWNERS
Dockerfile, compose.yaml         # when the target needs them
vercel.json / wrangler.toml      # when the target needs them
docs/PIPELINE.md                 # what each stage does, which secrets to add, how to roll back
```

## 8. How hollow works

```
hollow init
  1. Detect     read the repo: language, package manager, framework, tests, DB, Docker
  2. Interview  ask only what it cannot detect (deploy target, environments, approvers)
  3. Plan       build a typed pipeline model and show it (hollow plan = dry run)
  4. Generate   render workflows and config from tested templates
  5. Verify     static checks (actionlint, YAML schema, pinned actions, permissions)
  6. Secrets    list required secrets per environment, optionally set them via gh
  7. Run        push a branch, trigger the pipeline, watch the run
  8. Repair     on failure, read the logs and patch the pipeline (AI), retry up to N times
  9. Propose    open a PR with the changes and a summary of what it found
```

**Commands (v1):** `init`, `plan`, `check` (run CI checks locally), `doctor` (audit an existing pipeline against these principles), `fix` (repair the latest failed run), `secrets`, `upgrade` (regenerate from `hollow.yml`).

**Agent guardrails:**
- Edits only pipeline and deploy files (`.github/`, `hollow.yml`, target config). Changes to application code are suggested in the PR, never applied.
- Never reads, prints or sends secret values to the model. Logs are redacted before they reach the model.
- Retry cap and spend cap per run, shown before it starts.
- Every change lands through a PR the developer merges.

## 9. Out of scope for v1

- CI platforms other than GitHub Actions (GitLab CI, CircleCI, Jenkins, Bitbucket)
- Kubernetes, Helm, and the big clouds (AWS, GCP, Azure) as deploy targets
- Cloud provisioning with Terraform/OpenTofu (v2)
- Languages beyond Node/TypeScript and Python (Go, Ruby, Java, .NET, PHP later)
- Monorepos with several deployable apps (single app per repo in v1)
- Mobile app pipelines
- A hosted service or dashboard

## 10. Known platform limits to document

- **GitHub plans:** required reviewers and wait timers on environments are free for public repos. Private repos need a paid GitHub plan, so on free private repos hollow uses a manual-dispatch approval workflow instead.
- **CodeQL on private repos** needs GitHub Advanced Security (Semgrep fallback above).
- **Scheduled workflows** run at most every 5 minutes and can be delayed, so synthetic checks are a baseline, not real uptime monitoring.

## 11. Milestones

| Milestone | Delivers |
|---|---|
| M0 Foundation | Repo, CLI skeleton, detector, `hollow.yml` schema, test fixtures (sample Node and Python apps) |
| M1 CI | Build, quality, tests, security scanning for Node and Python, verified with actionlint. Works with `--no-ai` |
| M2 Release | Versioning, artifacts, SBOM, provenance, environments, approval gate, branch protection |
| M3 Deploy | Vercel, Cloudflare, Docker, VPS: staging, preprod, production, verification, rollback |
| M4 Database | Migration detection, CI migration test, destructive change check, deploy ordering |
| M5 Agent | Run, read logs, repair loop, PR creation, guardrails and spend caps |
| M6 Operate | Synthetic checks, alerts, incident issues, `doctor`, docs and example repos, first npm release |

## 12. Definition of done for v1

- On each sample app (Next.js with Prisma, Vite static site, Hono on Workers, FastAPI with Postgres, Django), `hollow init` produces a pipeline that passes CI and deploys to staging, with the developer only adding secrets and approving.
- A deliberately broken deploy is caught by post-deploy checks and rolled back automatically.
- A PR with a destructive migration is blocked until labeled.
- A planted secret and a known-vulnerable dependency are both caught in CI.
- Every production release is traceable from commit to image digest to approver.
