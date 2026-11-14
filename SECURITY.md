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
| Secrets leak to the model provider | Secret values are never read into prompts. Logs and files are redacted (token patterns, `.env` values, known secret names) before any model call. Redaction has its own test suite. |
| Secrets leak through The Hollow's own output | Secret values are never printed or written to disk. `hollow secrets` passes values straight to `gh` and never logs them. |
| Prompt injection from repo files or CI logs makes the agent write a malicious pipeline | The agent can only edit an allowlist of paths (`.github/`, `hollow.yml`, deploy config). Every generated or repaired workflow must pass the policy checks below before it is written. All changes arrive as a pull request a human reviews. |
| Generated pipelines are insecure | A built-in policy linter blocks: actions not pinned to a full SHA, missing or broad `permissions`, `pull_request_target` running fork code, secrets available to fork PRs, untrusted input interpolated into `run:` scripts, and piping remote scripts into a shell. The linter runs in The Hollow's own test suite against every template. |
| Production deploy without approval | Generated release workflows always gate production behind an environment approval (or a manual run on private repos without GitHub Enterprise, where GitHub has no deploy approvals). The agent cannot remove that gate. |
| `hollow protect` weakens a repo or changes the wrong one | It shows the repo name and every change first and sends only read requests until the developer confirms (or passes `--yes`). It goes through the developer's own `gh` login and never reads or stores a token. It only adds or tightens settings and never deletes rulesets or branch policies it did not create. Required checks are tied to the GitHub Actions app, so another app cannot report them. The one setting that loosens anything, letting Actions open pull requests (which also lets workflows approve them), is only turned on when no approval is required. |
| Supply chain attack on The Hollow | Minimal dependencies, committed lockfile, actions pinned by SHA, npm trusted publishing with provenance from CI only, 2FA on maintainer accounts. |
| The agent runs away (cost, retries, pushes) | Hard caps on retries and spend, shown before each run. The agent pushes only to its own branch, never to `main`. |

### In scope for reports

Anything that breaks the mitigations above, for example: a secret reaching the model or the terminal, the agent writing outside its allowlist, a generated workflow that passes the policy linter but is exploitable, or a production deploy that skips approval.

## Running on private repositories

PatchFarm's own repositories are public, but you can run The Hollow on private ones. When you do, code and CI logs are sent (after redaction) to the model provider you configure, under that provider's terms. Run with `--no-ai` to keep everything on your machine and GitHub.
