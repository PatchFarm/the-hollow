import { detectProject } from "../detect/index.js";
import { type Area, type Finding, githubChecks, localChecks } from "../doctor/checks.js";
import { GitHubError } from "../github/api.js";
import { ProjectFiles } from "../util/project-files.js";
import { type Connect, protectInput } from "./protect-command.js";

export interface DoctorOptions {
  dir: string;
  repo?: string | undefined;
  json: boolean;
  /** Skip everything that needs GitHub. */
  offline: boolean;
  connect: Connect;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const AREAS: Record<Area, string> = {
  workflows: "Workflows",
  config: "hollow.yml",
  generated: "The Hollow's files",
  github: "GitHub",
};

const MARK = { error: "error", warning: "warn ", info: "info " } as const;

/**
 * `hollow doctor`: audit the repo's pipeline, read-only. Every workflow is held to The Hollow's
 * policy, whoever wrote it; The Hollow's own files are compared with what hollow.yml generates; and
 * through gh it reads branch rules, secrets and recent runs. It fixes nothing: each finding names
 * the command that does. Exits non-zero when there are errors, so it can gate CI.
 */
export async function doctor(options: DoctorOptions): Promise<number> {
  let detection: ReturnType<typeof detectProject>;
  try {
    detection = detectProject(options.dir);
  } catch (error) {
    options.stderr(`${(error as Error).message}\n`);
    return 1;
  }
  const local = localChecks(detection, new ProjectFiles(detection.root));
  const findings: Finding[] = [...local.findings];

  if (options.offline) {
    findings.push({
      severity: "info",
      area: "github",
      message: "GitHub was not checked (--offline).",
    });
  } else {
    try {
      const { api, repo } = await options.connect(detection.root, options.repo);
      const protect =
        local.plan !== null && local.config !== null
          ? protectInput(local.plan, local.config, repo)
          : null;
      findings.push(...(await githubChecks(api, repo, local.plan, protect)));
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      findings.push({
        severity: "info",
        area: "github",
        message: `GitHub was not checked: ${error.message}`,
      });
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  if (options.json) {
    options.stdout(`${JSON.stringify({ errors, warnings, findings }, null, 2)}\n`);
    return errors > 0 ? 1 : 0;
  }

  const order: Area[] = ["workflows", "config", "generated", "github"];
  const rank = { error: 0, warning: 1, info: 2 };
  const out: string[] = [];
  for (const area of order) {
    const group = findings
      .filter((f) => f.area === area)
      .sort((a, b) => rank[a.severity] - rank[b.severity]);
    if (group.length === 0) continue;
    out.push(AREAS[area]);
    for (const finding of group) {
      out.push(`  ${MARK[finding.severity]}  ${finding.message}`);
      if (finding.fix) out.push(`         ${finding.fix}`);
    }
    out.push("");
  }
  out.push(
    errors === 0 && warnings === 0
      ? "No problems found."
      : `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`,
  );
  options.stdout(`${out.join("\n")}\n`);
  return errors > 0 ? 1 : 0;
}
