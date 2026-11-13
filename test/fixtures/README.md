# Test fixtures

Small sample projects that The Hollow's tests run against. They match the sample apps in the v1 definition of done (docs/SCOPE.md section 12).

| Fixture | Stack |
|---|---|
| `node-next-prisma` | Next.js, Prisma on Postgres, npm, ESLint, Vitest, Playwright |
| `node-vite-static` | Vite static site, pnpm (via `packageManager`), Prettier, no tests |
| `node-hono-workers` | Hono on Cloudflare Workers, yarn, Biome, Vitest |
| `python-fastapi` | FastAPI, SQLAlchemy and Alembic on Postgres, uv, Ruff, mypy, pytest, Docker |
| `python-django` | Django on Postgres, pip with requirements files, Ruff, pytest |
| `empty` | Not a project |

For M0 these hold just enough files for detection. Later milestones turn them into apps that build and run, so generated pipelines can be tested end to end.

Lockfiles here are stubs. Fixtures never contain secrets; settings read them from environment variables.
