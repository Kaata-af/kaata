import type { DeviceEstimate } from "./api";
import { Card, fmtInt, fmtPct } from "./ui";

export function DeviceEstimateCard({
  estimate,
  installations,
}: {
  estimate?: DeviceEstimate;
  installations: number;
}) {
  const total = estimate?.total_installs ?? installations;
  const collecting = estimate !== undefined && estimate.identified_installs === 0;
  const coverage = estimate && total > 0 ? (estimate.identified_installs / total) * 100 : 0;

  return (
    <Card
      title="Installations & devices"
      sub="A separate device estimate, with installation history preserved."
    >
      <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 sm:gap-6">
        <div className="min-w-0">
          <dt className="text-xs font-medium text-brand-sub">Installations</dt>
          <dd className="mt-1.5 break-words text-2xl font-semibold tabular-nums tracking-tight text-brand-ink sm:text-3xl">
            {fmtInt(total)}
          </dd>
          <p className="mt-1.5 text-xs leading-5 text-brand-muted">
            All reported app installations
          </p>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium text-brand-sub">Device estimate</dt>
          <dd className="mt-1.5 break-words text-2xl font-semibold tabular-nums tracking-tight text-brand-ink sm:text-3xl">
            {estimate && !collecting ? fmtInt(estimate.estimated_devices) : "—"}
          </dd>
          <p className="mt-1.5 text-xs leading-5 text-brand-muted">
            {!estimate
              ? "Available after the server update"
              : collecting
                ? "Collecting · waiting for updated apps"
                : `${fmtInt(estimate.identified_devices)} recognized by device identifier`}
          </p>
        </div>
        <div className="col-span-2 min-w-0 border-t border-brand-faint pt-4 sm:col-span-1 sm:border-0 sm:pt-0">
          <dt className="text-xs font-medium text-brand-sub">Identifier coverage</dt>
          <dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-brand-ink sm:text-3xl">
            {estimate ? fmtPct(estimate.identified_installs, total) : "—"}
          </dd>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-brand-faint"
            aria-hidden="true"
          >
            <div
              className="h-full rounded-full bg-brand-primary"
              style={{ width: `${Math.min(100, coverage)}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs leading-5 text-brand-muted">
            {estimate
              ? `${fmtInt(estimate.identified_installs)} of ${fmtInt(total)} installations`
              : "Waiting for device reporting support"}
          </p>
        </div>
      </dl>
      <p className="mt-4 border-t border-brand-faint pt-3 text-xs leading-5 text-brand-sub">
        {estimate && !collecting
          ? `${fmtInt(estimate.unidentified_installs)} installations without an identifier count individually in the estimate. `
          : "Device identifiers arrive when updated Android and iPhone apps check in. "}
        Operator and test installations are excluded. Activity charts still count installations.
      </p>
      <details className="mt-2 text-xs leading-5 text-brand-muted">
        <summary className="w-fit cursor-pointer rounded-sm font-medium text-brand-sub outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2">
          How the estimate works
        </summary>
        <p className="mt-2 max-w-3xl">
          Only updated apps report device identifiers. Installations sharing an Android ID or iPhone
          vendor ID count as one device. Installations without an identifier each count separately,
          so older installs can make the estimate high. Identifiers can change after a device reset
          or when all apps from the same vendor are removed on iPhone. This is an estimate of
          devices, not a count of people.
        </p>
      </details>
    </Card>
  );
}
