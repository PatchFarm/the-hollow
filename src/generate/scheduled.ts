import type { OperationsPlan, PipelinePlan } from "../pipeline/plan.js";
import { dependenciesJob, lines } from "./ci.js";
import type { Job, Step } from "./release.js";
import { expr, renderGenerated } from "./render.js";

export const SCHEDULED_WORKFLOW = ".github/workflows/scheduled.yml";
export const INCIDENT_LABEL = "hollow-incident";

/** True when scheduled.yml has anything to do. */
export function hasSchedule(plan: PipelinePlan): boolean {
  return plan.operations.synthetic !== null || plan.operations.nightlyScan !== null;
}

/**
 * One incident per problem: open an issue (labelled hollow-incident) when it starts failing,
 * comment while it keeps failing, close it when it passes again. Slack or Discord hear about the
 * start and the recovery only, not every repeat. Values arrive through env, never `${{ }}`.
 */
export function incidentStep(
  operations: OperationsPlan,
  options: {
    name: string;
    title: string;
    failing: string;
    detail: string;
    extra?: Record<string, string>;
  },
): Step {
  return {
    name: options.name,
    if: expr("always()"),
    env: {
      GH_TOKEN: expr("github.token"),
      TITLE: options.title,
      FAILING: expr(options.failing),
      DETAIL: options.detail,
      ISSUES: String(operations.issues),
      SLACK_WEBHOOK:
        operations.slackSecret === null ? "" : expr(`secrets.${operations.slackSecret}`),
      DISCORD_WEBHOOK:
        operations.discordSecret === null ? "" : expr(`secrets.${operations.discordSecret}`),
      ...options.extra,
    },
    run: lines([
      'run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"',
      "now=\"$(date -u '+%Y-%m-%d %H:%M UTC')\"",
      "notify() {",
      '  if [ -n "$SLACK_WEBHOOK" ]; then',
      "    jq --null-input --arg text \"$1\" '{text: $text}' | curl --fail --silent --show-error --request POST --header 'content-type: application/json' --data @- \"$SLACK_WEBHOOK\" > /dev/null || echo '::warning title=Alert::The Slack webhook did not accept the message.'",
      "  fi",
      '  if [ -n "$DISCORD_WEBHOOK" ]; then',
      "    jq --null-input --arg text \"$1\" '{content: $text}' | curl --fail --silent --show-error --request POST --header 'content-type: application/json' --data @- \"$DISCORD_WEBHOOK\" > /dev/null || echo '::warning title=Alert::The Discord webhook did not accept the message.'",
      "  fi",
      "}",
      'number=""',
      'if [ "$ISSUES" = "true" ]; then',
      `  gh label create ${INCIDENT_LABEL} --repo "$GITHUB_REPOSITORY" --color B60205 --description "Opened by The Hollow when a check or deploy fails" --force > /dev/null 2>&1 || true`,
      `  number="$(gh issue list --repo "$GITHUB_REPOSITORY" --label ${INCIDENT_LABEL} --state open --limit 100 --json number,title --jq '.[] | select(.title == env.TITLE) | .number' | head -n 1)"`,
      "fi",
      'if [ "$FAILING" = "true" ]; then',
      '  if [ -n "$number" ]; then',
      '    gh issue comment "$number" --repo "$GITHUB_REPOSITORY" --body "Still failing at $now: $run_url" > /dev/null',
      "    exit 0",
      "  fi",
      '  if [ "$ISSUES" = "true" ]; then',
      '    printf \'%s\\n\\nFirst failed at %s: %s\\n\\nThe Hollow closes this issue when it passes again.\\n\' "$DETAIL" "$now" "$run_url" |',
      `      gh issue create --repo "$GITHUB_REPOSITORY" --title "$TITLE" --label ${INCIDENT_LABEL} --body-file - > /dev/null`,
      "  fi",
      '  notify "$TITLE. $run_url"',
      'elif [ -n "$number" ]; then',
      '  gh issue comment "$number" --repo "$GITHUB_REPOSITORY" --body "Passing again at $now: $run_url" > /dev/null',
      '  gh issue close "$number" --repo "$GITHUB_REPOSITORY" > /dev/null',
      '  notify "Recovered: $TITLE. $run_url"',
      "fi",
    ]),
  };
}

/** Like the deploy check, but quicker to give up: three tries, ten seconds apart. */
function syntheticCheck(environment: string, url: string): Step {
  return {
    name: `Check ${environment} (${url})`,
    id: `check-${environment}`,
    "continue-on-error": true,
    env: { URL: url },
    run: lines([
      "for attempt in 1 2 3; do",
      '  code="$(curl --silent --location --max-time 10 --output /dev/null --write-out \'%{http_code}\' "$URL" || true)"',
      '  if [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; then',
      '    echo "$URL answered $code."',
      "    exit 0",
      "  fi",
      '  if [ "$attempt" -lt 3 ]; then sleep 10; fi',
      "done",
      'echo "::error title=Synthetic check::$URL did not answer without a server error (last status: $code)."',
      "exit 1",
    ]),
  };
}

/** A fresh object each time: a shared one would render as a YAML anchor and alias. */
const issuePermissions = () => ({ issues: "write" });

/**
 * `.github/workflows/scheduled.yml`: synthetic checks on each environment's URL, and a nightly
 * re-scan of the default branch's dependencies. Failures open one incident issue each, closed again
 * on recovery.
 */
export function renderScheduledWorkflow(plan: PipelinePlan): string {
  const ops = plan.operations;
  const schedule: { cron: string }[] = [];
  const jobs: Record<string, Job> = {};
  const comments: Record<string, string> = {};
  const dispatch = "github.event_name == 'workflow_dispatch'";

  if (ops.synthetic !== null) {
    const synthetic = ops.synthetic;
    schedule.push({ cron: synthetic.cron });
    const steps: Step[] = [];
    for (const target of synthetic.targets) {
      steps.push(syntheticCheck(target.environment, target.url));
      steps.push(
        incidentStep(ops, {
          name: `Report ${target.environment}`,
          title: `${target.environment} is not answering (${target.url})`,
          failing: `steps.check-${target.environment}.outcome == 'failure'`,
          detail: `The scheduled check of ${target.url} got no answer without a server error, three times in a row. Look at the app's logs on the target, or run the Release workflow again to redeploy.`,
        }),
      );
    }
    steps.push({
      name: "Fail the run if any check failed",
      env: {
        OUTCOMES: synthetic.targets
          .map((target) => expr(`steps.check-${target.environment}.outcome`))
          .join(" "),
      },
      run: lines([
        "for outcome in $OUTCOMES; do",
        '  if [ "$outcome" = "failure" ]; then exit 1; fi',
        "done",
      ]),
    });
    jobs.synthetic = {
      name: "Synthetic checks",
      if: expr(`github.event.schedule == '${synthetic.cron}' || ${dispatch}`),
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      permissions: issuePermissions(),
      steps,
    };
    comments["jobs.synthetic"] =
      `Every ${synthetic.every}, at best: GitHub delays scheduled runs when it is busy.`;
  }

  if (ops.nightlyScan !== null) {
    schedule.push({ cron: ops.nightlyScan });
    const { name: _name, ...scan } = dependenciesJob(plan);
    jobs.dependencies = {
      name: "Nightly dependency scan",
      if: expr(`github.event.schedule == '${ops.nightlyScan}' || ${dispatch}`),
      ...scan,
    };
    jobs["dependencies-report"] = {
      name: "Report the dependency scan",
      needs: ["dependencies"],
      if: expr("always() && needs.dependencies.result != 'skipped'"),
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      permissions: issuePermissions(),
      steps: [
        incidentStep(ops, {
          name: "Open, update or close the incident",
          title: "Nightly dependency scan found vulnerabilities",
          failing: "needs.dependencies.result == 'failure'",
          detail: `The nightly OSV-Scanner run found dependencies with known vulnerabilities at ${plan.security.failOn} or worse. The run's annotations list them; upgrade them, or raise security.failOn in hollow.yml.`,
        }),
      ],
    };
    comments["jobs.dependencies"] =
      "New vulnerabilities are published every day, so the default branch is re-scanned every night.";
  }

  return renderGenerated(
    {
      name: "Scheduled",
      on: { schedule, workflow_dispatch: {} },
      permissions: {},
      concurrency: { group: "scheduled", "cancel-in-progress": false },
      jobs,
    },
    {
      about: [
        "Scheduled checks. Each failure opens one incident issue (label hollow-incident), closed again when it passes.",
      ],
      comments,
    },
  );
}
