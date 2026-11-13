# The Hollow

**Status: early development. Milestone M0 (foundation) is in: the CLI skeleton, project detection and the `hollow.yml` schema. It does not generate pipelines yet, and there is no npm release.**

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

`hollow plan` is read-only. It shows what The Hollow detects in a project (language, package manager, runtime, frameworks, linters, tests, migrations, databases, containers and deploy config) with the file each finding came from, and validates `hollow.yml` if there is one. Add `--json` for machine-readable output.

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
