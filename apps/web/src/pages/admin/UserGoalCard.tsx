import type { Stats } from "./api";
import { Card, fmtDateTime, fmtInt } from "./ui";
import { goalProgressLabel, requiredRateLabel, userGoal, USER_GOAL } from "./user-goal";

export function UserGoalCard({ stats }: { stats: Stats }) {
  const goal = userGoal(stats.users_total, stats.generated_at);
  const available = goal.status !== "unavailable";
  const open = goal.status === "open";
  return (
    <Card className="overflow-hidden border-brand-ink/20 !p-0">
      <div className="grid min-w-0 lg:grid-cols-[1.25fr_1fr]">
        <div className="min-w-0 p-5 sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-sub">
            Our 2026 goal · by December 31
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-brand-ink sm:text-4xl">
            100,000 total users
          </h2>
          <p className="mt-2 text-sm leading-6 text-brand-sub">
            A clear destination. Make the next milestone our focus.
          </p>
          {available ? (
            <>
              <div className="mt-6 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-sm text-brand-sub">
                  <strong className="mr-1.5 text-2xl font-semibold tabular-nums text-brand-ink">
                    {fmtInt(goal.total)}
                  </strong>
                  users so far
                </p>
                <p className="text-xs font-medium tabular-nums text-brand-sub">
                  {goalProgressLabel(goal.progress)} of the goal
                </p>
              </div>
              <div
                role="progressbar"
                aria-label="Progress toward 100,000 total users"
                aria-valuemin={0}
                aria-valuemax={USER_GOAL}
                aria-valuenow={Math.min(goal.total, USER_GOAL)}
                aria-valuetext={`${fmtInt(goal.total)} of 100,000 users`}
                className="mt-3 h-2 overflow-hidden rounded-full bg-brand-faint"
              >
                <div
                  className="h-full rounded-full bg-brand-primary"
                  style={{ width: `${goal.progress}%` }}
                />
              </div>
              <dl className="mt-5 grid min-w-0 grid-cols-2 gap-4">
                <div className="min-w-0">
                  <dt className="text-xs text-brand-muted">Users still needed</dt>
                  <dd className="mt-1 break-words text-xl font-semibold tabular-nums text-brand-ink">
                    {fmtInt(goal.remaining)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-brand-muted">Time left · Kabul</dt>
                  <dd className="mt-1 text-xl font-semibold tabular-nums text-brand-ink">
                    {goal.daysRemaining > 0 && goal.daysRemaining < 1
                      ? "Less than a day"
                      : `${fmtInt(Math.ceil(goal.daysRemaining))} days`}
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="mt-6 text-sm leading-6 text-brand-muted">
              Total-user progress is unavailable. Waiting for a valid user-count snapshot from the
              server.
            </p>
          )}
        </div>
        <div className="min-w-0 border-t border-brand-border bg-brand-ivory p-5 sm:p-6 lg:border-l lg:border-t-0">
          <p className="text-xs font-semibold text-brand-sub">
            {open
              ? "Required weekly growth from here"
              : goal.status === "reached"
                ? goal.daysRemaining > 0
                  ? "Target reached"
                  : "Current total meets target"
                : goal.status === "closed"
                  ? "2026 goal closed"
                  : "Required pace"}
          </p>
          <p className="mt-2 break-words text-4xl font-semibold tabular-nums tracking-tight text-brand-ink [overflow-wrap:anywhere] sm:text-5xl">
            {open && goal.weeklyRate !== null
              ? requiredRateLabel(goal.weeklyRate)
              : goal.status === "reached"
                ? "100,000+"
                : "—"}
          </p>
          <p className="mt-3 text-xs leading-5 text-brand-sub">
            {open
              ? goal.weeklyRate !== null
                ? "Compounded each week to reach 100,000 by year-end. This is the required pace, not our measured activity growth."
                : goal.total === 0
                  ? "A growth percentage needs a starting user. Use the net additions below until then."
                  : "Too little time remains to express a useful weekly percentage. The full remaining gap is due by year-end."
              : goal.status === "reached"
                ? goal.daysRemaining > 0
                  ? "The current total has reached the goal. Keep building for the people using Kaata."
                  : "The deadline has passed. This is the current total, not a verified year-end result."
                : goal.status === "closed"
                  ? "The December 31, 2026 deadline has passed. This snapshot shows the current total, not a year-end result."
                  : "The pace will appear with the total-user count. Missing data is never treated as zero."}
          </p>
          {open ? (
            <div className="mt-5 border-t border-brand-border pt-4">
              <p className="text-xs text-brand-muted">
                {goal.nextPeriodIsDeadline ? "Needed by December 31" : "Needed in the next 7 days"}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-brand-ink">
                {fmtInt(goal.nextPeriodTotal)} total users
              </p>
              <p className="mt-1 text-xs leading-5 text-brand-sub">
                +{fmtInt(goal.nextPeriodTotal - goal.total)} net new users
              </p>
              <p className="mt-3 text-xs leading-5 text-brand-muted">
                Across all remaining time: {fmtInt(goal.dailyAdditions)} net new users per day on
                average.
              </p>
            </div>
          ) : null}
        </div>
      </div>
      {available && goal.nextMilestone !== null && goal.status === "open" ? (
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-brand-border px-5 py-4 sm:px-6">
          <p className="text-sm font-medium text-brand-ink">
            Next milestone: {fmtInt(goal.nextMilestone)} users
          </p>
          <p className="text-xs tabular-nums text-brand-sub">
            {fmtInt(goal.nextMilestone - goal.total)} to go
          </p>
        </div>
      ) : null}
      <div className="border-t border-brand-faint px-5 py-3 text-xs leading-5 text-brand-muted sm:px-6">
        <p>
          Signed-in accounts + Ninja users · operator and test records excluded.
          {available ? ` Snapshot: ${fmtDateTime(goal.asOf)} Kabul.` : ""}
        </p>
        <details className="mt-1">
          <summary className="w-fit cursor-pointer rounded-sm font-medium text-brand-sub outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2">
            How we count and plan
          </summary>
          <p className="mt-2 max-w-3xl">
            The count matches the Users page: one record per signed-in account, plus one per
            unlinked Ninja installation, including users without profile details. Ninja reinstalls
            can count separately, so this is a tracked-user total rather than a verified count of
            unique people. The deadline is the end of December 31, 2026 in Kabul. Required growth
            compounds over the exact time remaining in this snapshot; it recalculates as the total
            changes. The daily average is a separate, even pace. Weekly activity below measures
            active installations.
          </p>
        </details>
      </div>
    </Card>
  );
}
