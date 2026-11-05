import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SelectField } from "../../components/ui/select-field";
import { useToast } from "../../components/Toast";
import { useI18n } from "../../lib/i18n";
import { getWebSession, isSameWebSession, WebApiError } from "../../lib/web-auth";
import type { WebEntry, WebLedger, WebPerson } from "../../lib/web-ledger";
import { CURRENCIES, getCurrencyNameForLocale } from "../../lib/mobile-domain";
import {
  acceptWebTabEntry,
  appendWebTabEntry,
  closeWebSharedAccount,
  createWebTabGroup,
  disputeWebTabEntry,
  ensureWebTabCurrency,
  loadWebSharedTabs,
  newWebTabGroupDraft,
  regenerateWebSharedLink,
  settleWebTab,
  voidWebTabEntry,
  type WebTab,
  type WebTabEntry,
  type WebTabGroupDraft,
  type WebTabRecordingMode,
  type WebTabResponse,
} from "../../lib/web-tabs";
import {
  amountInput,
  entryTimestamp,
  localDateValue,
  localTimeValue,
  minorUnits,
  money,
} from "./model";
import { sharedTalliesCopy, type SharedTalliesCopy } from "./shared-tallies-copy";
import {
  sharedDirectionFor,
  sharedAccountCanStart,
  sharedContactActive,
  sharedEntryActions,
  sharedHistoryCSV,
  sharedPeriodCanSettle,
  sharedPeriodHistory,
} from "./shared-tallies-model";
import "./SharedTallies.css";

type Props = {
  ledger: WebLedger;
  person: WebPerson;
  online: boolean;
  onChanged: () => Promise<void>;
  refreshKey?: number;
  onPrivateEdit?: (entry: WebEntry) => void;
  onPrivateDelete?: (entry: WebEntry) => void;
};
type ReviewAction =
  | { kind: "dispute"; entry: WebTabEntry }
  | { kind: "void"; entry: WebTabEntry }
  | { kind: "settle" }
  | { kind: "close" };

function failureMessage(error: unknown, c: SharedTalliesCopy) {
  const code = error instanceof WebApiError ? error.code : "";
  if (code === "credit_limit_exceeded") return c.credit;
  if (error instanceof WebApiError && [403, 404, 410].includes(error.status)) return c.permission;
  if (error instanceof WebApiError && error.status === 409) return c.changed;
  return c.saveError;
}
function uncertainResult(error: unknown) {
  return !(error instanceof WebApiError) || error.status === 0 || error.status >= 500;
}
function signedAmount(value: string, c: SharedTalliesCopy) {
  const amount = minorUnits(value);
  return {
    amount: money(amount),
    description: amount > 0n ? c.collect : amount < 0n ? c.pay : c.clear,
    sign: amount > 0n ? "positive" : amount < 0n ? "negative" : "zero",
  };
}
function defaultDateTime(now: number) {
  return `${localDateValue(now)}T${localTimeValue(now)}`;
}
function partyName(tab: WebTab, role: "a" | "b", c: SharedTalliesCopy) {
  return (
    tab.parties[role]?.account_name ||
    tab.parties[role]?.label ||
    (tab.you === role ? c.you : c.other)
  );
}

export function SharedTallies({
  ledger,
  person,
  online,
  onChanged,
  refreshKey,
  onPrivateEdit,
  onPrivateDelete,
}: Props) {
  const { lang } = useI18n();
  const c = sharedTalliesCopy[lang];
  const id = useId();
  const toast = useToast();
  const [periods, setPeriods] = useState<WebTabResponse[]>([]);
  const [currency, setCurrency] = useState(ledger.default_entry_currency);
  const [periodID, setPeriodID] = useState("");
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entryType, setEntryType] = useState<"debt" | "payment" | null>(null);
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [reason, setReason] = useState("");
  const [invitation, setInvitation] = useState("");
  const [newCurrency, setNewCurrency] = useState("");
  const [addingCurrency, setAddingCurrency] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const input = useRef({ ledger, person, onChanged });
  input.current = { ledger, person, onChanged };
  const identity = useRef(getWebSession());
  const mounted = useRef(true);
  const version = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const refreshing = useRef(false);
  const settlementID = useRef<string | null>(null);
  const current = () => mounted.current && isSameWebSession(getWebSession(), identity.current);
  const reload = useCallback(async () => {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const requested = ++version.current;
    setLoading(true);
    setReadError(false);
    try {
      const next = await loadWebSharedTabs(
        input.current.ledger,
        input.current.person,
        controller.signal,
      );
      if (!controller.signal.aborted && requested === version.current && current())
        setPeriods(next);
    } catch (cause) {
      if (!controller.signal.aborted && requested === version.current && current()) {
        if (cause instanceof WebApiError && [401, 403, 404, 410].includes(cause.status)) {
          setPeriods([]);
        }
        setReadError(true);
      }
    } finally {
      if (!controller.signal.aborted && requested === version.current && current())
        setLoading(false);
    }
  }, [ledger.vault_id, person.relationship_id]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
      ++version.current;
      readController.current?.abort();
      writeController.current?.abort();
    };
  }, [reload]);
  const previousRefresh = useRef(refreshKey);
  useEffect(() => {
    if (previousRefresh.current !== refreshKey) {
      previousRefresh.current = refreshKey;
      void reload();
    }
  }, [refreshKey, reload]);
  async function refreshBoth() {
    if (!online || writing.current || refreshing.current || !current()) return;
    refreshing.current = true;
    const before = version.current;
    setLoading(true);
    setReadError(false);
    try {
      await input.current.onChanged();
      // A parent refresh may already have scheduled the new tab read through
      // refreshKey. A manual refresh never calls back into the parent twice.
      if (current() && version.current === before) await reload();
    } catch {
      if (current() && version.current === before) {
        setReadError(true);
        setLoading(false);
      }
    } finally {
      refreshing.current = false;
    }
  }
  const currencies = [...new Set(periods.map((item) => item.tab.currency))];
  const selectedCurrency = currencies.includes(currency) ? currency : currencies[0];
  const choices = periods.filter((item) => item.tab.currency === selectedCurrency);
  const selected =
    choices.find((item) => item.tab.id === periodID) ??
    [...choices].reverse().find((item) => item.tab.closed_at_ms == null) ??
    choices.at(-1);
  const tab = selected?.tab;
  const access = tab?.access;
  const mutationActive = sharedContactActive(ledger, person);
  const unavailable = !online || busy || loading || readError || !mutationActive;
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(lang === "en" ? "en-GB" : lang === "fa" ? "fa-AF" : "ps-AF", {
        dateStyle: "medium",
        timeStyle: "short",
        calendar: "gregory",
      }),
    [lang],
  );
  const date = (stamp: number) => formatter.format(new Date(stamp));

  async function mutate(work: (signal: AbortSignal) => Promise<unknown>) {
    if (
      !online ||
      loading ||
      readError ||
      writing.current ||
      !current() ||
      !sharedContactActive(input.current.ledger, input.current.person)
    )
      return false;
    writing.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    writeController.current = controller;
    try {
      await work(controller.signal);
      if (controller.signal.aborted || !current()) return false;
      toast.push(c.saved, "success");
      setAction(null);
      setReason("");
      await reload();
      if (current()) await input.current.onChanged().catch(() => {});
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && current()) setError(failureMessage(cause, c));
      throw cause;
    } finally {
      writing.current = false;
      if (current()) setBusy(false);
    }
  }
  const run = (work: (signal: AbortSignal) => Promise<unknown>) => {
    void mutate(work).catch(() => {});
  };

  const latest = selected === choices.at(-1);
  const scopeBalance = latest
    ? person.shared?.balances.find((item) => item.currency === selectedCurrency)
    : undefined;
  const financial = scopeBalance?.recorded ?? tab?.recorded_balance?.[tab.you] ?? "0";
  const confirmed = scopeBalance?.confirmed ?? tab?.confirmed_balance?.[tab.you] ?? "0";
  const pending = scopeBalance?.pending ?? tab?.pending_balance?.[tab.you] ?? "0";
  const cards = [
    { title: c.recorded, help: c.recordedHelp, value: financial },
    { title: c.confirmed, help: c.confirmedHelp, value: confirmed },
    { title: c.pending, help: c.pendingHelp, value: pending },
  ];
  const throughSeq = Math.max(0, ...(selected?.settlements ?? []).map((item) => item.through_seq));
  const history = selected ? sharedPeriodHistory(selected) : [];
  function exportHistory() {
    if (loading || readError || !current()) return;
    const content = sharedHistoryCSV(person, periods, ledger.shared_private_entries ?? [], c);
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kaata-shared-history-${localDateValue()}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="shared-tallies" aria-label={c.title}>
      <div className="shared-tallies-heading">
        <div>
          <h3>{c.title}</h3>
          {tab && (
            <p>
              {c[tab.recording_mode]}
              {tab.closed_at_ms != null ? ` · ${c.closed}` : ""}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!online || busy || loading}
          onClick={() => void refreshBoth()}
        >
          {c.refresh}
        </Button>
      </div>
      {!online && (
        <p className="shared-notice" role="status">
          {c.offline}
        </p>
      )}
      {readError && (
        <p className="shared-error" role="alert">
          {c.loadError}{" "}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!online || loading}
            onClick={() => void refreshBoth()}
          >
            {c.retry}
          </Button>
        </p>
      )}
      {loading && !periods.length ? (
        <p className="shared-notice" role="status">
          {c.loading}
        </p>
      ) : !selected ? (
        <p className="shared-notice">{c.empty}</p>
      ) : (
        <>
          <div className="shared-selectors">
            <div>
              <label htmlFor={`${id}-currency`}>{c.currency}</label>
              <SelectField
                id={`${id}-currency`}
                dir={lang === "en" ? "ltr" : "rtl"}
                value={selectedCurrency}
                options={currencies.map((value) => ({ value, label: value }))}
                disabled={busy || !!entryType || !!action}
                onValueChange={(value) => {
                  setCurrency(value);
                  setPeriodID("");
                  setError("");
                }}
              />
            </div>
            <div>
              <label htmlFor={`${id}-period`}>{c.period}</label>
              <SelectField
                id={`${id}-period`}
                dir={lang === "en" ? "ltr" : "rtl"}
                value={selected.tab.id}
                options={choices.map((item) => ({
                  value: item.tab.id,
                  label: `${item.tab.closed_at_ms == null ? c.current : c.closed} · ${date(item.tab.created_at_ms)}`,
                }))}
                disabled={busy || !!entryType || !!action}
                onValueChange={(value) => {
                  setPeriodID(value);
                  setError("");
                }}
              />
            </div>
          </div>
          <div className="shared-balance-grid">
            {cards.map((card) => {
              const balance = signedAmount(card.value, c);
              return (
                <div key={card.title} className={`shared-balance ${balance.sign}`}>
                  <p>{card.title}</p>
                  <strong dir="ltr">
                    {balance.amount}
                    <small>{tab!.currency}</small>
                  </strong>
                  <span>{balance.description}</span>
                  <small>{card.help}</small>
                </div>
              );
            })}
          </div>
          {!scopeBalance && <p className="shared-notice">{c.periodBalanceHelp}</p>}
          {scopeBalance?.private != null && minorUnits(scopeBalance.private) !== 0n && (
            <p className="shared-notice">
              {c.privateBalance} ·{" "}
              <bdi>
                {money(minorUnits(scopeBalance.private))} {tab!.currency}
              </bdi>
            </p>
          )}
          {access?.append && tab!.closed_at_ms == null ? (
            <div className="shared-actions">
              <Button
                type="button"
                variant="brand"
                disabled={unavailable || !!entryType || !!action}
                onClick={() => {
                  setEntryType("debt");
                  setError("");
                }}
              >
                {c.gave}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={unavailable || !!entryType || !!action}
                onClick={() => {
                  setEntryType("payment");
                  setError("");
                }}
              >
                {c.received}
              </Button>
            </div>
          ) : (
            <p className="shared-notice">{c.viewOnly}</p>
          )}
          {entryType && (
            <SharedEntryForm
              tab={tab!}
              type={entryType}
              busy={busy}
              online={online && !loading && !readError && mutationActive}
              onCancel={() => {
                setEntryType(null);
                setError("");
              }}
              onSave={async (request) => {
                const saved = await mutate((signal) => appendWebTabEntry(tab!, request, signal));
                if (saved && current()) setEntryType(null);
              }}
            />
          )}
          {error && (
            <p className="shared-error" role="alert">
              {error}
            </p>
          )}
          <div className="shared-history-title">
            <h4>{c.history}</h4>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || readError || busy}
              title={c.exportHelp}
              onClick={exportHistory}
            >
              {c.export}
            </Button>
            {sharedPeriodCanSettle(selected, financial, pending) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={unavailable || !!entryType || !!action}
                onClick={() => {
                  settlementID.current = crypto.randomUUID();
                  setAction({ kind: "settle" });
                  setError("");
                }}
              >
                {c.settle}
              </Button>
            )}
          </div>
          {action && (
            <form
              className="shared-action-confirm"
              onSubmit={(event) => {
                event.preventDefault();
                if (unavailable) return;
                if (action.kind === "dispute")
                  run((signal) =>
                    disputeWebTabEntry(tab!, action.entry.id, reason, action.entry.rev, signal),
                  );
                else if (action.kind === "void")
                  run((signal) => voidWebTabEntry(tab!, action.entry.id, signal));
                else if (action.kind === "settle")
                  run((signal) => settleWebTab(tab!, settlementID.current!, signal));
                else run((signal) => closeWebSharedAccount(tab!, signal));
              }}
            >
              <strong>
                {action.kind === "void"
                  ? c.confirmWithdraw
                  : action.kind === "settle"
                    ? c.settle
                    : action.kind === "close"
                      ? c.close
                      : c.confirmDispute}
              </strong>
              <p>
                {action.kind === "void"
                  ? c.withdrawHelp
                  : action.kind === "settle"
                    ? c.settleHelp
                    : action.kind === "close"
                      ? c.closeHelp
                      : `${money(minorUnits(action.entry.amount))} ${tab!.currency}`}
              </p>
              {action.kind === "dispute" && (
                <label>
                  {c.reason}
                  <Input
                    value={reason}
                    disabled={busy}
                    maxLength={300}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
              )}
              <div className="shared-actions">
                <Button type="submit" variant="brand" disabled={unavailable}>
                  {busy
                    ? c.saving
                    : action.kind === "void"
                      ? c.withdraw
                      : action.kind === "settle"
                        ? c.settle
                        : action.kind === "close"
                          ? c.confirmClose
                          : c.confirmDispute}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setAction(null);
                    setReason("");
                    setError("");
                  }}
                >
                  {c.cancel}
                </Button>
              </div>
            </form>
          )}
          <ol className="shared-history">
            {history.length === 0 && <li className="shared-notice">{c.empty}</li>}
            {history.map((item) => {
              if (item.kind === "settlement")
                return (
                  <li key={`settlement:${item.settlement.id}`} className="shared-settlement">
                    <span>{c.settled}</span>
                    <time>{date(item.settlement.settled_at_ms)}</time>
                    {item.settlement.actor_name && <small>{item.settlement.actor_name}</small>}
                  </li>
                );
              const entry = item.entry;
              const cancelled = entry.kind === "void" || entry.voided_by_entry_id != null;
              const gave = (entry.direction === "a_to_b" ? "a" : "b") === tab!.you;
              const status = cancelled
                ? c.voided
                : entry.status === "pending"
                  ? c.pendingStatus
                  : entry.status === "accepted"
                    ? c.accepted
                    : entry.status === "recorded"
                      ? c.recordedStatus
                      : c.disputed;
              const { review: canReview, void: canVoid } = sharedEntryActions(
                tab!,
                entry,
                throughSeq,
              );
              return (
                <li
                  key={entry.id}
                  className={`shared-history-entry ${cancelled ? "is-cancelled" : ""}`}
                >
                  <div className="shared-entry-summary">
                    <div>
                      <strong>
                        {entry.kind === "opening"
                          ? entry.status === "pending"
                            ? c.proposal
                            : c.opening
                          : entry.kind === "void"
                            ? c.void
                            : gave
                              ? c.gave
                              : c.received}
                      </strong>
                      <time>{date(entry.occurred_at_ms)}</time>
                    </div>
                    <div className={`shared-entry-amount ${gave ? "positive" : "negative"}`}>
                      <strong dir="ltr">
                        {money(minorUnits(entry.amount))} <small>{tab!.currency}</small>
                      </strong>
                      <span className={`shared-status status-${cancelled ? "void" : entry.status}`}>
                        {status}
                      </span>
                    </div>
                  </div>
                  {entry.note && (
                    <p className="shared-entry-note" dir="auto">
                      {entry.note}
                    </p>
                  )}
                  <p className="shared-entry-evidence">
                    {c.by} · {entry.author_name || partyName(tab!, entry.created_by, c)}
                    {entry.author_member_role ? ` · ${entry.author_member_role}` : ""}
                  </p>
                  {entry.reviewer_name && (
                    <p className="shared-entry-evidence">
                      {c.reviewedBy} · {entry.reviewer_name}
                      {entry.reviewer_member_role ? ` · ${entry.reviewer_member_role}` : ""}
                    </p>
                  )}
                  {entry.dispute_reason && (
                    <p className="shared-entry-note" dir="auto">
                      {entry.dispute_reason}
                    </p>
                  )}
                  {(canReview || canVoid) && (
                    <div className="shared-actions">
                      {canReview && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="brand"
                            disabled={unavailable || !!entryType || !!action}
                            onClick={() =>
                              run((signal) => acceptWebTabEntry(tab!, entry.id, entry.rev, signal))
                            }
                          >
                            {c.accept}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={unavailable || !!entryType || !!action}
                            onClick={() => {
                              setAction({ kind: "dispute", entry });
                              setError("");
                            }}
                          >
                            {c.dispute}
                          </Button>
                        </>
                      )}
                      {canVoid && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={unavailable || !!entryType || !!action}
                          onClick={() => {
                            setAction({ kind: "void", entry });
                            setError("");
                          }}
                        >
                          {c.withdraw}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <PrivateHistory
            ledger={ledger}
            person={person}
            currency={selectedCurrency}
            disabled={unavailable || !!entryType || !!action}
            onEdit={onPrivateEdit}
            onDelete={onPrivateDelete}
          />
          {access?.manage && (
            <details
              className="shared-management"
              open={manageOpen}
              onToggle={(event) => setManageOpen(event.currentTarget.open)}
            >
              <summary>{c.manage}</summary>
              <div className="shared-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={unavailable || !!action || !!entryType}
                  onClick={() => {
                    run(async (signal) => {
                      const result = await regenerateWebSharedLink(tab!, signal);
                      if (current()) setInvitation(result.invite_url);
                    });
                  }}
                >
                  {c.regenerate}
                </Button>
                {tab!.group_id && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={unavailable || !!action || !!entryType}
                    onClick={() => setAddingCurrency(!addingCurrency)}
                  >
                    {c.addCurrency}
                  </Button>
                )}
                {tab!.closed_at_ms == null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={unavailable || !!action || !!entryType}
                    onClick={() => {
                      setAction({ kind: "close" });
                      setError("");
                    }}
                  >
                    {c.close}
                  </Button>
                )}
              </div>
              {addingCurrency && (
                <form
                  className="shared-currency-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run((signal) =>
                      ensureWebTabCurrency(
                        tab!,
                        input.current.ledger,
                        input.current.person,
                        newCurrency,
                        signal,
                      ),
                    );
                  }}
                >
                  <label>
                    {c.currencyCode}
                    <SelectField
                      value={newCurrency}
                      placeholder={c.addCurrency}
                      dir={lang === "en" ? "ltr" : "rtl"}
                      disabled={busy}
                      options={CURRENCIES.filter((item) => !currencies.includes(item.code)).map(
                        (item) => ({
                          value: item.code,
                          label: `${item.code} · ${getCurrencyNameForLocale(item.code, lang)}`,
                        }),
                      )}
                      onValueChange={setNewCurrency}
                    />
                  </label>
                  <p>{c.currencyHelp}</p>
                  <Button
                    type="submit"
                    variant="brand"
                    size="sm"
                    disabled={unavailable || !/^[A-Z]{3}$/.test(newCurrency)}
                  >
                    {c.addCurrency}
                  </Button>
                </form>
              )}
              {invitation && <InvitationLink url={invitation} />}
            </details>
          )}
        </>
      )}
    </section>
  );
}

function SharedEntryForm({
  tab,
  type,
  busy,
  online,
  onSave,
  onCancel,
}: {
  tab: WebTab;
  type: "debt" | "payment";
  busy: boolean;
  online: boolean;
  onSave: (request: {
    id: string;
    direction: "a_to_b" | "b_to_a";
    amount: string;
    note: string | null;
    occurred_at_ms: number;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const { lang } = useI18n();
  const c = sharedTalliesCopy[lang];
  const id = useId();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const openedAt = useRef(Date.now());
  const [occurred, setOccurred] = useState(() => defaultDateTime(openedAt.current));
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const request = useRef<Parameters<typeof onSave>[0] | null>(null);
  const submitting = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || busy || !online) return;
    setError("");
    if (!request.current) {
      const normalized = amountInput(amount);
      if (!normalized) {
        setError(c.invalidAmount);
        return;
      }
      const [chosenDate, chosenTime] = occurred.split("T");
      const stamp = entryTimestamp(chosenDate, openedAt.current, undefined, chosenTime);
      if (stamp === null) {
        setError(c.invalidDate);
        return;
      }
      request.current = {
        id: crypto.randomUUID(),
        direction: sharedDirectionFor(tab.you, type),
        amount: normalized,
        note: note.trim() || null,
        occurred_at_ms: stamp,
      };
    }
    submitting.current = true;
    try {
      await onSave(request.current);
    } catch (cause) {
      const waiting = uncertainResult(cause);
      setUncertain(waiting);
      if (!waiting) request.current = null;
      setError(failureMessage(cause, c));
    } finally {
      submitting.current = false;
    }
  }
  return (
    <form
      className="shared-entry-form"
      onSubmit={submit}
      aria-label={`${c.add} · ${type === "debt" ? c.gave : c.received}`}
    >
      <h4>
        {type === "debt" ? c.gave : c.received} · {tab.currency}
      </h4>
      <div className="shared-form-fields">
        <div>
          <label htmlFor={`${id}-amount`}>{c.amount}</label>
          <Input
            id={`${id}-amount`}
            inputMode="decimal"
            dir="ltr"
            required
            value={amount}
            disabled={busy || uncertain}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`${id}-date`}>{c.date}</label>
          <Input
            id={`${id}-date`}
            type="datetime-local"
            dir="ltr"
            required
            value={occurred}
            disabled={busy || uncertain}
            onChange={(event) => setOccurred(event.target.value)}
          />
        </div>
      </div>
      <label htmlFor={`${id}-note`}>{c.note}</label>
      <Input
        id={`${id}-note`}
        value={note}
        maxLength={500}
        disabled={busy || uncertain}
        onChange={(event) => setNote(event.target.value)}
      />
      {uncertain && (
        <p role="status" className="shared-notice">
          {c.uncertain}
        </p>
      )}
      {error && (
        <p role="alert" className="shared-error">
          {error}
        </p>
      )}
      <div className="shared-actions">
        <Button type="submit" variant="brand" disabled={busy || !online}>
          {busy ? c.saving : uncertain ? c.retry : c.save}
        </Button>
        <Button type="button" variant="ghost" disabled={busy || uncertain} onClick={onCancel}>
          {c.cancel}
        </Button>
      </div>
    </form>
  );
}

function PrivateHistory({
  ledger,
  person,
  currency,
  disabled,
  onEdit,
  onDelete,
}: {
  ledger: WebLedger;
  person: WebPerson;
  currency: string;
  disabled: boolean;
  onEdit?: (entry: WebEntry) => void;
  onDelete?: (entry: WebEntry) => void;
}) {
  const { lang } = useI18n();
  const c = sharedTalliesCopy[lang];
  const rows = (ledger.shared_private_entries ?? [])
    .filter(
      (entry) =>
        entry.relationship_id === person.relationship_id &&
        entry.currency === currency &&
        !entry.is_deleted,
    )
    .sort((a, b) => b.created_at - a.created_at);
  if (!rows.length) return null;
  return (
    <details className="shared-private-history">
      <summary>
        {c.privateHistory} · {rows.length}
      </summary>
      <p>{c.privateHelp}</p>
      <ol>
        {rows.map((entry) => (
          <li key={entry.id}>
            <span>
              {entry.type === "debt" ? c.gave : c.received}
              <time>{localDateValue(entry.created_at)}</time>
            </span>
            <strong dir="ltr">
              {money(minorUnits(entry.amount_afn))} {currency}
            </strong>
            {entry.disputed_at != null && (
              <p className="shared-status status-disputed">{c.disputed}</p>
            )}
            {entry.settled_at != null && <p className="shared-status">{c.settled}</p>}
            {entry.note && <p dir="auto">{entry.note}</p>}
            {!entry.read_only && (onEdit || onDelete) && (
              <div className="shared-actions">
                {onEdit && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onEdit(entry)}
                  >
                    {c.edit}
                  </Button>
                )}
                {onDelete && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onDelete(entry)}
                  >
                    {c.remove}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

function InvitationLink({ url }: { url: string }) {
  const { lang } = useI18n();
  const c = sharedTalliesCopy[lang];
  const toast = useToast();
  const id = useId();
  return (
    <div className="shared-invitation">
      <label htmlFor={id}>{c.invite}</label>
      <Input
        id={id}
        readOnly
        value={url}
        dir="ltr"
        onFocus={(event) => event.currentTarget.select()}
      />
      <p>{c.linkHelp}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard
            .writeText(url)
            .then(() => toast.push(c.copied, "success"))
            .catch(() => {});
        }}
      >
        {c.copy}
      </Button>
    </div>
  );
}

export function SharedAccountStart({ ledger, person, online, onChanged }: Props) {
  const { lang } = useI18n();
  const c = sharedTalliesCopy[lang];
  const toast = useToast();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<WebTabRecordingMode>("notify_one_way");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [invitation, setInvitation] = useState("");
  const request = useRef<WebTabGroupDraft | null>(null);
  const controller = useRef<AbortController | null>(null);
  const identity = useRef(getWebSession());
  const mounted = useRef(true);
  const working = useRef(false);
  const mutationActive = sharedContactActive(ledger, person);
  const canStart = sharedAccountCanStart(person);
  const createdBindings =
    person.shared?.tabs.filter((tab) => tab.group_id === request.current?.request_id) ?? [];
  const createdGroupClosed =
    createdBindings.length > 0 && createdBindings.every((tab) => tab.closed_at_ms != null);
  useEffect(() => {
    if (!createdGroupClosed) return;
    request.current = null;
    setInvitation("");
    setUncertain(false);
    setOpen(false);
  }, [createdGroupClosed]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (
      !online ||
      !mutationActive ||
      (!canStart && !request.current) ||
      working.current ||
      !isSameWebSession(getWebSession(), identity.current)
    )
      return;
    working.current = true;
    setBusy(true);
    setError("");
    request.current ??= newWebTabGroupDraft(getWebSession()?.user.name || "", mode);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await createWebTabGroup(ledger, person, request.current, abort.signal);
      if (
        !mounted.current ||
        abort.signal.aborted ||
        !isSameWebSession(getWebSession(), identity.current)
      )
        return;
      if (result.invite_url) setInvitation(result.invite_url);
      setUncertain(false);
      toast.push(c.saved, "success");
      await onChanged().catch(() => {});
    } catch (cause) {
      if (mounted.current && !abort.signal.aborted) {
        const waiting = uncertainResult(cause);
        setUncertain(waiting);
        if (!waiting) request.current = null;
        setError(failureMessage(cause, c));
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!canStart && !invitation && !request.current) return null;
  return (
    <div className="shared-account-start">
      {!open ? (
        <Button
          type="button"
          variant="outline"
          disabled={!online || !mutationActive}
          onClick={() => setOpen(true)}
        >
          {c.start}
        </Button>
      ) : (
        <form className="shared-entry-form" onSubmit={create}>
          <h3>{c.start}</h3>
          <p>{c.startHelp}</p>
          <label htmlFor={id}>{c.mode}</label>
          <SelectField
            id={id}
            dir={lang === "en" ? "ltr" : "rtl"}
            value={mode}
            disabled={busy || uncertain || !!invitation || !mutationActive}
            options={(["notify_one_way", "notify", "review"] as const).map((value) => ({
              value,
              label: c[value],
            }))}
            onValueChange={(value) => setMode(value as WebTabRecordingMode)}
          />
          <p>
            {mode === "review" ? c.reviewHelp : mode === "notify" ? c.notifyHelp : c.oneWayHelp}
          </p>
          {uncertain && <p role="status">{c.uncertain}</p>}
          {error && (
            <p className="shared-error" role="alert">
              {error}
            </p>
          )}
          {invitation ? (
            <InvitationLink url={invitation} />
          ) : (
            <div className="shared-actions">
              <Button type="submit" variant="brand" disabled={!online || busy || !mutationActive}>
                {busy ? c.creating : uncertain ? c.retry : c.create}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || uncertain}
                onClick={() => setOpen(false)}
              >
                {c.cancel}
              </Button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
