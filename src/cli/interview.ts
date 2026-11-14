import path from "node:path";
import type { HollowConfigInput } from "../config/schema.js";
import { isRecord, parseJson } from "../detect/common.js";
import type { Detection } from "../detect/types.js";
import { ProjectFiles } from "../util/project-files.js";

export type Ask = (question: string) => Promise<string>;

export const TARGETS = [
  { name: "vercel", label: "Vercel" },
  { name: "cloudflare-workers", label: "Cloudflare Workers" },
  { name: "cloudflare-pages", label: "Cloudflare Pages" },
  { name: "docker", label: "Docker image on GHCR" },
  { name: "vps", label: "Your own server (VPS over SSH)" },
] as const;

type TargetName = (typeof TARGETS)[number]["name"];

export interface InterviewOptions {
  detection: Detection;
  /** `--target` from the command line. */
  target?: string | undefined;
  /** `--yes`: accept every suggested answer. */
  yes: boolean;
  /** Present only when a person is at the keyboard. */
  ask?: Ask | undefined;
  say: (text: string) => void;
}

export type InterviewResult =
  | { status: "ok"; config: HollowConfigInput }
  | { status: "error"; error: string };

/**
 * Ask only what detection cannot answer (docs/SCOPE.md, "How hollow works", step 2). Every
 * question has a suggested answer when detection found one, and `--yes` takes it.
 */
export async function interview(options: InterviewOptions): Promise<InterviewResult> {
  const { detection, ask, say } = options;
  const files = new ProjectFiles(detection.root);
  const suggested = suggestTarget(detection);

  let target: TargetName | null = null;
  if (options.target !== undefined) {
    target = parseTarget(options.target);
    if (target === null) {
      return {
        status: "error",
        error: `Unknown deploy target "${options.target}". Use one of: ${TARGETS.map((t) => t.name).join(", ")}.`,
      };
    }
  } else if (options.yes || ask === undefined) {
    if (suggested === null) {
      return {
        status: "error",
        error: `Could not suggest a deploy target. Pass --target (${TARGETS.map((t) => t.name).join(", ")}).`,
      };
    }
    target = suggested;
  } else {
    say("\nWhere should this app deploy? (Deploys arrive in a later release; CI works now.)\n");
    TARGETS.forEach((t, i) => {
      say(`  ${i + 1}. ${t.label}${t.name === suggested ? "  (suggested)" : ""}\n`);
    });
    const fallback =
      suggested === null ? "" : String(TARGETS.findIndex((t) => t.name === suggested) + 1);
    for (let attempt = 0; attempt < 5 && target === null; attempt++) {
      const answer =
        (await ask(`Deploy target${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
      target = parseTarget(answer);
      if (target === null) say("  Type a number from the list, or a target name.\n");
    }
    if (target === null) return { status: "error", error: "No deploy target chosen." };
  }

  let deploy: HollowConfigInput["deploy"];
  switch (target) {
    case "cloudflare-pages": {
      const fallback = pagesProjectName(files, detection.root);
      const name =
        ask !== undefined && !options.yes
          ? (await ask(`Cloudflare Pages project name [${fallback}]: `)).trim() || fallback
          : fallback;
      deploy = { target, projectName: name };
      break;
    }
    case "vps": {
      if (ask === undefined || options.yes) {
        return {
          status: "error",
          error:
            "A VPS target needs the server's hostname. Run `hollow init` in a terminal to answer, or write hollow.yml yourself.",
        };
      }
      let host = "";
      for (let attempt = 0; attempt < 5 && !/^[A-Za-z0-9.-]+$/.test(host); attempt++) {
        host = (await ask("Server hostname or IP: ")).trim();
      }
      if (!/^[A-Za-z0-9.-]+$/.test(host))
        return { status: "error", error: "No valid hostname given." };
      deploy = { target, host };
      break;
    }
    default:
      deploy = { target };
  }

  const config: HollowConfigInput = { version: 1, deploy };
  const branch = defaultBranch(files);
  if (branch !== "main") config.project = { defaultBranch: branch };
  return { status: "ok", config };
}

function parseTarget(answer: string): TargetName | null {
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= TARGETS.length) {
    return TARGETS[index - 1]?.name ?? null;
  }
  return TARGETS.find((t) => t.name === answer.toLowerCase())?.name ?? null;
}

export function suggestTarget(detection: Detection): TargetName | null {
  const hint = detection.deployHints[0]?.value;
  if (hint !== undefined) return hint;
  // Next.js and Nuxt are what Vercel is built around.
  if (detection.frameworks.some((f) => f.value === "next" || f.value === "nuxt")) return "vercel";
  return detection.container.dockerfile !== null ? "docker" : null;
}

function pagesProjectName(files: ProjectFiles, root: string): string {
  const text = files.readText("package.json");
  const manifest = text === null ? null : parseJson(text);
  const raw =
    isRecord(manifest) && typeof manifest.name === "string" ? manifest.name : path.basename(root);
  const name = raw
    .replace(/^@[^/]+\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(name) ? name : `app-${name}`.replace(/-+$/, "");
}

/** The remote's default branch from a local clone, without running git. */
export function defaultBranch(files: ProjectFiles): string {
  const head = files.readText(".git/refs/remotes/origin/HEAD");
  const match =
    head === null ? null : /^ref: refs\/remotes\/origin\/([A-Za-z0-9._/-]+)\s*$/.exec(head);
  const branch = match?.[1];
  return branch === undefined || branch.split("/").includes("..") ? "main" : branch;
}
