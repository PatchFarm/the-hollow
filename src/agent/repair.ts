import { parse } from "yaml";
import { CONFIG_FILE } from "../config/load.js";
import { hollowConfigSchema } from "../config/schema.js";
import type { GitHubApi } from "../github/api.js";
import type { PipelinePlan } from "../pipeline/plan.js";
import { ProjectFiles } from "../util/project-files.js";
import { writeProjectFile } from "../util/project-writer.js";
import { checkEditablePath } from "./allowlist.js";
import type { Budget } from "./budget.js";
import { estimateTokens, type ModelClient, ModelError } from "./model.js";
import { buildPrompt, editableFiles, type PastAttempt, parseReply, safeText } from "./prompt.js";
import type { FailedJob } from "./runs.js";

/** The most a model may answer in one call. Whole hollow.yml or Dockerfile files fit easily. */
export const MAX_OUTPUT_TOKENS = 8000;

export interface RepairDeps {
  api: GitHubApi;
  repo: string;
  root: string;
  client: ModelClient;
  budget: Budget;
  maxAttempts: number;
  secretValues: string[];
  /** The plan as hollow.yml says now. */
  loadPlan: () => PipelinePlan | null;
  /** Regenerate The Hollow's files from hollow.yml (policy-checked). Returns an error or null. */
  regenerate: () => string | null;
  /** Commit the changed pipeline files and push them, returning the new commit, or null if nothing changed. */
  commit: (plan: PipelinePlan, extra: string[], message: string) => Promise<string | null>;
  /** Watch the checks on the branch's latest commit and explain what failed. */
  check: () => Promise<{ failures: FailedJob[] } | { stopped: string }>;
  /** Re-run failed jobs in place, for passing problems. */
  rerun: (failures: FailedJob[]) => Promise<void>;
  say: (text: string) => void;
}

export interface Attempt extends PastAttempt {
  number: number;
}

export interface RepairResult {
  passed: boolean;
  /** Why it stopped, when it did not pass. */
  reason: string;
  attempts: Attempt[];
  remaining: FailedJob[];
  suggestions: string[];
  templateBugs: string[];
}

/** Failures the agent can act on: the pipeline's own, and ones nobody recognised. */
function repairable(failure: FailedJob): boolean {
  return failure.diagnosis === null || failure.diagnosis.owner === "pipeline";
}

/**
 * The repair loop. Each attempt asks the model for a change to hollow.yml or the target files,
 * checks it (allowlist, schema, regeneration under the workflow policy), commits and pushes it,
 * then watches the checks again. It stops when they pass, when nothing left is the pipeline's to
 * fix, or when the attempts or the spend cap run out.
 */
export async function repair(deps: RepairDeps, initial: FailedJob[]): Promise<RepairResult> {
  const attempts: Attempt[] = [];
  const suggestions: string[] = [];
  const templateBugs: string[] = [];
  let failures = initial;
  const done = (passed: boolean, reason: string): RepairResult => ({
    passed,
    reason,
    attempts,
    remaining: failures,
    suggestions: [...new Set(suggestions)],
    templateBugs: [...new Set(templateBugs)],
  });

  for (let number = 1; number <= deps.maxAttempts; number++) {
    const fixable = failures.filter(repairable);
    const passing = failures.filter((failure) => failure.diagnosis?.owner === "retry");
    if (fixable.length === 0 && passing.length === 0) {
      return done(
        false,
        "What is still failing needs you or the project's code, not a pipeline change.",
      );
    }
    if (fixable.length === 0) {
      deps.say(`\nAttempt ${number}: re-running the jobs that hit a passing problem.\n`);
      await deps.rerun(passing);
      attempts.push({ number, summary: "Re-ran the failed jobs", files: [], result: "re-run" });
    } else {
      const plan = deps.loadPlan();
      if (plan === null) return done(false, "hollow.yml no longer gives a valid pipeline.");
      const files = new ProjectFiles(deps.root);
      const prompt = buildPrompt({
        plan,
        files,
        failures: fixable,
        attempts,
        secretValues: deps.secretValues,
      });
      const estimate = estimateTokens(prompt.system + prompt.user);
      if (!deps.budget.canAfford(estimate, MAX_OUTPUT_TOKENS)) {
        return done(false, "The next call could go over the spend cap, so it was not made.");
      }
      deps.say(`\nAttempt ${number}: asking ${deps.client.label}...\n`);
      let text: string;
      try {
        const reply = await deps.client.complete({
          ...prompt,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
        deps.budget.record(reply.inputTokens, reply.outputTokens);
        text = reply.text;
      } catch (error) {
        if (error instanceof ModelError)
          return done(false, `The model call failed: ${error.message}`);
        throw error;
      }
      const reply = parseReply(text);
      if (reply === null) {
        deps.say("  The answer was not the JSON The Hollow asked for, so nothing was changed.\n");
        attempts.push({
          number,
          summary: "(unusable answer)",
          files: [],
          result: "the answer was not valid JSON in the required shape",
        });
        continue;
      }
      suggestions.push(...reply.suggestions.map((s) => safeText(s, 500, deps.secretValues)));
      if (reply.templateBug) templateBugs.push(safeText(reply.templateBug, 500, deps.secretValues));
      const summary = safeText(reply.summary || "pipeline change", 200, deps.secretValues);
      if (reply.giveUp || reply.edits.length === 0) {
        return done(
          false,
          `The model found nothing it may change that would fix this${reply.summary ? `: ${summary}` : "."}`,
        );
      }

      const problem = checkEdits(deps.root, files, reply.edits);
      if (problem !== null) {
        deps.say(`  Refused the change: ${problem}\n`);
        attempts.push({
          number,
          summary,
          files: reply.edits.map((e) => e.path),
          result: `refused: ${problem}`,
        });
        continue;
      }
      const before = new Map(reply.edits.map((edit) => [edit.path, files.readText(edit.path)]));
      for (const edit of reply.edits) writeProjectFile(deps.root, edit.path, edit.content);
      const regenerated = deps.regenerate();
      if (regenerated !== null) {
        for (const [path, content] of before) {
          if (content !== null) writeProjectFile(deps.root, path, content);
        }
        deps.regenerate();
        deps.say(`  The change did not regenerate cleanly, so it was undone: ${regenerated}\n`);
        attempts.push({
          number,
          summary,
          files: [...before.keys()],
          result: `undone: ${regenerated}`,
        });
        continue;
      }
      const after = deps.loadPlan();
      if (after === null) return done(false, "The change left hollow.yml invalid.");
      const sha = await deps.commit(
        after,
        [...before.keys()],
        `ci: ${safeText(reply.summary || "repair the pipeline", 60, deps.secretValues)}`,
      );
      if (sha === null) {
        return done(false, "The model's change was the same as what was already there.");
      }
      deps.say(`  ${summary}\n  Pushed ${sha.slice(0, 7)}.\n`);
      attempts.push({ number, summary, files: [...before.keys()], result: "pushed" });
    }

    const checked = await deps.check();
    if ("stopped" in checked) return done(false, checked.stopped);
    failures = checked.failures;
    const last = attempts[attempts.length - 1] as Attempt;
    if (failures.length === 0) {
      last.result = "the checks passed";
      return done(true, "");
    }
    last.result = `still failing: ${failures
      .map((f) => `${f.run.name} / ${f.job}${f.diagnosis ? ` (${f.diagnosis.cause})` : ""}`)
      .join("; ")}`;
  }
  return done(false, `It used all ${deps.maxAttempts} repair attempts.`);
}

/** Every edit must be allowed, a file the agent may change, and hollow.yml must stay valid. */
function checkEdits(
  root: string,
  files: ProjectFiles,
  edits: { path: string; content: string }[],
): string | null {
  const editable = new Set(editableFiles(files));
  for (const edit of edits) {
    const allowed = checkEditablePath(root, edit.path);
    if (!allowed.ok) return allowed.reason;
    if (!editable.has(allowed.path)) {
      return `${allowed.path} is not one of the files it may change (${[...editable].join(", ")}). The workflows are regenerated from hollow.yml.`;
    }
    if (allowed.path === CONFIG_FILE) {
      let data: unknown;
      try {
        data = parse(edit.content);
      } catch (error) {
        return `hollow.yml is not valid YAML: ${(error as Error).message.split("\n")[0]}`;
      }
      const result = hollowConfigSchema.safeParse(data);
      if (!result.success) {
        return `hollow.yml does not match the schema: ${result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`;
      }
    }
  }
  return null;
}
