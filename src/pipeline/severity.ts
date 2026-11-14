import type { HollowConfig } from "../config/schema.js";

export type Severity = HollowConfig["security"]["failOn"];

export const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;

/** CVSS base score where each severity starts. */
export const CVSS_FLOOR = { low: "0.1", medium: "4.0", high: "7.0", critical: "9.0" } as const;

export interface DependencyFinding {
  ecosystem: string;
  /** `name@version`. */
  pkg: string;
  ids: string[];
  /** CVSS score as reported, or null when the advisory has none. */
  cvss: number | null;
  blocking: boolean;
}

/**
 * Turn an OSV-Scanner JSON report into findings, marking which ones fail the build at `failOn`.
 * Same rule as the generated CI step: advisories without a score only block at `low`.
 */
export function osvFindings(report: unknown, failOn: Severity): DependencyFinding[] {
  const min = Number(CVSS_FLOOR[failOn]);
  const findings: DependencyFinding[] = [];
  for (const result of array(field(report, "results"))) {
    for (const entry of array(field(result, "packages"))) {
      const pkg = field(entry, "package");
      const name = `${String(field(pkg, "name") ?? "?")}@${String(field(pkg, "version") ?? "?")}`;
      for (const group of array(field(entry, "groups"))) {
        const raw = field(group, "max_severity");
        const score = typeof raw === "string" && raw !== "" ? Number(raw) : Number.NaN;
        const cvss = Number.isFinite(score) ? score : null;
        findings.push({
          ecosystem: String(field(pkg, "ecosystem") ?? "?"),
          pkg: name,
          ids: array(field(group, "ids")).map(String),
          cvss,
          blocking: cvss === null ? failOn === "low" : cvss >= min,
        });
      }
    }
  }
  return findings;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
