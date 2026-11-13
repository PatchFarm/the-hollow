import { parseDocument } from "yaml";
import type { z } from "zod";
import { ProjectFiles } from "../util/project-files.js";
import { type HollowConfig, hollowConfigSchema } from "./schema.js";

export const CONFIG_FILE = "hollow.yml";

export type LoadResult =
  | { status: "missing" }
  | { status: "invalid"; errors: string[] }
  | { status: "ok"; config: HollowConfig };

/** Parse and validate hollow.yml text. Never throws on bad input. */
export function parseConfig(text: string): LoadResult {
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return { status: "invalid", errors: doc.errors.map((error) => `YAML: ${error.message}`) };
  }
  const data: unknown = doc.toJS({ maxAliasCount: 50 });
  if (data === null || data === undefined) {
    return { status: "invalid", errors: [`${CONFIG_FILE} is empty.`] };
  }
  const parsed = hollowConfigSchema.safeParse(data);
  if (!parsed.success) {
    return { status: "invalid", errors: formatIssues(parsed.error.issues) };
  }
  return { status: "ok", config: parsed.data };
}

/** Load `hollow.yml` from a project root. */
export function loadConfig(root: string): LoadResult {
  const files = new ProjectFiles(root);
  if (!files.exists(CONFIG_FILE)) return { status: "missing" };
  const text = files.readText(CONFIG_FILE);
  if (text === null) {
    return {
      status: "invalid",
      errors: [`${CONFIG_FILE} could not be read (too large or not a file).`],
    };
  }
  return parseConfig(text);
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const where = issue.path.length === 0 ? "(top level)" : issue.path.map(String).join(".");
    return `${where}: ${issue.message}`;
  });
}
