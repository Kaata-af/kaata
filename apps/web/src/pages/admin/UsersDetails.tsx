import type { InstallRow, UserRow } from "./api";
import { fmtDate, fmtInt } from "./ui";

function DetailItem(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-[#667085]">{props.label}</dt>
      <dd className="mt-1 break-words text-xs leading-5 text-[#344054]">
        {props.value || "Not provided"}
      </dd>
    </div>
  );
}

export function AccountDetail(props: { u: UserRow }) {
  const u = props.u;
  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
        <DetailItem label="Account name" value={u.name} />
        <DetailItem label="Account created" value={fmtDate(u.created_at)} />
        <DetailItem label="Last sign-in" value={fmtDate(u.last_login_at)} />
        <DetailItem label="Last reported activity" value={fmtDate(u.last_activity_at)} />
        <DetailItem
          label="Latest device"
          value={`${u.platform || "Unknown"}${u.app_version ? ` · v${u.app_version}` : ""}`}
        />
        <DetailItem label="Linked devices" value={fmtInt(u.install_count)} />
        <DetailItem label="Onboarding" value={u.has_onboarded ? "Completed" : "Not completed"} />
      </dl>
      <div className="mt-5">
        <h4 className="text-xs font-semibold text-[#475467]">
          Kaatas{" "}
          <span className="ml-1 font-normal tabular-nums text-[#667085]">{u.kaatas.length}</span>
        </h4>
        {u.kaatas.length === 0 ? (
          <p className="mt-2 text-xs leading-5 text-[#667085]">
            No synced kaatas available for this account.
          </p>
        ) : (
          <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
            {u.kaatas.map((kaata) => (
              <div key={kaata.vault_id} className="rounded-xl border border-[#e0e8e3] bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words text-sm font-medium text-[#344054]">
                    {kaata.name}
                  </span>
                  <span className="rounded bg-[#edf4f0] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#0c745a]">
                    {kaata.role}
                  </span>
                  {kaata.archived ? (
                    <span className="rounded bg-[#fff4df] px-1.5 py-0.5 text-[10px] font-medium text-[#8c621a]">
                      Archived
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-xs leading-5 tabular-nums text-[#667085]">
                  {fmtInt(kaata.tally_count)} tallies · {fmtInt(kaata.customer_count)} customers ·{" "}
                  {kaata.member_count} member{kaata.member_count === 1 ? "" : "s"}
                </p>
                {kaata.members.length > 0 ? (
                  <p className="mt-1 break-words text-xs leading-5 text-[#667085]">
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
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
      <DetailItem label="Install ID" value={d.install_id} />
      <DetailItem
        label="Device"
        value={`${d.platform || "Unknown"}${d.app_version ? ` · v${d.app_version}` : ""}`}
      />
      <DetailItem label="First seen" value={fmtDate(d.first_seen)} />
      <DetailItem label="Last reported activity" value={fmtDate(d.last_activity_at)} />
      <DetailItem label="Attribution method" value={d.attribution_method} />
      <DetailItem label="Check-ins" value={fmtInt(d.check_in_count)} />
      <DetailItem label="Onboarding" value={d.has_onboarded ? "Completed" : "Not completed"} />
    </dl>
  );
}
