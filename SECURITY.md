# Security Policy for The Hollow

The Hollow writes and repairs CI/CD pipelines, handles deploy credentials, and sends text to an AI model. A bug here can leak secrets or let an attacker change what gets deployed, so we hold it to a higher bar than the [PatchFarm Engineering Standards](https://github.com/PatchFarm/.github/blob/main/STANDARDS.md).

## Reporting a vulnerability

**Do not open a public issue.** Use **Security → Report a vulnerability** on this repo, or email **sierralivestocode@outlook.com** with "SECURITY: the-hollow" in the subject.

Response times, disclosure, credit and safe harbor follow the [PatchFarm Security Policy](https://github.com/PatchFarm/.github/blob/main/SECURITY.md).

## Supported versions

Until 1.0, only the latest minor release gets security fixes.

## Threat model

### What we protect

- **Deploy credentials:** Vercel and Cloudflare tokens, registry credentials, SSH keys, and the user's model API key
- **Pipeline integrity:** the workflows The Hollow writes decide what code reaches production
- **Source code and logs:** the user's private code and CI output
- **The Hollow itself:** the published `the-hollow` npm package

### Trust boundaries

| Boundary | Trusted | Untrusted |
|---|---|---|
| Developer's machine | The Hollow binary, the developer's commands | Repo contents (files may come from anyone) |
| Model provider | The API connection | Everything the model returns |
| GitHub | The API with the developer's token | CI logs, PR titles, branch names, issue text |
| Deploy targets | Their official CLIs and APIs | Responses used to make decisions |

### Threats and how we handle them

| Threat | Mitigation |
|---|---|
| Secrets leak to the model provider | Secret values are never read into prompts. Logs and files are redacted before any model call: token shapes (GitHub, model providers, cloud, payment, registry and chat tokens, JWTs, private keys), passwords in URLs, credentials in headers, the values of secret-looking settings, and every value in the project's `.env` files (`src/agent/redact.ts`). Redaction has its own test suite (`test/redact.test.ts`). |
| Secrets leak through The Hollow's own output | Secret values are never printed or written to disk. `hollow secrets` lists names only, takes secret values through a prompt that shows nothing (or stdin), passes them to `gh secret set` on stdin (never as an argument, so they never appear in the process list), and never logs them. A test checks that a value never reaches the output, even when gh fails. |
| Prompt injection from repo files or CI logs makes the agent write a malicious pipeline | The agent can only edit an allowlist of paths (`.github/`, `deploy/`, `hollow.yml`, `.pre-commit-config.yaml`, `Dockerfile`, `.dockerignore`, `vercel.json`, `wrangler.*`), checked by `src/agent/allowlist.ts`, which also refuses `..`, absolute paths and any path through a symlink. Every generated or repaired workflow must pass the policy checks below before it is written. All changes arrive as a pull request a human reviews. |
| Generated pipelines are insecure | A built-in policy linter (`src/verify/policy.ts`) blocks: actions and reusable workflows not pinned to a full SHA, container and service images not pinned to a digest, missing top-level `permissions` or ones that grant writes, `write-all` and `read-all`, `pull_request_target` or `workflow_run` checking out pull request code, secrets in those workflows or passed with `secrets: inherit`, any `${{ }}` expression inside a `run:` or `github-script` script, piping a download into an interpreter, and checkouts that keep the token. `hollow init` and `hollow upgrade` run it on every workflow before writing anything, and The Hollow's test suite runs it on every template for every sample app and target. |
| Production deploy without approval | Before a release deploys, the generated workflow checks that the production environment has required reviewers. If it has none (private repos without GitHub Enterprise, or a repo where `hollow protect` never ran), nothing deploys until someone with write access runs the workflow by hand with the release version, and that run is the recorded approval. A manual run only deploys what a release recorded in its assets, after checking each value's format. The agent cannot remove the gate. |
| A deploy reaches the wrong server, or leaves credentials on it | VPS deploys only connect to the host key pinned in the environment's known-hosts variable (`StrictHostKeyChecking=yes`), with a key stored as an environment secret. Values go to the server as arguments, never pasted into a remote command line, and the APP_PORT variable must be a number. The registry login on the server uses the job's short-lived token and is removed when the step ends. |
| Deploy credentials reach code that should not have them | The Vercel token is given only to the steps that pull settings and deploy, never to the build step that runs the project's scripts. Previews run only for pull requests from branches in the repo, so fork code never sees the token. The job that builds has read-only access to the repo; release assets reach the job that can write releases as a workflow artifact. The Vercel CLI is pinned to its tarball's SHA-512 and installed without running install scripts. |
| A bad build reaches production | Every environment runs the same digest, built once and attested. Production deploys only a released digest that already passed staging, after the environment's approval. A failed health check rolls the environment back to the previous digest. |
| `hollow protect` weakens a repo or changes the wrong one | It shows the repo name and every change first and sends only read requests until the developer confirms (or passes `--yes`). It goes through the developer's own `gh` login and never reads or stores a token. It only adds or tightens settings and never deletes rulesets or branch policies it did not create. Required checks are tied to the GitHub Actions app, so another app cannot report them. The one setting that loosens anything, letting Actions open pull requests (which also lets workflows approve them), is only turned on when no approval is required. |
| Supply chain attack on The Hollow | Minimal dependencies, committed lockfile, actions pinned by SHA, npm trusted publishing with provenance from CI only, 2FA on maintainer accounts. |
| The agent runs away (cost, retries, pushes) | Hard caps on retries and spend, shown before each run. The agent pushes only to its own branch, never to `main`. |

### In scope for reports

Anything that breaks the mitigations above, for example: a secret reaching the model or the terminal, the agent writing outside its allowlist, a generated workflow that passes the policy linter but is exploitable, or a production deploy that skips approval.

## Running on private repositories

PatchFarm's own repositories are public, but you can run The Hollow on private ones. When you do, code and CI logs are sent (after redaction) to the model provider you configure, under that provider's terms. Run with `--no-ai` to keep everything on your machine and GitHub.
