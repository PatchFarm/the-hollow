# Contributing to The Hollow

Start with the [PatchFarm contributing guide](https://github.com/PatchFarm/.github/blob/main/CONTRIBUTING.md). Everything there applies here. This file adds the rules specific to The Hollow.

## Development setup

You need Node 22 or newer.

```bash
npm ci              # install from the lockfile
npm test            # Vitest
npm run typecheck   # tsc, strict mode
npm run lint        # Biome (lint and format check); npm run format fixes what it can
npm run build       # compile to dist/
node dist/cli.js plan --cwd test/fixtures/python-fastapi
```

CI runs all of these on Node 22 and 24 for every pull request.

**Layout**
- `src/cli/`: argument parsing and output
- `src/detect/`: project detection, one file per language plus shared signals
- `src/config/`: the `hollow.yml` schema (zod) and loader
- `src/pipeline/plan.ts`: the typed pipeline model (what CI runs for a project), built from detection plus `hollow.yml`
- `src/generate/`: renders the model into workflow and config files. `pins.ts` holds every pinned action, binary and image
- `src/util/project-files.ts` and `src/util/project-writer.ts`: the only way to read and write project files. They refuse paths and symlinks that leave the project root, so use them instead of `fs`
- `test/fixtures/`: sample projects (see its README)
- `test/golden/`: the reviewed output for each sample app. CI lints every golden workflow with actionlint

**Changing a template:** make the change, run `npx vitest run -u` to update `test/golden/`, and review that diff as carefully as the code. It is exactly what users will get.

**Updating a pin:** edit `src/generate/pins.ts`. Actions are pinned to the full commit SHA of a release tag, binaries to the publisher's SHA-256 checksum, images to a digest. A release has to be at least two weeks old before it is pinned.

**Changing the hollow.yml schema:** edit `src/config/schema.ts`, then run `npm run schema` to regenerate `schema/hollow.schema.json`. A test fails if the two drift apart.

**Dependencies:** runtime dependencies are kept to a minimum (currently `zod`, `yaml` and `smol-toml`, none of which pull in further packages). A PR that adds one should say why the standard library is not enough.

## Rules for this repo

**Templates and generated pipelines**
- Every template change must pass the policy linter and the fixture tests (sample apps that the generated pipeline runs against).
- Third-party actions in templates are pinned to a full commit SHA with the version in a comment. Updating a pin is its own PR.
- A new template never weakens a gate: production approval, required checks and post-deploy verification stay in place.

**Security-sensitive areas**

Changes to any of these need the `security-review` label and approval from a maintainer before merging:
- secret redaction
- the agent's allowed paths and allowed actions
- the policy linter
- anything that sends data to a model provider
- secret handling in `hollow secrets`

**Adding a deploy target**

A PR that adds a deploy target includes:
- staging, production and rollback steps
- a post-deploy health check
- the list of secrets it needs and how to create least-privilege tokens for them
- a fixture app that deploys with it in the test suite
- docs in `docs/targets/`

**Never**
- add telemetry or analytics of any kind
- log, print or store secret values, even in debug mode
- let the agent push to a default branch or act outside its allowlist
