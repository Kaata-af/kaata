import { LineChart } from "@tremor/react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button";
import type { Stats } from "./api";
import { C, Card, ErrorCard, fmtDateTime, fmtInt } from "./ui";
import { type WebUsage, useWebUsage } from "./web-usage";

type WebCounts = Pick<Stats, "web_accounts_total" | "web_active_7d">;

const dayLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function Count({ label, value, detail }: { label: string; value?: number | null; detail?: string }) {
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
          <Button asChild variant="outline" className="min-h-11">
            <a href="#users?view=web-recent">View recent web users</a>
          </Button>
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
  const data = usage.days.map((day) => ({
    date: `${dayLabel.format(new Date(day.day))}${day.is_partial ? " *" : ""}`,
    "Active web accounts": day.active_accounts,
    "Returning web users": day.returning_accounts ?? null,
    "First web sign-ins": day.first_sign_ins,
  }));
  return (
    <div className="mt-5 min-w-0 border-t border-brand-border pt-4">
      <h3 className="text-sm font-semibold text-brand-ink">Daily web usage · 30 days</h3>
      <p className="mt-1 text-xs leading-5 text-brand-sub">
        Active accounts checked in from a visible browser. First web sign-ins include existing Kaata
        users trying the web for the first time. Dates use Kabul time and the latest 7 days include
        today so far.
      </p>
      {hasReturningHistory ? (
        <p className="mt-1 text-xs leading-5 text-brand-sub">
          Returning users had a visible browser check-in on a later Kabul day than their first web
          sign-in. Each account counts once in the seven-day total.
        </p>
      ) : null}
      <LineChart
        className="mt-3 h-48 min-w-0 max-w-full sm:h-56"
        data={data}
        index="date"
        categories={
          hasReturningHistory
            ? ["Active web accounts", "Returning web users", "First web sign-ins"]
            : ["Active web accounts", "First web sign-ins"]
        }
        colors={hasReturningHistory ? [C.blue, C.teal, C.green] : [C.blue, C.green]}
        curveType="linear"
        connectNulls={false}
        allowDecimals={false}
        valueFormatter={fmtInt}
        yAxisWidth={40}
        showAnimation={false}
        tickGap={28}
      />
      <p className="mt-2 text-xs leading-5 text-brand-muted">
        {usage.tracking_started_at
          ? `Daily activity tracking began ${fmtDateTime(usage.tracking_started_at)} Kabul time. Earlier activity is unavailable. * marks a partial day of activity tracking.`
          : "Daily browser activity is unavailable for this period."}
      </p>
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
