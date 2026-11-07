import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { useToast } from "../../components/Toast";
import { useI18n } from "../../lib/i18n";
import {
  archiveWebPerson,
  canArchiveWebPerson,
  hasPendingWebWrite,
  privateWebSettlementCurrencies,
  restoreWebPerson,
  settleWebPerson,
  type WebLedger,
  type WebPerson,
} from "../../lib/web-ledger";
import { getWebSession, isSameWebSession } from "../../lib/web-auth";
import { openWebRouteDialog } from "../../lib/web-route-dialog";

const copy = {
  en: {
    archive: "Archive person",
    restore: "Restore person",
    settle: "Settle account",
    archived: "This person is archived. Their history is available below.",
    archiveHelp:
      "This removes the person from your active list and keeps their tally history. You can restore them later.",
    restoreHelp:
      "This brings the person back to your active list with their tally history. You can add their phone number again if needed.",
    settleHelp:
      "This closes the current chapter at a zero balance. Earlier tallies stay in settled history, and new tallies start a new chapter.",
    shared: "Close the shared account and resolve pending tallies before archiving this person.",
    changed: "The account changed. Refresh it before trying again.",
    notZero: "The balance is no longer zero. Review the latest tallies before settling.",
    empty: "There are no new tallies to settle.",
    failed: "We couldn’t save this change. Try again.",
    pending: "The save hasn’t been confirmed. Retry the same action to check it.",
    archivedSuccess: "Person archived",
    restoredSuccess: "Person restored",
    settledSuccess: "Account settled",
    saving: "Saving…",
    retry: "Retry save",
    cancel: "Cancel",
  },
  fa: {
    archive: "بایگانی شخص",
    restore: "بازگرداندن شخص",
    settle: "تصفیۀ حساب",
    archived: "این شخص بایگانی شده است. تاریخچه در پایین دیده می‌شود.",
    archiveHelp:
      "این شخص از فهرست فعال برداشته می‌شود و تاریخچۀ ثبت‌ها باقی می‌ماند. بعداً او را بازگردانده می‌توانید.",
    restoreHelp:
      "این شخص با تاریخچۀ ثبت‌ها به فهرست فعال برمی‌گردد. در صورت نیاز شمارۀ تلفون را دوباره اضافه کنید.",
    settleHelp:
      "این فصل با بیلانس صفر بسته می‌شود. ثبت‌های قبلی در تاریخچۀ تصفیه می‌مانند و ثبت‌های تازه فصل جدید را آغاز می‌کنند.",
    shared: "پیش از بایگانی، حساب مشترک را ببندید و ثبت‌های در انتظار را بررسی کنید.",
    changed: "حساب تغییر کرده است. پیش از کوشش دوباره آن را تازه کنید.",
    notZero: "بیلانس دیگر صفر نیست. پیش از تصفیه آخرین ثبت‌ها را ببینید.",
    empty: "ثبت تازه‌ای برای تصفیه وجود ندارد.",
    failed: "این تغییر ذخیره نشد. دوباره کوشش کنید.",
    pending: "ذخیره هنوز تأیید نشده است. برای بررسی همان کار را دوباره انجام دهید.",
    archivedSuccess: "شخص بایگانی شد",
    restoredSuccess: "شخص بازگردانده شد",
    settledSuccess: "حساب تصفیه شد",
    saving: "در حال ذخیره…",
    retry: "کوشش دوبارۀ ذخیره",
    cancel: "انصراف",
  },
  ps: {
    archive: "کس ارشیف کړئ",
    restore: "کس بېرته راوګرځوئ",
    settle: "حساب تصفیه کړئ",
    archived: "دا کس ارشیف شوی دی. تاریخچه یې لاندې لیدلی شئ.",
    archiveHelp:
      "دا کس له فعال لېست څخه وځي او د ثبتونو تاریخچه یې پاتې کېږي. وروسته یې بېرته راوګرځولی شئ.",
    restoreHelp:
      "دا کس له خپلې تاریخچې سره فعال لېست ته راګرځي. که اړتیا وي، د تلفون شمېره یې بېرته زیاته کړئ.",
    settleHelp:
      "دا فصل په صفر بیلانس بندېږي. پخواني ثبتونه په تصفیه شوې تاریخچه کې پاتې کېږي او نوي ثبتونه نوی فصل پیلوي.",
    shared: "له ارشیف کولو مخکې ګډ حساب بند کړئ او پاتې ثبتونه وڅېړئ.",
    changed: "حساب بدل شوی دی. له بیا هڅې مخکې یې تازه کړئ.",
    notZero: "بیلانس نور صفر نه دی. له تصفیې مخکې وروستي ثبتونه وګورئ.",
    empty: "د تصفیې لپاره نوي ثبتونه نشته.",
    failed: "دا بدلون خوندي نه شو. بیا هڅه وکړئ.",
    pending: "خوندي کول لا نه دي تایید شوي. هماغه کار بیا وکړئ څو وکتل شي.",
    archivedSuccess: "کس ارشیف شو",
    restoredSuccess: "کس بېرته راوګرځېد",
    settledSuccess: "حساب تصفیه شو",
    saving: "خوندي کېږي…",
    retry: "بیا د خوندي کولو هڅه وکړئ",
    cancel: "لغوه",
  },
};

type Action = { kind: "archive" | "restore" } | { kind: "settle"; currency: string };

export function PersonLifecycle({
  ledger,
  person,
  canChange,
  onChanged,
  onPendingChange,
}: {
  ledger: WebLedger;
  person: WebPerson;
  canChange: boolean;
  onChanged: () => Promise<void> | void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { lang } = useI18n();
  const c = copy[lang];
  const toast = useToast();
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRetry, setPendingRetry] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const mounted = useRef(true);
  const scope = useRef({ vault: ledger.vault_id, person: person.relationship_id });
  scope.current = { vault: ledger.vault_id, person: person.relationship_id };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const archived = person.archived_at != null;
  const hasRole =
    ledger.observed_lifecycle === true &&
    ledger.archived_at_ms == null && ["owner", "manager", "editor"].includes(ledger.role);
  const archiveAllowed = canArchiveWebPerson(person);
  const currencies = hasRole ? privateWebSettlementCurrencies(ledger, person) : [];

  function open(next: Action) {
    setAction(next);
    setError("");
    setPendingRetry(false);
  }

  async function confirm() {
    if (!action || working.current || (!canChange && !pendingRetry)) return;
    const session = getWebSession();
    const target = scope.current;
    const current = () =>
      mounted.current &&
      isSameWebSession(getWebSession(), session) &&
      scope.current.vault === target.vault &&
      scope.current.person === target.person;
    if (!session) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      if (action.kind === "archive") await archiveWebPerson(ledger, person);
      else if (action.kind === "restore") await restoreWebPerson(ledger, person);
      else if (action.kind === "settle") await settleWebPerson(ledger, person, action.currency);
      if (!current()) return;
      setAction(null);
      setPendingRetry(false);
      onPendingChange?.(hasPendingWebWrite());
      toast.push(
        action.kind === "archive"
          ? c.archivedSuccess
          : action.kind === "restore"
            ? c.restoredSuccess
            : c.settledSuccess,
        "success",
      );
      await Promise.resolve()
        .then(onChanged)
        .catch(() => {});
    } catch (cause) {
      if (!current()) return;
      const pending = hasPendingWebWrite();
      setPendingRetry(pending);
      const code = typeof cause === "object" && cause && "code" in cause ? cause.code : "";
      setError(
        pending
          ? c.pending
          : code === "person_shared_active" || code === "shared_tally_required"
            ? c.shared
            : code === "settlement_not_zero"
              ? c.notZero
              : code === "settlement_empty"
                ? c.empty
                : code === "settlement_changed" || code === "person_changed"
                  ? c.changed
                  : c.failed,
      );
    } finally {
      working.current = false;
      if (current()) {
        setBusy(false);
        onPendingChange?.(hasPendingWebWrite());
      }
    }
  }

  return (
    <div className="space-y-2">
      {archived && <p className="text-sm text-brand-muted">{c.archived}</p>}
      {hasRole && (
        <div className="flex flex-wrap gap-2">
          {archived ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canChange}
              onClick={() => open({ kind: "restore" })}
            >
              {c.restore}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canChange || !archiveAllowed}
              onClick={() => open({ kind: "archive" })}
            >
              {c.archive}
            </Button>
          )}
          {currencies.map((currency) => (
            <Button
              key={currency}
              type="button"
              variant="outline"
              size="sm"
              disabled={!canChange}
              onClick={() => open({ kind: "settle", currency })}
            >
              {c.settle} · {currency}
            </Button>
          ))}
        </div>
      )}
      {hasRole && !archived && !archiveAllowed && (
        <p className="text-xs text-brand-muted">{c.shared}</p>
      )}
      {action && (
        <LifecycleDialog
          action={action}
          person={person}
          busy={busy}
          enabled={canChange || pendingRetry}
          pending={pendingRetry}
          error={error}
          onCancel={() => setAction(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </div>
  );
}

function LifecycleDialog({
  action,
  person,
  busy,
  enabled,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  action: Action;
  person: WebPerson;
  busy: boolean;
  enabled: boolean;
  pending: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { lang } = useI18n();
  const c = copy[lang];
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => (dialog.current ? openWebRouteDialog(dialog.current) : undefined), []);
  const title = action.kind === "settle" ? `${c.settle} · ${action.currency}` : c[action.kind];
  const description =
    action.kind === "settle"
      ? c.settleHelp
      : action.kind === "archive"
        ? c.archiveHelp
        : c.restoreHelp;
  return (
    <dialog
      ref={dialog}
      className="workspace-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <form
        className="web-profile-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && enabled) onConfirm();
        }}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        <p>
          <strong dir="auto">{person.name}</strong>
        </p>
        <p className="workspace-dialog-description">{description}</p>
        {error && (
          <p className="shared-error" role="alert">
            {error}
          </p>
        )}
        <div className="shared-actions">
          <Button
            type="submit"
            variant={action.kind === "archive" ? "destructive" : "brand"}
            disabled={busy || !enabled}
          >
            {busy ? c.saving : pending ? c.retry : c[action.kind]}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            {c.cancel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
