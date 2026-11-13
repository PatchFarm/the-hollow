import type { LoadResult } from "../config/load.js";
import type { Detection, Finding } from "../detect/index.js";

/** Human-readable report for `hollow plan`. Plain text, no colors, so it reads well in CI logs. */
export function formatPlan(detection: Detection, config: LoadResult): string {
  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`  ${label.padEnd(16)} ${value}`);
  const one = <T>(finding: Finding<T> | null) =>
    finding === null ? "not found" : `${String(finding.value)}  (${finding.source})`;
  const many = <T>(findings: Finding<T>[]) =>
    findings.length === 0
      ? "none found"
      : findings.map((finding) => `${String(finding.value)} (${finding.source})`).join(", ");

  lines.push(`Project: ${detection.root}`, "");
  lines.push("Detected");
  row("Language", detection.language === null ? "unknown" : languageLabel(detection));
  row("Package manager", one(detection.packageManager));
  row("Runtime", one(detection.runtimeVersion));
  row("Frameworks", many(detection.frameworks));
  row("Linters", many(detection.quality.linters));
  row("Formatters", many(detection.quality.formatters));
  row("Type checking", many(detection.quality.typeCheckers));
  row("Tests", many(detection.tests.runners));
  row("End-to-end", many(detection.tests.e2e));
  row("Migrations", one(detection.database.migrationTool));
  row("Databases", many(detection.database.engines));
  row(
    "Containers",
    [detection.container.dockerfile, detection.container.compose]
      .filter((file) => file !== null)
      .join(", ") || "none found",
  );
  row("Deploy hints", many(detection.deployHints));

  lines.push("", "hollow.yml");
  switch (config.status) {
    case "missing":
      lines.push("  Not found. `hollow init` will create one (coming in M1).");
      break;
    case "invalid":
      lines.push("  Invalid:");
      for (const error of config.errors) lines.push(`    - ${error}`);
      break;
    case "ok":
      lines.push(`  Valid. Deploy target: ${config.config.deploy.target}.`);
      break;
  }

  if (detection.warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of detection.warnings) lines.push(`  - ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

function languageLabel(detection: Detection): string {
  if (detection.language === "node") return detection.typescript ? "Node (TypeScript)" : "Node";
  return "Python";
}
