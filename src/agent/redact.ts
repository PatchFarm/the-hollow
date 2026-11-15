import type { ProjectFiles } from "../util/project-files.js";

/**
 * Redaction for everything the agent may send to a model: CI logs and file contents. Secret
 * values must never reach the provider (SECURITY.md, "Secrets leak to the model provider"), so
 * this errs on the side of hiding too much.
 */

export const REDACTED = "[REDACTED]";

/** Token formats with a recognisable shape. Each match is replaced whole. */
const TOKEN_PATTERNS: RegExp[] = [
  // PEM private keys, including the whole body.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // GitHub tokens: classic, OAuth, app, refresh, fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // Model providers: Anthropic, OpenAI (project and legacy keys), Google, Groq, xAI, OpenRouter.
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bxai-[A-Za-z0-9]{20,}\b/g,
  /\bsk-or-v1-[a-f0-9]{32,}\b/g,
  // AWS access key IDs.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack tokens and webhooks, Discord webhooks.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g,
  // Stripe, npm, PyPI, Docker Hub, Vercel, GitLab.
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bpypi-[A-Za-z0-9_-]{50,}\b/g,
  /\bdckr_pat_[A-Za-z0-9_-]{20,}\b/g,
  /\bvc[pk]_[A-Za-z0-9]{24,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Words that make a variable or field name a secret. */
const SECRET_WORDS =
  "SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|DATABASE_URL|DSN|WEBHOOK|COOKIE|SESSION_KEY|SIGNING_KEY";

/** `NAME=value`, `NAME: value`, `"name": "value"` where the name contains a secret word. */
const ASSIGNMENT = new RegExp(
  String.raw`(["']?\b[A-Za-z0-9_.-]*(?:${SECRET_WORDS})[A-Za-z0-9_.-]*\b["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)`,
  "gi",
);

/** Values in assignments that are references, not secrets, and that a repair needs to see. */
function isReference(value: string): boolean {
  const bare = value.replace(/^["']|["']$/g, "");
  return (
    bare === "" ||
    bare === "***" ||
    bare === REDACTED ||
    bare.startsWith("${{") ||
    /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(bare) ||
    /^(?:true|false|null|none|yes|no|required|optional)$/i.test(bare) ||
    /^[A-Z][A-Z0-9_]*$/.test(bare) // another variable's name, such as tokenSecret: VERCEL_TOKEN
  );
}

/** Values shorter than this are not redacted by value: they would hide ordinary words. */
const MIN_VALUE_LENGTH = 6;

export interface RedactOptions {
  /** Exact values to hide wherever they appear, such as the values in the project's .env files. */
  values?: string[];
}

/** Hide secrets in text before it goes to a model. */
export function redact(text: string, options: RedactOptions = {}): string {
  let out = text;
  // Exact values first, longest first, so a value that contains another is hidden whole.
  const values = [...new Set(options.values ?? [])]
    .filter((value) => value.length >= MIN_VALUE_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join(REDACTED);

  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  // Credentials inside URLs: keep the user name and host, hide the password.
  out = out.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]*):([^/\s@]+)@/gi,
    (_match, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
  );
  // Authorization headers and similar: keep the scheme, hide the credential.
  out = out.replace(
    /\b((?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|token|Token)\s+)[^\s"']+/g,
    `$1${REDACTED}`,
  );
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, `$1${REDACTED}`);
  out = out.replace(ASSIGNMENT, (match: string, name: string, value: string) =>
    isReference(value) ? match : `${name}${REDACTED}`,
  );
  return out;
}

/** The .env files whose values are hidden wherever they turn up. */
const ENV_FILE = /^\.env(?:\..+)?$/;

/**
 * The values (never the names) in the project's .env files, so they can be hidden in logs even
 * when they have no recognisable shape. They stay in memory and are only used for redaction.
 */
export function localSecretValues(files: ProjectFiles): string[] {
  const values: string[] = [];
  for (const name of files.list(".")) {
    if (!ENV_FILE.test(name) || /\.(?:example|sample|template|dist)$/.test(name)) continue;
    const text = files.readText(name) ?? "";
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      let value = (match[1] ?? "").trim();
      const quoted = /^(["'])(.*)\1$/.exec(value);
      value = quoted ? (quoted[2] ?? "") : value.replace(/\s+#.*$/, "");
      if (value.length >= MIN_VALUE_LENGTH) values.push(value);
    }
  }
  return values;
}
