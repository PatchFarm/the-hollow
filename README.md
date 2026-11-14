# The Hollow

**Status: early development. For Node/TypeScript and Python, The Hollow generates CI (build, quality, tests and security scanning) and release workflows, and protects the repo on GitHub. Deploys come next. There is no npm release yet.**

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
  - Gitleaks (secrets), OSV-Scanner (dependencies), CodeQL on public repos or Semgrep on private ones, and Trivy when there is a Dockerfile
  - one `CI passed` check to require in branch protection
- `.github/workflows/release.yml`, which versions releases from your Conventional Commits with [release-please](https://github.com/googleapis/release-please). It keeps a release pull request open with the changelog; merging it tags the version, creates the GitHub release, and builds one artifact:
  - a container image on GHCR, by digest, for the Docker and VPS targets
  - a tarball of your build output (or of the source, when the output folder is unknown) for Vercel and Cloudflare
  - an SBOM (Syft) and a signed build provenance attestation, attached to the image and the release
- `.github/workflows/pr-title.yml`, which requires Conventional Commit pull request titles (`feat: ...`, `fix(api): ...`), since squash merges turn them into the commit history releases are built from
- `.github/dependabot.yml`, with weekly grouped updates held back 7 days after each release and titled as Conventional Commits
- `.pre-commit-config.yaml`, which runs Gitleaks and your lint and format checks before each commit (skipped if you already use Husky or Lefthook)
- starting points you own: `.editorconfig`, a pull request template and a CODEOWNERS stub. These are only created if missing and never overwritten.

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
