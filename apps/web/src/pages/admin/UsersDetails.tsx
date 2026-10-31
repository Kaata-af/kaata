import type { InstallRow, UserRow } from "./api";
import { fmtDateTime, fmtInt } from "./ui";
import { platformLabel, platformsLabel } from "./platforms";

function DetailItem(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-brand-muted">{props.label}</dt>
      <dd className="mt-1 text-xs leading-5 text-brand-ink [overflow-wrap:anywhere]" dir="auto">
        {props.value || "Not provided"}
      </dd>
    </div>
  );
}

export function AccountDetail(props: { u: UserRow }) {
  const u = props.u;
  return (
    <div className="min-w-0 max-w-full">
      <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailItem label="Account name" value={u.name} />
        <DetailItem label="Account created" value={fmtDateTime(u.created_at)} />
        <DetailItem label="Last sign-in" value={fmtDateTime(u.last_login_at)} />
        <DetailItem label="Last reported activity" value={fmtDateTime(u.last_activity_at)} />
        <DetailItem label="Platforms" value={platformsLabel(u.platforms, u.platform)} />
        <DetailItem
          label="Latest platform"
          value={`${platformLabel(u.platform)}${u.app_version && u.app_version !== "web" ? ` · v${u.app_version}` : ""}`}
        />
        <DetailItem label="Linked app installations" value={fmtInt(u.install_count)} />
        {u.web_session_count !== undefined ? (
          <DetailItem label="Browser sessions" value={fmtInt(u.web_session_count)} />
        ) : null}
        <DetailItem label="Onboarding" value={u.has_onboarded ? "Completed" : "Not completed"} />
      </dl>
      <div className="mt-5">
        <h4 className="text-xs font-semibold text-brand-sub">
          Kaatas{" "}
          <span className="ml-1 font-normal tabular-nums text-brand-muted">{u.kaatas.length}</span>
        </h4>
        {u.kaatas.length === 0 ? (
          <p className="mt-2 text-xs leading-5 text-brand-muted">
            No synced kaatas available for this account.
          </p>
        ) : (
          <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-2">
            {u.kaatas.map((kaata) => (
              <div
                key={kaata.vault_id}
                className="min-w-0 max-w-full rounded-xl border border-brand-border bg-white p-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className="min-w-0 max-w-full text-sm font-medium text-brand-ink [overflow-wrap:anywhere]"
                    dir="auto"
                  >
                    {kaata.name}
                  </span>
                  <span className="max-w-full rounded bg-brand-faint px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brand-ink [overflow-wrap:anywhere]">
                    {kaata.role}
                  </span>
                  {kaata.archived ? (
                    <span className="rounded bg-[#fff4df] px-1.5 py-0.5 text-[10px] font-medium text-[#8c621a]">
                      Archived
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-xs leading-5 tabular-nums text-brand-muted">
                  {fmtInt(kaata.tally_count)} tallies · {fmtInt(kaata.customer_count)} customers ·{" "}
                  {kaata.member_count} member{kaata.member_count === 1 ? "" : "s"}
                </p>
                {kaata.members.length > 0 ? (
                  <p
                    className="mt-1 text-xs leading-5 text-brand-muted [overflow-wrap:anywhere]"
                    dir="auto"
                  >
                    {kaata.members
                      .map((member) => `${member.name || member.email} (${member.role})`)
                      .join(", ")}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function InstallDetail(props: { d: InstallRow }) {
  const d = props.d;
  return (
    <dl className="grid min-w-0 max-w-full grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      <DetailItem label="Install ID" value={d.install_id} />
      <DetailItem
        label="Device"
        value={`${platformLabel(d.platform)}${d.app_version && d.app_version !== "web" ? ` · v${d.app_version}` : ""}`}
      />
      {/* "Installed" is shown once, above, as the earlier of the device's
          own clock and First seen (users-model installTime). */}
      <DetailItem label="First seen" value={fmtDateTime(d.first_seen)} />
      <DetailItem label="Last seen" value={fmtDateTime(d.last_seen)} />
      <DetailItem label="Last reported activity" value={fmtDateTime(d.last_activity_at)} />
      <DetailItem label="Attribution method" value={d.attribution_method} />
      <DetailItem label="Check-ins" value={fmtInt(d.check_in_count)} />
      <DetailItem label="Onboarding" value={d.has_onboarded ? "Completed" : "Not completed"} />
    </dl>
  );
}
