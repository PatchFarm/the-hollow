import { Document } from "yaml";
import type { HollowConfigInput } from "../config/schema.js";

export const SCHEMA_URL =
  "https://raw.githubusercontent.com/PatchFarm/the-hollow/main/schema/hollow.schema.json";

/**
 * The hollow.yml that `hollow init` writes: only what differs from the defaults, so the file stays
 * short and every line in it is a decision someone made. This file belongs to the developer, so it
 * carries no "generated" marker and `upgrade` never rewrites it.
 */
export function renderHollowYml(config: HollowConfigInput): string {
  const doc = new Document(config);
  return [
    `# yaml-language-server: $schema=${SCHEMA_URL}`,
    "# The Hollow pipeline config. Change it, then run `npx the-hollow upgrade` to regenerate",
    "# the workflows. Anything not set here uses a safe default; the schema above lists them all.",
    doc.toString({ lineWidth: 0 }),
  ].join("\n");
}
