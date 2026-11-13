# Contributing to The Hollow

Start with the [PatchFarm contributing guide](https://github.com/PatchFarm/.github/blob/main/CONTRIBUTING.md). Everything there applies here. This file adds the rules specific to The Hollow.

Development setup instructions will be added once the first code lands (milestone M0 in [docs/SCOPE.md](docs/SCOPE.md)).

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
