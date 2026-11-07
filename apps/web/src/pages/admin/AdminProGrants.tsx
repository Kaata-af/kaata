import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  AdminProGrantError,
  changeAdminProGrant,
  MAX_GRANT_REASON_LENGTH,
  proGrantExpiry,
  proGrantReason,
  type AdminProGrant,
  type AdminProGrantAction,
} from "./admin-pro-grants";
import { adminProKey, type AdminProStatus } from "./admin-pro";
import { useAdminToken } from "./api";
import { fmtDateTime, reportingDay } from "./dates";

const LABEL = "block min-w-0 space-y-1.5 text-xs font-medium text-brand-ink";
type Draft = { reason: string } & (
  | { kind: "grant"; day: string }
  | { kind: "revoke"; grant: AdminProGrant }
);

export function AdminProGrants({
  accountID,
  accountName,
  status,
  unavailable = false,
}: {
  accountID: string;
  accountName: string;
  status: AdminProStatus;
  unavailable?: boolean;
}) {
  const token = useAdminToken();
  const client = useQueryClient();
  const key = adminProKey(token, accountID);
  const mutationKey = [...key, "change-grant"];
  const busy = useIsMutating({ mutationKey, exact: true }) > 0;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [lastAction, setLastAction] = useState<AdminProGrantAction | null>(null);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const dateHint = useId();
  const formHeadingID = useId();
  const formHeading = useRef<HTMLHeadingElement>(null);
  const save = useMutation({
    mutationKey,
    mutationFn: (action: AdminProGrantAction) => changeAdminProGrant(token, accountID, action),
    retry: false,
    onSuccess: (result, action) => {
      if (action.kind === "revoke") {
        setNotice("Complimentary access revoked.");
      } else {
        setNotice(
          result.duplicate
            ? "The complimentary grant was already recorded."
            : "Complimentary access granted.",
        );
      }
      setDraft(null);
      setLastAction(null);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }),
  });
  const editing = !!draft;
  useEffect(() => {
    if (editing) formHeading.current?.focus({ preventScroll: true });
  }, [editing]);

  const active = status.manual_grant;
  const conflict = save.error instanceof AdminProGrantError && save.error.kind === "conflict";
  const unconfirmed = save.error instanceof AdminProGrantError && save.error.kind === "unconfirmed";
  const stale =
    draft?.kind === "grant" ? !!active : draft?.kind === "revoke" && active?.id !== draft.grant.id;

  function begin() {
    save.reset();
    setNotice("");
    setFormError("");
    setDraft(
      active
        ? { kind: "revoke", grant: active, reason: "" }
        : { kind: "grant", day: "", reason: "" },
    );
  }

  function cancel() {
    save.reset();
    setDraft(null);
    setLastAction(null);
    setFormError("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy || client.isMutating({ mutationKey, exact: true })) return;
    if (unconfirmed) {
      if (lastAction) save.mutate(lastAction);
      return;
    }
    if (unavailable || stale || conflict) return;
    const reason = proGrantReason(draft.reason);
    if (!reason) {
      setFormError(`Enter a reason of up to ${MAX_GRANT_REASON_LENGTH} characters.`);
      return;
    }
    const operation_id = crypto.randomUUID();
    let action: AdminProGrantAction;
    if (draft.kind === "grant") {
      const expires_at = proGrantExpiry(draft.day);
      if (!expires_at) {
        setFormError("Choose a valid date whose Kabul end time is still in the future.");
        return;
      }
      action = { kind: "grant", operation_id, reason, expires_at };
    } else {
      action = { kind: "revoke", operation_id, reason, grant_id: draft.grant.id };
    }
    setFormError("");
    setLastAction(action);
    save.mutate(action);
  }

  const confirmLabel = draft?.kind === "revoke" ? "Revoke manual grant" : "Grant Pro";

  return (
    <section aria-label="Pro access" className="min-w-0 space-y-3 border-t border-brand-faint pt-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <dl className="grid min-w-0 flex-1 gap-x-6 gap-y-2 text-xs leading-5 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="font-semibold text-brand-sub">Paid through</dt>
            <dd className="text-brand-muted">
              {status.paid_expires_at
                ? `${fmtDateTime(status.paid_expires_at)} Kabul time`
                : "No paid term"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="font-semibold text-brand-sub">Complimentary access</dt>
            <dd className="text-brand-muted">
              {active ? `Through ${fmtDateTime(active.expires_at)} Kabul time` : "No active grant"}
            </dd>
            {active && (
              <dd className="break-words text-brand-ink">
                <bdi>{active.reason}</bdi>
              </dd>
            )}
          </div>
        </dl>
        {!draft && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || unavailable}
            onClick={begin}
          >
            {active ? "Revoke manual grant" : "Grant Pro until…"}
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="text-xs leading-5 text-emerald-700">
          {notice}
        </p>
      )}
      {draft && (
        <form
          aria-labelledby={formHeadingID}
          className="min-w-0 space-y-3 rounded-lg border border-brand-border bg-brand-ivory p-3"
          onSubmit={submit}
        >
          <h5
            id={formHeadingID}
            ref={formHeading}
            tabIndex={-1}
            className="text-sm font-semibold text-brand-ink outline-none"
          >
            {draft.kind === "revoke" ? "Revoke complimentary Pro" : "Grant complimentary Pro"}
          </h5>
          <p className="break-words text-xs leading-5 text-brand-sub">
            {draft.kind === "revoke" ? "Revoke access for " : "Grant access to "}
            <bdi className="font-medium">{accountName}</bdi>.{" "}
            {draft.kind === "revoke"
              ? "Any paid Pro time stays active through its paid expiry."
              : "The grant is recorded in access history."}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {draft.kind === "grant" && (
              <label className={LABEL}>
                <span>Grant through date</span>
                <Input
                  type="date"
                  required
                  min={unconfirmed ? undefined : reportingDay(Date.now())}
                  aria-describedby={dateHint}
                  className="bg-white"
                  value={draft.day}
                  disabled={busy || unconfirmed || conflict || stale}
                  onChange={(event) => {
                    setDraft({ ...draft, day: event.target.value });
                    setFormError("");
                  }}
                />
                <span id={dateHint} className="block font-normal text-brand-muted">
                  Through the end of this date in Kabul.
                </span>
              </label>
            )}
            <label className={`${LABEL} ${draft.kind === "revoke" ? "sm:col-span-2" : ""}`}>
              <span>Reason</span>
              <Input
                required
                maxLength={MAX_GRANT_REASON_LENGTH}
                autoComplete="off"
                className="bg-white"
                placeholder={
                  draft.kind === "grant" ? "e.g. Complimentary trial" : "e.g. Trial ended early"
                }
                value={draft.reason}
                disabled={busy || unconfirmed || conflict || stale}
                onChange={(event) => {
                  setDraft({ ...draft, reason: event.target.value });
                  setFormError("");
                }}
              />
            </label>
          </div>
          {draft.kind === "revoke" && (
            <p className="text-xs text-brand-muted">
              Grant expiry {fmtDateTime(draft.grant.expires_at)} Kabul time
            </p>
          )}
          {stale && !unconfirmed && !conflict && (
            <p role="alert" className="text-xs text-amber-800">
              Complimentary access changed while you were editing. Close this form and check the
              current access.
            </p>
          )}
          {(formError || save.error) && (
            <p role="alert" className="text-xs leading-5 text-red-700">
              {formError || save.error?.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!unconfirmed && (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancel}>
                {conflict || stale ? "Close" : "Cancel"}
              </Button>
            )}
            <Button
              type="submit"
              variant={draft.kind === "revoke" ? "destructive" : "default"}
              size="sm"
              disabled={busy || (!unconfirmed && (unavailable || conflict || stale))}
            >
              {busy ? "Saving…" : unconfirmed ? "Retry same request" : confirmLabel}
            </Button>
          </div>
        </form>
      )}
      {status.grant_history.length > 0 && (
        <details className="min-w-0 text-xs leading-5">
          <summary className="cursor-pointer font-semibold text-brand-sub">
            Complimentary access history
          </summary>
          <ul className="mt-1 divide-y divide-brand-faint">
            {status.grant_history.map((grant) => (
              <li key={grant.id} className="min-w-0 space-y-1 py-2">
                <p className="break-words text-brand-ink">
                  <span className="font-medium">
                    {grant.revoked_at ? "Revoked" : active?.id === grant.id ? "Active" : "Expired"}
                  </span>
                  {" · "}
                  <bdi>{grant.reason}</bdi>
                </p>
                <p className="text-brand-muted">
                  Granted {fmtDateTime(grant.granted_at)} · Through {fmtDateTime(grant.expires_at)}{" "}
                  Kabul time
                </p>
                {grant.revoked_at && (
                  <p className="break-words text-brand-muted">
                    Revoked {fmtDateTime(grant.revoked_at)} Kabul time ·{" "}
                    <bdi>{grant.revoke_reason}</bdi>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
