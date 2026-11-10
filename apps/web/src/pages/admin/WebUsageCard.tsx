import { BarChart, LineChart } from "@tremor/react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button";
import type { Stats } from "./api";
import { reportingDay } from "./dates";
import { C, Card, ErrorCard, fmtDateTime, fmtInt } from "./ui";
import { type WebUsage, useWebUsage } from "./web-usage";

type WebCounts = Pick<Stats, "web_accounts_total" | "web_active_7d">;

const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function Count({
  label,
  value,
  detail,
}: {
  label: string;
  value?: number | null;
  detail?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium leading-5 text-brand-sub">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-brand-ink">{fmtInt(value)}</dd>
      {detail && <dd className="mt-1 text-xs leading-5 text-brand-muted">{detail}</dd>}
    </div>
  );
}

export function WebUsageSection({ stats }: { stats?: WebCounts }) {
  const usage = useWebUsage();
  return (
    <WebAccounts
      stats={stats ?? {}}
      usage={usage.data}
      status={
        usage.isError ? (
          <ErrorCard
            message="Detailed web usage couldn’t be refreshed."
            onRetry={() => void usage.refetch()}
          />
        ) : usage.isPending ? (
          <p role="status" className="text-sm text-brand-sub">
            Loading detailed web usage…
          </p>
        ) : usage.data === null ? (
          <p className="text-sm text-brand-sub">Detailed web usage is currently unavailable.</p>
        ) : null
      }
    />
  );
}

export function WebAccounts({
  stats,
  usage,
  status,
}: {
  stats: WebCounts;
  usage?: WebUsage | null;
  status?: ReactNode;
}) {
  const trackingStarted =
    !!usage && Date.parse(usage.tracking_started_at) <= Date.parse(usage.generated_at);
  const returningAccounts = trackingStarted ? usage?.returning_accounts_7d : null;
  return (
    <Card
      title="Kaata Web usage"
      sub="Signed-in accounts, counted once across browsers, including people who also use the mobile app."
      action={
        trackingStarted ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" className="min-h-11">
              <a href="#users?view=web-today">View today’s web users</a>
            </Button>
            <Button asChild variant="ghost" className="min-h-11">
              <a href="#users?view=web-recent">View recent web users</a>
            </Button>
          </div>
        ) : null
      }
    >
      <dl className="grid min-w-0 grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        {usage ? (
          <Count
            label="Recently on web"
            value={trackingStarted ? usage.recent_accounts : undefined}
            detail="Visible browser check-in in the last 5 minutes"
          />
        ) : null}
        <Count
          label="Active on web · 7 days"
          value={stats.web_active_7d}
          detail="Browser check-ins and sign-ins"
        />
        {usage ? (
          <Count
            label="Returning web users · 7 days"
            value={returningAccounts}
            detail={
              returningAccounts == null
                ? "Returning-user data is currently unavailable."
                : usage.returning_7d_partial
                  ? `Partial coverage · tracked since ${fmtDateTime(usage.tracking_started_at)} Kabul time`
                  : "Checked in on a later Kabul day than their first web sign-in"
            }
          />
        ) : null}
        {usage ? (
          <Count
            label="First web sign-ins · 7 days"
            value={usage.first_sign_ins_7d}
            detail={`Previous 7 days · ${fmtInt(usage.first_sign_ins_previous_7d)}`}
          />
        ) : null}
        <Count label="Web accounts" value={stats.web_accounts_total} detail="All time" />
      </dl>
      {trackingStarted && usage ? (
        <p className="mt-3 text-xs text-brand-muted">
          Web activity updated {fmtDateTime(usage.generated_at)} Kabul time.
        </p>
      ) : null}
      {usage?.days.length ? <WebUsageHistory usage={usage} /> : null}
      {status ? <div className="mt-4 border-t border-brand-border pt-4">{status}</div> : null}
    </Card>
  );
}

function WebUsageHistory({ usage }: { usage: WebUsage }) {
  const hasReturningHistory = usage.days.some((day) => day.returning_accounts !== undefined);
  const firstSignIns = usage.days.map((day) => ({
    date: dayLabel.format(new Date(day.day)),
    "First web sign-ins": day.first_sign_ins,
  }));
  const browserActivity = usage.days
    .filter((day) => day.active_accounts !== null)
    .map((day) => ({
      date: `${dayLabel.format(new Date(day.day))}${day.is_partial ? " *" : ""}`,
      "Active web accounts": day.active_accounts,
      "Returning web users": day.returning_accounts ?? null,
    }));
  const todayDate = reportingDay(usage.generated_at);
  const today = usage.days.find((day) => day.day === todayDate);
  const hasBrowserActivity = browserActivity.some((day) => (day["Active web accounts"] ?? 0) > 0);

  return (
    <div className="mt-5 min-w-0 border-t border-brand-border pt-4">
      <h3 className="text-sm font-semibold text-brand-ink">Daily web usage · 30 days</h3>
      <p className="mt-1 text-xs leading-5 text-brand-sub">
        Dates use Kabul time. The latest 7 days include today so far.
      </p>
      <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
        <section className="min-w-0 rounded-lg border border-brand-border p-3 sm:p-4">
          <h4 className="text-sm font-semibold text-brand-ink">Browser activity</h4>
          <p className="mt-1 text-xs leading-5 text-brand-sub">
            Active accounts checked in from a visible browser.
            {hasReturningHistory
              ? " Returning users checked in on a later Kabul day than their first web sign-in. Each account counts once in the seven-day total."
              : ""}
          </p>
          {today?.active_accounts != null ? (
            <div className="mt-3 rounded-md bg-brand-faint px-3 py-2">
              <p className="text-xs font-medium text-brand-ink">Today so far</p>
              <dl className="mt-1 grid grid-cols-2 gap-3">
                <Count label="Active web accounts" value={today.active_accounts} />
                {hasReturningHistory ? (
                  <Count label="Returning web users" value={today.returning_accounts} />
                ) : null}
              </dl>
            </div>
          ) : null}
          {hasBrowserActivity ? (
            <BarChart
              role="region"
              aria-label="Browser activity by tracked Kabul date"
              className="mt-3 h-40 min-w-0 max-w-full sm:h-48"
              data={browserActivity}
              index="date"
              categories={
                hasReturningHistory
                  ? ["Active web accounts", "Returning web users"]
                  : ["Active web accounts"]
              }
              colors={hasReturningHistory ? [C.blue, C.teal] : [C.blue]}
              allowDecimals={false}
              valueFormatter={fmtInt}
              yAxisWidth={32}
              showAnimation={false}
              tickGap={20}
            />
          ) : browserActivity.length ? (
            <p className="mt-3 text-xs text-brand-sub">
              No browser check-ins recorded on tracked days yet.
            </p>
          ) : null}
          <p className="mt-2 text-xs leading-5 text-brand-muted">
            {usage.tracking_started_at
              ? `Daily activity tracking began ${fmtDateTime(usage.tracking_started_at)} Kabul time. Earlier activity is unavailable. * marks a partial day of activity tracking.`
              : "Daily browser activity is unavailable for this period."}
          </p>
        </section>
        <section className="min-w-0 rounded-lg border border-brand-border p-3 sm:p-4">
          <h4 className="text-sm font-semibold text-brand-ink">First web sign-ins</h4>
          <p className="mt-1 text-xs leading-5 text-brand-sub">
            Includes existing Kaata users trying the web for the first time.
          </p>
          <LineChart
            role="region"
            aria-label="First web sign-ins by Kabul date"
            className="mt-3 h-48 min-w-0 max-w-full sm:h-56"
            data={firstSignIns}
            index="date"
            categories={["First web sign-ins"]}
            colors={[C.green]}
            curveType="linear"
            allowDecimals={false}
            valueFormatter={fmtInt}
            yAxisWidth={32}
            showAnimation={false}
            showLegend={false}
            tickGap={20}
          />
        </section>
      </div>
      <details className="mt-3 border-t border-brand-border pt-2">
        <summary className="cursor-pointer py-2 text-xs font-medium text-brand-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary">
          View daily counts
        </summary>
        <table className="w-full text-left text-xs leading-5 tabular-nums">
          <caption className="sr-only">
            Kaata Web account activity and first sign-ins by Kabul date
          </caption>
          <thead className="border-b border-brand-border text-brand-sub">
            <tr>
              <th scope="col" className="py-2 pr-2 font-medium">
                Kabul date
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Active web accounts
              </th>
              {hasReturningHistory ? (
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Returning web users
                </th>
              ) : null}
              <th scope="col" className="py-2 pl-2 text-right font-medium">
                First web sign-ins
              </th>
            </tr>
          </thead>
          <tbody className="text-brand-ink">
            {usage.days
              .slice()
              .reverse()
              .map((day) => (
                <tr key={day.day} className="border-b border-brand-border last:border-0">
                  <th scope="row" className="py-2 pr-2 font-normal">
                    {fmtDateTime(day.day)}
                  </th>
                  <td className="px-2 py-2 text-right">
                    {fmtInt(day.active_accounts)}
                    {day.is_partial ? <span className="ml-1 text-brand-muted">partial</span> : null}
                  </td>
                  {hasReturningHistory ? (
                    <td className="px-2 py-2 text-right">{fmtInt(day.returning_accounts)}</td>
                  ) : null}
                  <td className="py-2 pl-2 text-right">{fmtInt(day.first_sign_ins)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
