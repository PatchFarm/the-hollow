import type { ProjectFiles } from "../util/project-files.js";
import { addFinding, type Detection } from "./types.js";

const DOCKERFILES = ["Dockerfile", "dockerfile", "Containerfile"];
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const WRANGLER_FILES = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];

/** Language-independent signals: containers and deploy target config already in the repo. */
export function detectCommon(files: ProjectFiles, result: Detection): void {
  result.container.dockerfile = files.firstExisting(DOCKERFILES);
  result.container.compose = files.firstExisting(COMPOSE_FILES);

  if (files.exists("vercel.json")) {
    addFinding(result.deployHints, "vercel", "vercel.json");
  } else if (files.exists(".vercel/project.json")) {
    addFinding(result.deployHints, "vercel", ".vercel/project.json");
  }

  const wrangler = files.firstExisting(WRANGLER_FILES);
  if (wrangler !== null) {
    // Pages projects declare a build output directory; Workers projects do not.
    const text = files.readText(wrangler) ?? "";
    const isPages = /pages_build_output_dir/.test(text);
    addFinding(result.deployHints, isPages ? "cloudflare-pages" : "cloudflare-workers", wrangler);
  }

  if (result.container.dockerfile !== null) {
    addFinding(result.deployHints, "docker", result.container.dockerfile);
  }
}

/** Parse JSON without throwing. Returns `undefined` for invalid JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only string-valued entries, so malformed manifests cannot smuggle in odd types. */
export function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}
