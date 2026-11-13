# The Hollow

**Status: in design. Nothing is built yet, and there is no release to install.**

The Hollow is an AI agent that sets up a complete, secure CI/CD pipeline for your project on GitHub Actions. It works out what your project needs, writes the pipeline, runs it, fixes it until it passes, and hands you the result as a pull request.

It covers the whole path from commit to production: build, code quality, tests, security scanning, artifacts, staging, approval, production deploys to Vercel, Cloudflare, Docker or a VPS over SSH, post-deploy checks and automatic rollback.

- **What it will do, and won't:** [docs/SCOPE.md](docs/SCOPE.md)
- **Security and threat model:** [SECURITY.md](SECURITY.md)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)

Planned usage, once released:

```bash
npx the-hollow init
```

Licensed under [Apache-2.0](LICENSE). Part of [PatchFarm](https://github.com/PatchFarm).
