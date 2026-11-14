import { z } from "zod";

/**
 * The `hollow.yml` schema, version 1. This file is the source of truth for the pipeline:
 * `hollow init` writes it, `hollow upgrade` regenerates workflows from it.
 *
 * Objects are strict so a typo (`enviroments:`) is an error, not a silently ignored key.
 * Secrets are referenced by the *name* of a GitHub secret, never by value.
 */

const secretName = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]*$/,
    "must be the NAME of a GitHub secret (UPPER_SNAKE_CASE), never its value",
  )
  .meta({ description: "Name of a GitHub Actions secret. Never put secret values in hollow.yml." });

const httpsUrl = z
  .url({ protocol: /^https$/, error: "must be an https:// URL" })
  .meta({ description: "Public https URL used for health checks and smoke tests." });

const githubLogin = z
  .string()
  .regex(
    /^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]+)?$/,
    "must be a GitHub user or org/team",
  )
  .meta({ description: "GitHub user (`octocat`) or team (`org/team`)." });

export const projectSchema = z
  .strictObject({
    language: z.enum(["node", "python"]).optional(),
    packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "pip", "uv", "poetry"]).optional(),
    runtimeVersion: z
      .string()
      .min(1)
      .optional()
      .meta({ description: "Node or Python version, for example `22` or `3.13`." }),
    defaultBranch: z
      .string()
      .regex(/^[A-Za-z0-9._/-]+$/, "must be a git branch name")
      .refine((value) => !value.split("/").includes(".."), "must not contain `..`")
      .optional()
      .meta({ description: "Branch that CI runs on after merges. Defaults to `main`." }),
  })
  .meta({ description: "Overrides for what The Hollow detects. Leave empty to use detection." });

const stagingSchema = z.strictObject({
  url: httpsUrl.optional(),
});

const preprodSchema = z.strictObject({
  enabled: z.boolean().default(false).meta({ description: "Preprod is opt-in." }),
  url: httpsUrl.optional(),
});

const productionSchema = z.strictObject({
  url: httpsUrl.optional(),
  approvers: z
    .array(githubLogin)
    .default([])
    .meta({ description: "Who can approve production deploys. Empty means repo admins." }),
});

export const environmentsSchema = z
  .strictObject({
    staging: stagingSchema.default({}),
    preprod: preprodSchema.default({ enabled: false }),
    production: productionSchema.default({ approvers: [] }),
  })
  .meta({
    description:
      "Staging and production always exist. Production is always behind an approval gate, which cannot be turned off.",
  });

const vercelTarget = z.strictObject({
  target: z.literal("vercel"),
  tokenSecret: secretName.default("VERCEL_TOKEN"),
});

const cloudflareWorkersTarget = z.strictObject({
  target: z.literal("cloudflare-workers"),
  tokenSecret: secretName.default("CLOUDFLARE_API_TOKEN"),
});

const cloudflarePagesTarget = z.strictObject({
  target: z.literal("cloudflare-pages"),
  tokenSecret: secretName.default("CLOUDFLARE_API_TOKEN"),
  projectName: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a Cloudflare Pages project name"),
});

const imageName = z
  .string()
  .regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/, "must be a lowercase image name like `owner/app`")
  .optional()
  .meta({ description: "Image name in the registry. Defaults to the GitHub repo name." });

const dockerTarget = z.strictObject({
  target: z.literal("docker"),
  registry: z.literal("ghcr.io").default("ghcr.io"),
  image: imageName,
});

const vpsTarget = z.strictObject({
  target: z.literal("vps"),
  host: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/, "must be a hostname or IP address")
    .meta({ description: "Server hostname or IP. Its SSH host key is pinned in known_hosts." }),
  user: z
    .string()
    .regex(/^[a-z_][a-z0-9_-]*$/, "must be a Unix user name")
    .default("deploy"),
  port: z.int().min(1).max(65535).default(22),
  path: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]*$/, "must be an absolute path")
    .refine((value) => !value.split("/").includes(".."), "must not contain `..`")
    .default("/srv/app"),
  sshKeySecret: secretName.default("VPS_SSH_KEY"),
  image: imageName,
});

export const deploySchema = z
  .discriminatedUnion("target", [
    vercelTarget,
    cloudflareWorkersTarget,
    cloudflarePagesTarget,
    dockerTarget,
    vpsTarget,
  ])
  .meta({ description: "Where the app is deployed." });

const relativeDir = z
  .string()
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, "must be a relative path inside the project")
  .refine((value) => !value.split("/").includes(".."), "must not contain `..`");

export const releaseSchema = z
  .strictObject({
    tokenSecret: secretName.default("RELEASE_PLEASE_TOKEN").meta({
      description:
        "Secret with a token release-please uses, so its release pull requests run CI. Falls back to the workflow's own token when the secret is not set.",
    }),
    outputDir: relativeDir.optional().meta({
      description:
        "Build output folder to attach to each release for targets without a container image. Detected for Vite, Astro, Next.js, Nuxt and Cloudflare Pages.",
    }),
  })
  .meta({ description: "How releases are versioned and what each release carries." });

export const securitySchema = z.strictObject({
  failOn: z.enum(["critical", "high", "medium", "low"]).default("high").meta({
    description: "Lowest severity that fails the pipeline. Lower findings are reported only.",
  }),
  sast: z
    .enum(["auto", "codeql", "semgrep"])
    .default("auto")
    .meta({ description: "`auto` uses CodeQL on public repos and Semgrep on private ones." }),
});

export const databaseSchema = z.strictObject({
  migrations: z.enum(["auto", "none", "prisma", "drizzle", "alembic", "django"]).default("auto"),
  destructiveChangeLabel: z
    .string()
    .min(1)
    .max(50)
    .default("allow-destructive-migration")
    .meta({ description: "PR label required to merge a migration that drops or renames data." }),
});

export const notificationsSchema = z.strictObject({
  slackWebhookSecret: secretName.optional(),
  discordWebhookSecret: secretName.optional(),
  incidentIssues: z
    .boolean()
    .default(true)
    .meta({ description: "Open an issue when a production deploy fails." }),
});

export const agentSchema = z.strictObject({
  ai: z
    .boolean()
    .default(true)
    .meta({ description: "Set to false for the same result as --no-ai." }),
  maxRepairAttempts: z.int().min(0).max(10).default(3),
  maxSpendUsd: z
    .number()
    .min(0)
    .max(100)
    .default(2)
    .meta({ description: "Hard cap on model spend per run, in US dollars." }),
});

export const hollowConfigSchema = z
  .strictObject({
    version: z.literal(1).meta({ description: "Schema version. Always 1 for now." }),
    project: projectSchema.default({}),
    environments: environmentsSchema.default({
      staging: {},
      preprod: { enabled: false },
      production: { approvers: [] },
    }),
    deploy: deploySchema,
    release: releaseSchema.default({ tokenSecret: "RELEASE_PLEASE_TOKEN" }),
    security: securitySchema.default({ failOn: "high", sast: "auto" }),
    database: databaseSchema.default({
      migrations: "auto",
      destructiveChangeLabel: "allow-destructive-migration",
    }),
    notifications: notificationsSchema.default({ incidentIssues: true }),
    agent: agentSchema.default({ ai: true, maxRepairAttempts: 3, maxSpendUsd: 2 }),
  })
  .meta({
    title: "hollow.yml",
    description: "Configuration for The Hollow. https://github.com/PatchFarm/the-hollow",
  });

/** The config as written in hollow.yml (defaults optional). */
export type HollowConfigInput = z.input<typeof hollowConfigSchema>;
/** The config after validation, with every default filled in. */
export type HollowConfig = z.output<typeof hollowConfigSchema>;

/** JSON Schema for editors (`# yaml-language-server: $schema=...`). Checked in at schema/. */
export function hollowJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(hollowConfigSchema, { io: "input", target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}
