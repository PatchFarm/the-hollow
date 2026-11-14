# The Hollow

**Status: early development. The Hollow generates the CI half of the pipeline (build, quality, tests and security scanning) for Node/TypeScript and Python. Releases and deploys come next. There is no npm release yet.**

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
