# The Hollow

**Status: early development. For Node/TypeScript and Python, The Hollow generates CI (build, quality, tests and security scanning) and release workflows, protects the repo on GitHub, and deploys to Docker (GHCR), VPS, Vercel and Cloudflare (Workers and Pages) targets. There is no npm release yet.**

The Hollow is an AI agent that sets up a complete, secure CI/CD pipeline for your project on GitHub Actions. It works out what your project needs, writes the pipeline, runs it, fixes it until it passes, and hands you the result as a pull request.

It covers the whole path from commit to production: build, code quality, tests, security scanning, artifacts, staging, approval, production deploys to Vercel, Cloudflare, Docker or a VPS over SSH, post-deploy checks and automatic rollback.

- **What it will do, and won't:** [docs/SCOPE.md](docs/SCOPE.md)
- **Security and threat model:** [SECURITY.md](SECURITY.md)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)

Planned usage, once released:

```bash
npx the-hollow init
```

## Try it from source

You need Node 22 or newer.

```bash
git clone https://github.com/PatchFarm/the-hollow.git
cd the-hollow
npm ci
npm run build
node dist/cli.js plan --cwd /path/to/your/project
```

`hollow plan` is read-only. It shows what The Hollow detects in a project (language, package manager, runtime, frameworks, linters, tests, migrations, databases, containers and deploy config) with the file each finding came from, validates `hollow.yml` if there is one, and lists the CI steps it would generate. Add `--json` for machine-readable output.

`hollow init` asks where the app deploys (suggesting what it detected), then writes:

- `hollow.yml`, the config you own and edit
- `.github/workflows/ci.yml`, which runs on every pull request and every push to your default branch:
  - your project's own lint, format, type check, test and build steps, with a database service container when the app uses one
  - your migrations (Prisma, Drizzle, Alembic or Django) applied to that throwaway database on every run, so a migration that does not apply never merges; for Django, also a check that every model change has a migration
  - Gitleaks (secrets), OSV-Scanner (dependencies), CodeQL on public repos or Semgrep on private ones, and Trivy when there is a Dockerfile
  - one `CI passed` check to require in branch protection
- `.github/workflows/release.yml`, which versions releases from your Conventional Commits with [release-please](https://github.com/googleapis/release-please). It keeps a release pull request open with the changelog; merging it tags the version and creates the GitHub release.
  - **Docker and VPS targets:** every merge builds the image once, pushes it to GHCR with an SBOM (Syft) and a signed provenance attestation, and deploys it to `staging`. A release tags that same digest with its version and promotes it to `preprod` (if enabled) and then `production`, which waits for approval. Nothing is rebuilt along the way.
    - Docker: each environment is a tag (`:staging`, `:production`) moved to the new digest; point whatever runs the container at those tags.
    - VPS: the workflow connects over SSH (with the server's host key pinned), copies `deploy/compose.yaml` to `<path>/<environment>/` and runs `docker compose up --wait`. Environments can share a server: production listens on the app port, staging on the next one and preprod on the one after, all on 127.0.0.1 behind your reverse proxy.
    - After each deploy, the environment's `url` plus `verify.healthPath` must answer without a server error within two minutes, or the deploy is rolled back to the previous digest. On a VPS the container's own health check is also required.
  - **Vercel:** every merge makes one production build and deploys it without taking your production domains (a staged production deployment). That is staging, and its build output gets a provenance attestation and an SBOM. A release attaches them to the GitHub release and, after the production environment's approval, promotes that exact deployment: no rebuild, so production runs what staging ran. Staging therefore uses production's Vercel environment variables. `staging.url` and `preprod.url`, when set, are pointed at the deployment with `vercel alias`; a failed production check rolls back to the deployment that was live before. Set the `VERCEL_AUTOMATION_BYPASS_SECRET` secret so checks can get past Vercel's deployment protection.
  - **Cloudflare Workers:** every merge uploads a new version of your production Worker without serving it (`wrangler versions upload`), with the bundle attested and an SBOM. Its Version URL (`staging-<worker>.<subdomain>.workers.dev`) is staging. A release sends all traffic to that exact version after approval, and a failed check sends it back to the version that served before. Like Vercel, staging uses production's bindings and data; turn on Version URLs (`preview_urls = true`) so staging can be checked, and put the Worker behind Cloudflare Access if those URLs should not be public. Workers have no preprod step.
  - **Cloudflare Pages:** every merge builds once, attests the output and deploys it to the project's `staging` branch (a preview with the preview variables). A release deploys that same output to the production branch, and a failed check rolls back through the Cloudflare API. Preprod, when enabled, deploys it to a `preprod` branch first.
  - Both use the project's own wrangler when `package.json` lists it, and otherwise a checksum-pinned one.
  - **Migrations, on every target:** when the project has migrations, each deploy applies them to that environment's database before its new code goes live, and a failed migration stops the deploy with the previous version still running.
    - Docker, Vercel and Cloudflare: the deploy job checks out the release, installs, and runs the migrations with the environment's `DATABASE_URL` secret (`database.urlSecret`). A missing secret stops the deploy with a message saying where to add it. On Vercel and Workers, staging already runs on production's settings and database, so migrations run on release: before preprod serves the new deployment (Vercel) and before production gets it. Docker and Pages migrate every environment, staging included.
    - VPS: before starting the new image, the server backs the database up with a pinned `pg_dump` or `mysqldump` image to `<path>/<environment>/backups/` (keeping the newest seven), then applies the migrations inside the new image with the environment's `.env`. If the backup fails, nothing is migrated or deployed. Node projects need `prisma` or `drizzle-kit` in `dependencies`, since the starter Dockerfile leaves dev dependencies out.
    - A rollback restores the previous code, never the schema, so every migration has to work with the code before it too. `docs/migrations.md` explains the expand, migrate, contract pattern for each kind of change.
  - **Production approval, on every target:** before a release deploys, the workflow checks that the `production` environment has required reviewers (`hollow protect` sets them up) and waits for their approval. GitHub offers required reviewers on private repos only with Enterprise; there, or anywhere they are missing, the release stops before production and the run summary says how to approve it: someone with write access runs the Release workflow with the version (`gh workflow run release.yml -f version=v1.4.0`). That run deploys exactly what the release recorded in its assets (image digest, Vercel deployment, Worker version or Pages build), from the release's tag, and records who ran it. It also works to redeploy an earlier release.
- `.github/workflows/preview.yml` (Vercel and Cloudflare Pages): a preview deploy for each pull request from a branch in the repo, with the URL posted on the pull request. Pull requests from forks and Dependabot get none, since they never receive the token.
- `.github/workflows/pr-title.yml`, which requires Conventional Commit pull request titles (`feat: ...`, `fix(api): ...`), since squash merges turn them into the commit history releases are built from
- `.github/workflows/migrations.yml` and `.github/hollow/check-migrations.py`, when the project has migrations: a `Migration safety` check on each pull request that reads the migration files it adds or changes and fails on destructive changes (dropped tables or columns, renames, type changes, NOT NULL without a default), since old code keeps running while a deploy rolls out. Split those into expand, migrate and contract steps across releases, or add the `allow-destructive-migration` label (`database.destructiveChangeLabel`) when the change is safe; adding or removing the label re-runs just this check. `hollow protect` makes it a required check
- `.github/dependabot.yml`, with weekly grouped updates held back 7 days after each release and titled as Conventional Commits
- `.pre-commit-config.yaml`, which runs Gitleaks and your lint and format checks before each commit (skipped if you already use Husky or Lefthook)
- starting points you own: `.editorconfig`, a pull request template and a CODEOWNERS stub. For Docker and VPS targets without a Dockerfile, also a starter `Dockerfile` (multi-stage, non-root, base image pinned by digest, start command detected for Django, FastAPI, Flask and `npm start`) and `.dockerignore`, and for VPS a `deploy/compose.yaml`. For projects with migrations, a `docs/migrations.md` that explains how this pipeline runs them and how to change a schema without breaking the running code. For Vercel, a `vercel.json` that turns off Vercel's own Git deploys, so only the pipeline deploys (if you already have one, init tells you the setting to add). These are only created if missing and never overwritten.

It never touches git and never overwrites a file it did not write (unless you pass `--force`), so you review the result with `git diff` and open the pull request yourself. Every action in the workflow is pinned to a commit SHA, every downloaded tool is checked against its published checksum, and each job gets only the permissions it needs.

`hollow check` runs the same checks on your machine before you push: your lint, format, type check, test and build steps, plus Gitleaks and OSV-Scanner if they are installed (with the same fail threshold as CI). It uses the dependencies you already have; add `--install` to run CI's locked install first, or `--only lint,test` to run some of them. It runs your project's own scripts, the same way `npm run` does.

After you change `hollow.yml`, run `hollow upgrade` to regenerate the files The Hollow owns. It leaves your starting-point files alone; run `hollow init` again to add any that are missing. Both commands take `--dry-run`. If [actionlint](https://github.com/rhysd/actionlint) is installed, they check the workflow with it before writing anything.

Once the workflows are merged, `hollow protect` sets up the repo on GitHub through your own [gh](https://cli.github.com) login. It reads the current settings, shows exactly what it would change, and changes nothing until you say yes (`--dry-run` only shows; `--yes` skips the question, for scripts):

- a `The Hollow` ruleset on your default branch: changes only through pull requests, squash merges only, no force pushes or deletion, no bypass, and the `CI passed` and `Conventional Commit title` checks required, accepted only from GitHub Actions. It needs 0 approvals by default, since GitHub doesn't let you approve your own pull request; set `protection.requiredApprovals` in `hollow.yml` once you have a reviewer
- squash commits that take the pull request title, so the Conventional Commit title becomes the commit message, and branches deleted after merge
- `staging` and `production` environments (and `preprod` if enabled) that deploy only from the default branch. Production deploys wait for approval from `environments.production.approvers`, or from you if none are listed
- read-only workflow tokens by default, and permission for GitHub Actions to open pull requests so release-please can open its release PR. That permission also lets workflows approve pull requests, so it is only turned on when no approval is required
- secret scanning with push protection, Dependabot alerts and security fixes, and private vulnerability reporting

It needs admin access to the repo. It only adds or tightens settings, and leaves other rulesets and branch policies alone (it points them out). Some of this depends on your GitHub plan: private repos get deploy approvals only on GitHub Enterprise, and private repos on GitHub Free get no branch rules or environments at all. `hollow protect` applies what your plan allows and says what it could not. Run it again any time: when nothing has drifted, it changes nothing.

`hollow secrets` lists every secret and variable the generated workflows read, per environment, marked set or missing. It reads names only: GitHub never returns secret values, and The Hollow does not read variable values. In a terminal it then offers to set the missing ones: secret values are typed without being shown, SSH keys are read from a file you point to, and for a VPS host key it runs `ssh-keyscan`, shows the fingerprints and saves them only once you confirm they match your server. Values go straight to `gh secret set` / `gh variable set` on stdin and are never printed or written to disk. For scripts, `hollow secrets set NAME [--env ENV]` reads one value from stdin, and `hollow secrets` exits non-zero while anything required is missing.

## hollow.yml

`hollow.yml` is the source of truth for your pipeline. A minimal one:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/PatchFarm/the-hollow/main/schema/hollow.schema.json
version: 1
deploy:
  target: vercel # or cloudflare-workers, cloudflare-pages, docker, vps
```

Everything else has safe defaults: staging and production environments, production behind an approval gate, builds fail on high or critical security findings, and the agent is capped at 3 repair attempts and $2 of model spend per run. The full schema is in [schema/hollow.schema.json](schema/hollow.schema.json). Secrets are always referenced by the name of a GitHub secret, never by value.

Licensed under [Apache-2.0](LICENSE). Part of [PatchFarm](https://github.com/PatchFarm).
