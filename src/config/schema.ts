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

/** One shell line. hollow.yml is reviewed like code, and every workflow still passes the policy. */
const command = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/[\r\n]/.test(value), "must be a single line");

export const commandsSchema = z
  .strictObject({
    install: command.optional().meta({ description: "Installs dependencies from the lockfile." }),
    lint: z.union([command, z.literal(false)]).optional(),
    format: z.union([command, z.literal(false)]).optional(),
    typecheck: z.union([command, z.literal(false)]).optional(),
    test: command.optional(),
    build: z.union([command, z.literal(false)]).optional(),
  })
  .meta({
    description:
      "Commands CI runs instead of the detected ones. `false` drops a check; tests cannot be dropped.",
  });

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
    commands: commandsSchema.optional(),
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
  approvers: z.array(githubLogin).max(6, "GitHub allows at most 6 approvers").default([]).meta({
    description:
      "Who can approve production deploys (up to 6 users or org/team). Empty means whoever runs `hollow protect`.",
  }),
  preventSelfReview: z.boolean().default(false).meta({
    description:
      "Stop people from approving deploys they started. Leave off when one person both deploys and approves.",
  }),
});

export const environmentsSchema = z
  .strictObject({
    staging: stagingSchema.default({}),
    preprod: preprodSchema.default({ enabled: false }),
    production: productionSchema.default({ approvers: [], preventSelfReview: false }),
  })
  .meta({
    description:
      "Staging and production always exist. Production is always behind an approval gate, which cannot be turned off.",
  });

const vercelTarget = z.strictObject({
  target: z.literal("vercel"),
  tokenSecret: secretName.default("VERCEL_TOKEN"),
  orgIdVariable: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, "must be the NAME of a GitHub Actions variable (UPPER_SNAKE_CASE)")
    .default("VERCEL_ORG_ID")
    .meta({ description: "GitHub Actions variable holding the Vercel team (org) ID." }),
  projectIdVariable: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, "must be the NAME of a GitHub Actions variable (UPPER_SNAKE_CASE)")
    .default("VERCEL_PROJECT_ID")
    .meta({ description: "GitHub Actions variable holding the Vercel project ID." }),
  bypassSecret: secretName.default("VERCEL_AUTOMATION_BYPASS_SECRET").meta({
    description:
      "Optional secret with Vercel's Protection Bypass for Automation value, so health checks can reach protected deployment URLs.",
  }),
});

const accountIdVariable = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be the NAME of a GitHub Actions variable (UPPER_SNAKE_CASE)")
  .default("CLOUDFLARE_ACCOUNT_ID")
  .meta({ description: "GitHub Actions variable holding the Cloudflare account ID." });

const cloudflareWorkersTarget = z.strictObject({
  target: z.literal("cloudflare-workers"),
  tokenSecret: secretName.default("CLOUDFLARE_API_TOKEN"),
  accountIdVariable,
});

const cloudflarePagesTarget = z.strictObject({
  target: z.literal("cloudflare-pages"),
  tokenSecret: secretName.default("CLOUDFLARE_API_TOKEN"),
  accountIdVariable,
  projectName: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a Cloudflare Pages project name"),
});

const imageName = z
  .string()
  .regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/, "must be a lowercase image name like `owner/app`")
  .optional()
  .meta({ description: "Image name in the registry. Defaults to the GitHub repo name." });

const appPort = z.int().min(1).max(65535).optional().meta({
  description:
    "Port the app listens on inside its container. Defaults to 3000 for Node and 8000 for Python.",
});

const variableName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be the NAME of a GitHub Actions variable (UPPER_SNAKE_CASE)");

const dockerTarget = z.strictObject({
  target: z.literal("docker"),
  registry: z.literal("ghcr.io").default("ghcr.io"),
  image: imageName,
  appPort,
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
  knownHostsVariable: variableName.default("VPS_KNOWN_HOSTS").meta({
    description:
      "GitHub Actions variable holding the server's SSH host key line (from `ssh-keyscan`), so deploys only talk to that server.",
  }),
  image: imageName,
  appPort,
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

export const protectionSchema = z
  .strictObject({
    requiredApprovals: z.int().min(0).max(6).default(0).meta({
      description:
        "Approvals a pull request needs before it can merge. 0 suits a solo project, since GitHub does not let you approve your own pull request.",
    }),
  })
  .meta({ description: "Branch rules that `hollow protect` applies to the default branch." });

export const verifySchema = z
  .strictObject({
    healthPath: z
      .string()
      .regex(/^\/[A-Za-z0-9._~/?=&%-]*$/, "must be a path starting with /")
      .default("/")
      .meta({
        description:
          "Path checked after every deploy, on each environment's url. A failed check rolls the deploy back.",
      }),
    syntheticEvery: z.enum(["off", "5m", "15m", "30m", "1h"]).default("15m").meta({
      description:
        "How often scheduled.yml checks each environment's url plus healthPath. GitHub runs schedules at best every 5 minutes and often late, so this is a baseline, not uptime monitoring.",
    }),
  })
  .meta({ description: "How each deploy is checked." });

export const securitySchema = z.strictObject({
  failOn: z.enum(["critical", "high", "medium", "low"]).default("high").meta({
    description: "Lowest severity that fails the pipeline. Lower findings are reported only.",
  }),
  sast: z
    .enum(["auto", "codeql", "semgrep"])
    .default("auto")
    .meta({ description: "`auto` uses CodeQL on public repos and Semgrep on private ones." }),
  nightlyScan: z.boolean().default(true).meta({
    description:
      "Re-scan the default branch's dependencies every night, since new vulnerabilities are published without any code changing.",
  }),
});

export const databaseSchema = z.strictObject({
  migrations: z.enum(["auto", "none", "prisma", "drizzle", "alembic", "django"]).default("auto"),
  destructiveChangeLabel: z
    .string()
    .min(1)
    .max(50)
    .default("allow-destructive-migration")
    .meta({ description: "PR label required to merge a migration that drops or renames data." }),
  urlSecret: secretName.default("DATABASE_URL").meta({
    description:
      "Environment secret with each environment's database URL, used to migrate it before a deploy. On the VPS target, migrations read DATABASE_URL from the server's .env instead.",
  }),
});

export const notificationsSchema = z.strictObject({
  slackWebhookSecret: secretName.optional(),
  discordWebhookSecret: secretName.optional(),
  incidentIssues: z
    .boolean()
    .default(true)
    .meta({ description: "Open an issue when a production deploy fails." }),
});

/** Model endpoints: https anywhere, plain http only on this machine (local models). */
const endpoint = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  }, "must be https, or http on localhost for a local model")
  .meta({
    description:
      "The API base URL, for example https://api.openai.com/v1 or http://localhost:11434/v1.",
  });

export const agentSchema = z
  .strictObject({
    ai: z
      .boolean()
      .default(true)
      .meta({ description: "Set to false for the same result as --no-ai." }),
    provider: z.enum(["openai-compatible", "anthropic"]).optional().meta({
      description:
        "How to talk to your model: the OpenAI-compatible Chat Completions API (most hosted providers and local servers) or Anthropic's Messages API. No model is used until this and model are set.",
    }),
    model: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .meta({ description: "Model name, as your provider spells it." }),
    baseUrl: endpoint.optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "must be an environment variable NAME, never the key")
      .default("HOLLOW_AI_API_KEY")
      .meta({
        description: "Environment variable holding the API key. The key never goes in hollow.yml.",
      }),
    maxRepairAttempts: z.int().min(0).max(10).default(3),
    maxSpendUsd: z
      .number()
      .min(0)
      .max(100)
      .default(2)
      .meta({ description: "Hard cap on model spend per run, in US dollars. Needs pricing." }),
    pricing: z
      .strictObject({
        inputPerMillionUsd: z.number().min(0).max(1000),
        outputPerMillionUsd: z.number().min(0).max(1000),
      })
      .optional()
      .meta({
        description:
          "Your model's price per million tokens, so the spend cap can count dollars. Without it, maxTokens caps each run instead.",
      }),
    maxTokens: z
      .int()
      .min(1000)
      .max(10_000_000)
      .default(300_000)
      .meta({ description: "Token budget per run when pricing is not set (input plus output)." }),
  })
  .superRefine((agent, context) => {
    if (agent.provider !== undefined && agent.model === undefined) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "set the model to use with this provider",
      });
    }
    if (agent.provider === "openai-compatible" && agent.baseUrl === undefined) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "set the provider's API base URL, for example https://api.openai.com/v1",
      });
    }
  });

export const hollowConfigSchema = z
  .strictObject({
    version: z.literal(1).meta({ description: "Schema version. Always 1 for now." }),
    project: projectSchema.default({}),
    environments: environmentsSchema.default({
      staging: {},
      preprod: { enabled: false },
      production: { approvers: [], preventSelfReview: false },
    }),
    deploy: deploySchema,
    release: releaseSchema.default({ tokenSecret: "RELEASE_PLEASE_TOKEN" }),
    protection: protectionSchema.default({ requiredApprovals: 0 }),
    verify: verifySchema.default({ healthPath: "/", syntheticEvery: "15m" }),
    security: securitySchema.default({ failOn: "high", sast: "auto", nightlyScan: true }),
    database: databaseSchema.default({
      migrations: "auto",
      destructiveChangeLabel: "allow-destructive-migration",
      urlSecret: "DATABASE_URL",
    }),
    notifications: notificationsSchema.default({ incidentIssues: true }),
    agent: agentSchema.default({
      ai: true,
      apiKeyEnv: "HOLLOW_AI_API_KEY",
      maxRepairAttempts: 3,
      maxSpendUsd: 2,
      maxTokens: 300_000,
    }),
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
