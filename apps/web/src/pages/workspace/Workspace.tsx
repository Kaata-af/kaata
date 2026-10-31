import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { BrandLogo } from "../../components/BrandLogo";
import { useToast } from "../../components/Toast";
import { useI18n, type Lang } from "../../lib/i18n";
import { createWebLive, type WebLiveState } from "../../lib/web-live";
import { createWebRefresh } from "../../lib/web-refresh";
import { createWebActivity } from "../../lib/web-activity";
import { signOut, WebApiError, type WebSession } from "../../lib/web-auth";
import {
  createWebEntry,
  createWebPerson,
  createWebVault,
  deleteWebEntry,
  getWebLedger,
  getWebWriteSupport,
  hasPendingWebWrite,
  retryPendingWebWrite,
  listWebVaults,
  updateWebEntry,
  updateWebPerson,
  type WebEntry,
  type WebLedger,
  type WebPerson,
  type WebVault,
} from "../../lib/web-ledger";
import { workspaceCopy, type WorkspaceCopy } from "./copy";
import { CreditPanel } from "./CreditPanel";
import { CurrencyPicker, CurrencySettings, EnabledCurrencies } from "./CurrencySettings";
import { EntryCalculator } from "./EntryCalculator";
import { EntryHistory } from "./EntryHistory";
import { PersonNotePanel } from "./PersonNotePanel";
import { WebProBanner } from "./WebPro";
import {
  amountInput,
  asciiDigits,
  balanceMap,
  defaultPersonEntryCurrency,
  entryTimestamp,
  localDateValue,
  localTimeValue,
  money,
  peopleInView,
  personBalances,
  statementCSV,
  totals,
  type BalanceFilter,
} from "./model";
import "./workspace.css";

type Modal =
  | { kind: "person"; person?: WebPerson }
  | { kind: "entry"; person: WebPerson; entry?: WebEntry; direction: "debt" | "payment" }
  | { kind: "delete"; entry: WebEntry }
  | { kind: "vault" };

export default function LedgerWorkspace({ session }: { session: WebSession }) {
  const { lang, setLang } = useI18n();
  const activityLocale = useRef(lang);
  activityLocale.current = lang;
  useEffect(() => {
    const activity = createWebActivity({ session, locale: () => activityLocale.current });
    return () => activity.stop();
  }, [session]);
  const c = workspaceCopy[lang];
  const toast = useToast();
  const [vaults, setVaults] = useState<WebVault[]>([]);
  const [vaultID, setVaultID] = useState("");
  const [ledger, setLedger] = useState<WebLedger | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BalanceFilter>("all");
  const [personID, setPersonID] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [errorCode, setErrorCode] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [liveState, setLiveState] = useState<WebLiveState>("connecting");
  const [modal, setModal] = useState<Modal | null>(null);
  const [currencySettings, setCurrencySettings] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [pending, setPending] = useState(hasPendingWebWrite);
  const [retrying, setRetrying] = useState(false);
  const [confirmSignout, setConfirmSignout] = useState(false);
  const activeVault = useRef(vaultID);
  activeVault.current = vaultID;
  const requestVersion = useRef(0);
  const booksVersion = useRef(0);
  const foregroundBookLoads = useRef(0);
  const automaticRefresh = useRef<ReturnType<typeof createWebRefresh> | null>(null);
  const retryAfterUntil = useRef(0);
  const supported = getWebWriteSupport();

  const selectVault = useCallback((id: string, background = false) => {
    if (id === activeVault.current) return;
    // Invalidate old reads immediately, before React renders the new selection.
    activeVault.current = id;
    requestVersion.current++;
    setLedger(null);
    setRefreshing(false);
    setLoading(!!id);
    setModal((current) => (background && current?.kind === "vault" ? current : null));
    setPersonID(null);
    setVaultID(id);
  }, []);

  useEffect(
    () => () => {
      requestVersion.current++;
      booksVersion.current++;
    },
    [],
  );

  const loadVaults = useCallback(
    async (preferred?: string, background = false) => {
      // A live hint must not replace an explicit new-book selection in flight.
      if (background && foregroundBookLoads.current) return;
      const version = ++booksVersion.current;
      if (!background) {
        foregroundBookLoads.current++;
        setLoading(true);
      }
      try {
        const books = await listWebVaults();
        if (version !== booksVersion.current) return;
        setVaults(books);
        const target = preferred || activeVault.current || session.default_vault_id;
        const next =
          books.find((book) => book.vault_id === target) ??
          books.find((book) => !book.archived_at_ms) ??
          books[0];
        const changed = next?.vault_id !== activeVault.current;
        selectVault(next?.vault_id ?? "", background);
        if (!next) {
          setLedger(null);
          setLoading(false);
          setError(false);
          setErrorCode("");
        } else if (!background && !changed) setLoading(false);
      } catch {
        if (!background && version === booksVersion.current) {
          setError(true);
          setLoading(false);
        }
      } finally {
        if (!background) foregroundBookLoads.current--;
      }
    },
    [session.default_vault_id, selectVault],
  );

  const refresh = useCallback(async (id: string, initial = false) => {
    if (!id) return;
    if (Date.now() < retryAfterUntil.current) {
      setLoading(false);
      return;
    }
    const version = ++requestVersion.current;
    if (initial) setLoading(true);
    setRefreshing(true);
    try {
      const next = await getWebLedger(id);
      if (version !== requestVersion.current || id !== activeVault.current) return;
      setLedger(next);
      setError(false);
      setErrorCode("");
      setPersonID((current) =>
        next.people.some(
          (person) => person.relationship_id === current && person.archived_at == null,
        )
          ? current
          : null,
      );
    } catch (cause) {
      if (version !== requestVersion.current || id !== activeVault.current) return;
      setError(true);
      setErrorCode(cause instanceof WebApiError ? cause.code : "");
      if (cause instanceof WebApiError && cause.status === 429) {
        const delay = Math.max(1, cause.retryAfterSeconds ?? 60) * 1_000;
        retryAfterUntil.current = Date.now() + delay;
        automaticRefresh.current?.deferFor(delay);
      }
      // Permission loss must also remove already-rendered customer information.
      if (cause instanceof WebApiError && [401, 403, 404, 410, 422].includes(cause.status)) {
        setLedger(null);
        setModal(null);
      }
    } finally {
      if (version === requestVersion.current && id === activeVault.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadVaults();
  }, [loadVaults]);
  useEffect(() => {
    setLedger(null);
    setPersonID(null);
    setQuery("");
    setFilter("all");
    setModal((current) => (current?.kind === "vault" ? current : null));
    setCurrencySettings(false);
    if (vaultID) void refresh(vaultID, true);
    return () => {
      requestVersion.current++;
    };
  }, [vaultID, refresh]);
  useEffect(() => {
    const connection = () => setOnline(navigator.onLine);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    return () => {
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
    };
  }, []);
  // The server's subscription set is captured at connection time. Reconnect
  // when membership changes so a newly created/joined kaata also sends pokes.
  const membershipKey = vaults
    .map((book) => book.vault_id)
    .sort()
    .join(",");
  useEffect(() => {
    if (!online) return;
    let stopped = false;
    const updates = createWebRefresh({
      refresh: async () => {
        if (stopped || document.hidden) return;
        const previous = activeVault.current;
        await loadVaults(undefined, true);
        if (!stopped && previous && previous === activeVault.current) await refresh(previous);
      },
    });
    const check = () => {
      if (!document.hidden) updates.request();
    };
    automaticRefresh.current = updates;
    updates.deferFor(Math.max(0, retryAfterUntil.current - Date.now()));
    const live = createWebLive({
      session,
      onChange: check,
      onState: (state) => {
        if (!stopped) setLiveState(state);
      },
    });
    const timer = window.setInterval(check, 30_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    check();
    return () => {
      stopped = true;
      if (automaticRefresh.current === updates) automaticRefresh.current = null;
      live.stop();
      updates.stop();
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [session, online, membershipKey, loadVaults, refresh]);

  const balances = useMemo(() => balanceMap(ledger?.entries ?? []), [ledger]);
  const defaultCurrency = ledger?.default_entry_currency || "AFN";
  const summary = useMemo(
    () => totals(ledger?.people ?? [], balances, defaultCurrency),
    [ledger, balances, defaultCurrency],
  );
  const people = useMemo(
    () => peopleInView(ledger?.people ?? [], balances, query, filter, lang),
    [ledger, balances, query, filter, lang],
  );
  const person = ledger?.people.find((row) => row.relationship_id === personID) ?? null;
  const canWrite =
    !!ledger &&
    ["owner", "manager", "editor", "clerk"].includes(ledger.role) &&
    !ledger.archived_at_ms &&
    online &&
    supported &&
    !error &&
    !pending;
  const canWritePerson = canWrite && !!person && !person.read_only;
  const canAmendPerson = canWritePerson && ledger?.role !== "clerk";
  const canConfigure = canWrite && !!ledger && ["owner", "manager"].includes(ledger.role);
  const canEditNote =
    canWrite && !!person && person.archived_at == null && ledger?.role !== "clerk";
  const visibleEntries = useMemo(
    () =>
      (ledger?.entries ?? [])
        .filter((entry) => !entry.is_deleted && entry.relationship_id === personID)
        .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)),
    [ledger, personID],
  );
  const selectedBalances = personBalances(balances, personID ?? "", defaultCurrency);
  const loadMessage = errorCode === "ledger_amount_unsupported" ? c.unsupportedAmount : c.loadError;

  async function loggedOut() {
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      toast.push(c.unknown, "error");
    } finally {
      setSigningOut(false);
    }
  }

  async function retrySave() {
    setRetrying(true);
    try {
      const savedVault = await retryPendingWebWrite();
      toast.push(c.saved, "success");
      await loadVaults(savedVault ?? undefined);
      if (vaultID && (!savedVault || savedVault === vaultID)) await refresh(vaultID);
    } catch (cause) {
      toast.push(mutationError(cause, c), "error");
    } finally {
      setPending(hasPendingWebWrite());
      setRetrying(false);
    }
  }

  function exportPerson() {
    if (!person || !ledger) return;
    const url = URL.createObjectURL(
      new Blob([statementCSV(person, ledger.entries, lang)], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kaata-${localDateValue()}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="workspace" dir={lang === "en" ? "ltr" : "rtl"}>
      <aside className="workspace-sidebar">
        <Link reloadDocument to="/" className="workspace-brand">
          <BrandLogo className="h-9 w-9" />
          <span>{lang === "en" ? "kaata." : "کاتا."}</span>
          <small>{c.beta}</small>
        </Link>
        <div className="workspace-book-label">{c.kaatas}</div>
        <label className="sr-only" htmlFor="workspace-vault">
          {c.kaatas}
        </label>
        <select
          id="workspace-vault"
          value={vaultID}
          onChange={(event) => selectVault(event.target.value)}
          disabled={!!modal || currencySettings || !vaults.length}
          className="workspace-book-select"
        >
          {!vaults.length && <option value="">{c.kaatas}</option>}
          {vaults.map((book) => (
            <option key={book.vault_id} value={book.vault_id}>
              {book.name}
              {book.archived_at_ms ? " · " + c.archived.split(".")[0] : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="workspace-new-book"
          onClick={() => setModal({ kind: "vault" })}
          disabled={!online || !supported || loading || pending}
        >
          <Icon name="plus" />
          {c.newKaata}
        </button>
        {ledger && (
          <div className="workspace-settings-actions">
            <button
              type="button"
              className="workspace-button"
              disabled={!canConfigure}
              onClick={() => setCurrencySettings(true)}
            >
              {c.currencySettings}
            </button>
            <CreditPanel ledger={ledger} canConfigure={canConfigure} />
          </div>
        )}
        <div className="workspace-nav-active">
          <Icon name="people" />
          {c.people}
          <span>{ledger?.people.filter((p) => p.archived_at == null).length ?? "—"}</span>
        </div>
        <div className="workspace-sidebar-note">
          <Icon name="computer" />
          <strong>{c.web}</strong>
          <p>{c.scope}</p>
          <Link to="/download">
            {c.getApp}
            <Icon name="arrow" />
          </Link>
        </div>
        <div className="workspace-account">
          <div className="workspace-avatar">
            {(session.user.name || session.user.email || "K").slice(0, 1).toLocaleUpperCase()}
          </div>
          <div className="workspace-account-name">
            <strong>{session.user.name || c.account}</strong>
            <span dir="ltr">{session.user.email || session.user.username || ""}</span>
          </div>
          <button
            type="button"
            title={c.signOut}
            aria-label={c.signOut}
            disabled={signingOut || retrying}
            onClick={() => {
              // An inline save may have queued its signed event while its
              // request is still in flight, before React's pending state updates.
              const needsConfirmation = hasPendingWebWrite();
              setPending(needsConfirmation);
              if (needsConfirmation) setConfirmSignout(true);
              else void loggedOut();
            }}
            className="workspace-icon-button"
          >
            <Icon name="logout" />
          </button>
        </div>
        <label className="sr-only" htmlFor="workspace-language">
          {c.language}
        </label>
        <select
          id="workspace-language"
          value={lang}
          onChange={(event) => setLang(event.target.value as Lang)}
          className="workspace-language"
        >
          <option value="en">English</option>
          <option value="fa">دری</option>
          <option value="ps">پښتو</option>
        </select>
      </aside>

      <main className="workspace-main">
        <header className="workspace-header">
          <div>
            <p>{c.web}</p>
            <h1>{ledger?.name || c.kaatas}</h1>
          </div>
          <div className="workspace-header-actions">
            <span
              className={`workspace-status ${!online || error ? "is-offline" : liveState !== "live" ? "is-waiting" : ""}`}
              role="status"
            >
              <i />
              {!online
                ? c.offline.split(".")[0]
                : refreshing
                  ? c.refreshing
                  : error
                    ? c.loadError.split(".")[0]
                    : liveState === "live"
                      ? c.liveUpdates
                      : liveState === "connecting"
                        ? c.connectingUpdates
                        : liveState === "reconnecting"
                          ? c.reconnectingUpdates
                          : c.periodicUpdates}
            </span>
            <button
              className="workspace-button"
              type="button"
              aria-label={c.refresh}
              disabled={refreshing || !online}
              onClick={() => {
                if (vaultID) void refresh(vaultID);
                else void loadVaults();
              }}
            >
              <Icon name="refresh" />
              <span>{c.refresh}</span>
            </button>
          </div>
        </header>
        <WebProBanner session={session} />
        {!online && <Notice>{c.offline}</Notice>}
        {error && <Notice error>{loadMessage}</Notice>}
        {pending && (
          <Notice>
            {c.pending}{" "}
            <button
              type="button"
              className="workspace-button"
              disabled={retrying || !online}
              onClick={() => void retrySave()}
            >
              {retrying ? c.saving : c.retry}
            </button>
          </Notice>
        )}
        {!supported && <Notice>{c.crypto}</Notice>}
        {ledger?.incomplete_people ? <Notice>{c.sharedNotice}</Notice> : null}
        {ledger?.archived_at_ms ? (
          <Notice>{c.archived}</Notice>
        ) : ledger?.role === "viewer" ? (
          <Notice>{c.viewer}</Notice>
        ) : null}

        {loading && !ledger ? (
          <div className="workspace-loading" role="status">
            <span className="workspace-spinner" />
            {c.loading}
          </div>
        ) : !ledger ? (
          <Empty
            icon="book"
            title={error ? loadMessage : c.noBooks}
            body={error ? c.phoneHint : c.noBooksText}
          >
            {error ? (
              <button
                className="workspace-button primary"
                onClick={() => (vaultID ? void refresh(vaultID) : void loadVaults())}
              >
                {c.retry}
              </button>
            ) : (
              <button
                className="workspace-button primary"
                disabled={!online || !supported}
                onClick={() => setModal({ kind: "vault" })}
              >
                <Icon name="plus" />
                {c.createKaata}
              </button>
            )}
          </Empty>
        ) : (
          <>
            <section className="workspace-summary" aria-label={c.balance}>
              {summary.map((row) => (
                <div className="workspace-currency-summary" key={row.currency}>
                  {(["collect", "pay"] as const).map((side) => (
                    <div className="workspace-summary-card" key={side}>
                      <span className={`workspace-direction ${side}`}>
                        <Icon name={side === "collect" ? "down" : "up"} />
                      </span>
                      <div>
                        <p>{side === "collect" ? c.totalCollect : c.totalPay}</p>
                        <strong dir="ltr">
                          {money(row[side])}
                          <small>{row.currency}</small>
                        </strong>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </section>
            <div className={`workspace-ledger ${person ? "has-selection" : ""}`}>
              <section className="workspace-people" aria-label={c.people}>
                <div className="workspace-section-heading">
                  <h2>
                    {c.people} <span>{people.length}</span>
                  </h2>
                  <button
                    type="button"
                    className="workspace-button primary"
                    disabled={!canWrite}
                    onClick={() => setModal({ kind: "person" })}
                  >
                    <Icon name="plus" />
                    {c.newPerson}
                  </button>
                </div>
                <div className="workspace-search">
                  <Icon name="search" />
                  <label htmlFor="workspace-search" className="sr-only">
                    {c.search}
                  </label>
                  <input
                    id="workspace-search"
                    type="search"
                    placeholder={c.search}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <div className="workspace-filters" aria-label={c.balance}>
                  {(["all", "collect", "pay", "settled"] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={filter === item}
                      className={filter === item ? "active" : ""}
                      onClick={() => setFilter(item)}
                    >
                      {c[item]}
                    </button>
                  ))}
                </div>
                <div className="workspace-people-list">
                  {!people.length ? (
                    <Empty
                      icon="people"
                      title={
                        ledger.people.some((p) => p.archived_at == null) ? c.noResults : c.noPeople
                      }
                      body={
                        ledger.people.some((p) => p.archived_at == null)
                          ? c.noResultsText
                          : c.noPeopleText
                      }
                    />
                  ) : (
                    people.map((row) => {
                      const rowBalances = personBalances(
                        balances,
                        row.relationship_id,
                        defaultCurrency,
                      );
                      const allClear = rowBalances.every((row) => row.balance === 0n);
                      const shared = row.read_only_reason === "shared_tab";
                      return (
                        <button
                          type="button"
                          key={row.relationship_id}
                          className={`workspace-person-row ${personID === row.relationship_id ? "selected" : ""}`}
                          aria-pressed={personID === row.relationship_id}
                          onClick={() => setPersonID(row.relationship_id)}
                        >
                          <span className="workspace-avatar">{row.name.slice(0, 1)}</span>
                          <span className="workspace-person-name">
                            <strong>{row.name}</strong>
                            <small>
                              {shared ? (
                                c.shared
                              ) : row.phone_e164 ? (
                                <bdi>{row.phone_e164}</bdi>
                              ) : allClear ? (
                                c.allClear
                              ) : (
                                c.balance
                              )}
                            </small>
                          </span>
                          <span className="workspace-person-balances">
                            {shared ? (
                              <Icon name="link" />
                            ) : (
                              rowBalances.map(({ currency, balance }) => (
                                <span
                                  key={currency}
                                  className={`workspace-person-balance ${balance > 0n ? "collect" : balance < 0n ? "pay" : ""}`}
                                >
                                  <strong dir="ltr">
                                    {money(balance)} <small>{currency}</small>
                                  </strong>
                                  <small>
                                    {balance > 0n ? c.collect : balance < 0n ? c.pay : c.allClear}
                                  </small>
                                </span>
                              ))
                            )}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
                <p className="workspace-sync-note">
                  <Icon name="cloud" />
                  {c.onlineHint}
                </p>
              </section>

              <section className="workspace-detail" aria-label={person?.name || c.history}>
                {!person ? (
                  <Empty icon="book" title={c.selectPerson} body={c.selectPersonText} />
                ) : (
                  <>
                    <button
                      type="button"
                      className="workspace-back"
                      onClick={() => setPersonID(null)}
                    >
                      <Icon name="back" />
                      {c.back}
                    </button>
                    <div className="workspace-person-header">
                      <div className="workspace-avatar large">{person.name.slice(0, 1)}</div>
                      <div>
                        <h2>{person.name}</h2>
                        {person.phone_e164 && (
                          <p>
                            <bdi>{person.phone_e164}</bdi>
                          </p>
                        )}
                      </div>
                      <button
                        className="workspace-icon-button"
                        aria-label={c.editPerson}
                        title={c.editPerson}
                        disabled={!canAmendPerson}
                        onClick={() => setModal({ kind: "person", person })}
                      >
                        <Icon name="edit" />
                      </button>
                    </div>
                    <PersonNotePanel
                      key={`${session.install_id}:${ledger.vault_id}:${person.relationship_id}`}
                      ledger={ledger}
                      person={person}
                      canEdit={canEditNote}
                      onWriteSettled={() => setPending(hasPendingWebWrite())}
                      onSaved={async () => {
                        setPending(hasPendingWebWrite());
                        if (activeVault.current === ledger.vault_id) await refresh(ledger.vault_id);
                      }}
                    />
                    <CreditPanel
                      key={`credit:${session.install_id}:${ledger.vault_id}:${person.relationship_id}`}
                      ledger={ledger}
                      person={person}
                      balances={ledger.credit_balances_complete ? selectedBalances : undefined}
                      canConfigure={canConfigure}
                      onSaved={async () => {
                        if (activeVault.current === ledger.vault_id) await refresh(ledger.vault_id);
                      }}
                    />
                    {person.read_only_reason === "shared_tab" ? (
                      <Empty icon="link" title={c.shared} body={c.sharedDetail}>
                        <Link className="workspace-button" to="/download">
                          {c.getApp}
                        </Link>
                      </Empty>
                    ) : (
                      <>
                        <div className="workspace-person-totals">
                          {selectedBalances.map(({ currency, balance }) => (
                            <div
                              key={currency}
                              className={`workspace-person-total ${balance > 0n ? "collect" : balance < 0n ? "pay" : ""}`}
                            >
                              <p>
                                {balance > 0n ? c.theyOwe : balance < 0n ? c.youOwe : c.allClear}
                              </p>
                              <strong dir="ltr">
                                {money(balance)}
                                <small>{currency}</small>
                              </strong>
                            </div>
                          ))}
                        </div>
                        <div className="workspace-entry-actions">
                          <button
                            className="workspace-button received"
                            disabled={!canWritePerson}
                            onClick={() =>
                              setModal({ kind: "entry", person, direction: "payment" })
                            }
                          >
                            <Icon name="down" />
                            {c.received}
                          </button>
                          <button
                            className="workspace-button gave"
                            disabled={!canWritePerson}
                            onClick={() => setModal({ kind: "entry", person, direction: "debt" })}
                          >
                            <Icon name="up" />
                            {c.gave}
                          </button>
                        </div>
                        <EntryHistory
                          key={`${ledger.vault_id}:${person.relationship_id}`}
                          entries={visibleEntries}
                          canAmend={canAmendPerson}
                          onExport={exportPerson}
                          onEdit={(entry) =>
                            setModal({ kind: "entry", person, entry, direction: entry.type })
                          }
                          onDelete={(entry) => setModal({ kind: "delete", entry })}
                        />
                      </>
                    )}
                  </>
                )}
              </section>
            </div>
            {!ledger.people.length && <p className="workspace-phone-hint">{c.phoneHint}</p>}
          </>
        )}
      </main>
      {confirmSignout && (
        <SignOutDialog
          c={c}
          busy={signingOut}
          onCancel={() => setConfirmSignout(false)}
          onConfirm={() => void loggedOut()}
        />
      )}
      {currencySettings && ledger && (
        <CurrencySettings
          key={ledger.vault_id}
          ledger={ledger}
          onClose={() => {
            setCurrencySettings(false);
            setPending(hasPendingWebWrite());
          }}
          onSaved={async () => {
            setCurrencySettings(false);
            setPending(hasPendingWebWrite());
            await loadVaults();
            if (activeVault.current === ledger.vault_id) await refresh(ledger.vault_id);
            toast.push(c.saved, "success");
          }}
        />
      )}
      {modal && (
        <WorkspaceModal
          key={modal.kind + ("entry" in modal ? (modal.entry?.id ?? "") : "")}
          modal={modal}
          ledger={ledger}
          c={c}
          onClose={() => {
            setModal(null);
            setPending(hasPendingWebWrite());
          }}
          onSaved={async (result) => {
            setModal(null);
            setPending(hasPendingWebWrite());
            toast.push(result.message, "success");
            if (result.vaultID) {
              await loadVaults(result.vaultID);
              if (result.vaultID === vaultID) await refresh(vaultID);
            } else {
              await refresh(vaultID);
              if (result.personID) setPersonID(result.personID);
            }
          }}
        />
      )}
    </div>
  );
}

function WorkspaceModal({
  modal,
  ledger,
  c,
  onClose,
  onSaved,
}: {
  modal: Modal;
  ledger: WebLedger | null;
  c: WorkspaceCopy;
  onClose: () => void;
  onSaved: (result: { message: string; vaultID?: string; personID?: string }) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const initialPerson = modal.kind === "person" ? modal.person : undefined;
  const entry = modal.kind === "entry" ? modal.entry : undefined;
  const [name, setName] = useState(initialPerson?.name ?? "");
  const [phone, setPhone] = useState(initialPerson?.phone_e164 ?? "");
  const [amount, setAmount] = useState(entry ? String(entry.amount_afn) : "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [openedAt] = useState(Date.now);
  const [date, setDate] = useState(localDateValue(entry?.created_at ?? openedAt));
  const [time, setTime] = useState(localTimeValue(entry?.created_at ?? openedAt));
  const [code, setCode] = useState(
    entry?.currency ??
      (modal.kind === "entry" && ledger
        ? defaultPersonEntryCurrency(ledger, modal.person)
        : modal.kind === "vault"
          ? "AFN"
          : ledger?.default_entry_currency || "AFN"),
  );
  const [direction, setDirection] = useState(modal.kind === "entry" ? modal.direction : "debt");
  const [enabledCurrencies, setEnabledCurrencies] = useState([code]);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>("input")?.focus();
    return () => element?.close();
  }, []);
  const title =
    modal.kind === "vault"
      ? c.createKaata
      : modal.kind === "delete"
        ? c.deleteTitle
        : modal.kind === "person"
          ? modal.person
            ? c.editPerson
            : c.newPerson
          : entry
            ? c.editEntry
            : direction === "debt"
              ? c.gave
              : c.received;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      if (modal.kind === "vault") {
        if (!name.trim()) throw new Error(c.nameRequired);
        const id = await createWebVault({
          name: name.trim(),
          currency: code,
          enabled_currencies: enabledCurrencies,
        });
        await onSaved({ message: c.bookCreated, vaultID: id });
      } else if (!ledger) throw new Error(c.loadError);
      else if (modal.kind === "person") {
        if (!name.trim()) throw new Error(c.nameRequired);
        const normalized = asciiDigits(phone).replace(/[\s()-]/g, "");
        if (normalized && !/^\+[1-9]\d{6,14}$/.test(normalized)) throw new Error(c.phoneInvalid);
        const value = { name: name.trim(), phone_e164: normalized || null };
        if (modal.person) {
          await updateWebPerson(ledger, modal.person, value);
          await onSaved({ message: c.saved });
        } else {
          const id = await createWebPerson(ledger, value);
          await onSaved({ message: c.personCreated, personID: id });
        }
      } else if (modal.kind === "delete") {
        await deleteWebEntry(ledger, modal.entry);
        await onSaved({ message: c.deleted });
      } else {
        const parsed = amountInput(amount);
        if (!parsed) throw new Error(c.amountInvalid);
        const occurred = entryTimestamp(date, openedAt, entry?.created_at, time);
        if (occurred === null) throw new Error(c.dateInvalid);
        // Preserve original timestamp when only amount/note changes.
        const value = {
          type: direction as "debt" | "payment",
          amount: parsed,
          currency: code,
          note: note.trim() || null,
          occurred_at_ms: occurred,
        };
        if (entry) await updateWebEntry(ledger, entry, value);
        else await createWebEntry(ledger, modal.person, value);
        await onSaved({ message: c.saved });
      }
    } catch (cause) {
      setError(mutationError(cause, c));
    } finally {
      setBusy(false);
    }
  }

  const currencies = [...new Set([code, ...(ledger?.enabled_currencies ?? [])])];
  return (
    <dialog
      ref={dialog}
      className="workspace-dialog"
      aria-labelledby="workspace-modal-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="workspace-dialog-heading">
          <h2 id="workspace-modal-title">{title}</h2>
          <button
            type="button"
            className="workspace-icon-button"
            disabled={busy}
            onClick={onClose}
            aria-label={c.close}
          >
            <Icon name="close" />
          </button>
        </div>
        {modal.kind === "delete" ? (
          <p className="workspace-dialog-description">{c.deleteText}</p>
        ) : (
          <fieldset disabled={busy}>
            {(modal.kind === "vault" || modal.kind === "person") && (
              <label>
                {modal.kind === "vault" ? c.kaataName : c.name}
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                  required
                  autoComplete="off"
                />
              </label>
            )}
            {modal.kind === "person" && (
              <label>
                {c.phone}
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  maxLength={32}
                  type="tel"
                  dir="ltr"
                  autoComplete="off"
                  placeholder="+93"
                />
                <small>{c.phoneHintInput}</small>
              </label>
            )}
            {modal.kind === "entry" && (
              <>
                <p className="workspace-dialog-person">{modal.person.name}</p>
                <div className="workspace-direction-toggle">
                  <button
                    type="button"
                    aria-pressed={direction === "payment"}
                    className={direction === "payment" ? "received" : ""}
                    onClick={() => setDirection("payment")}
                  >
                    {c.received}
                  </button>
                  <button
                    type="button"
                    aria-pressed={direction === "debt"}
                    className={direction === "debt" ? "gave" : ""}
                    onClick={() => setDirection("debt")}
                  >
                    {c.gave}
                  </button>
                </div>
                <label>
                  {c.amount}
                  <input
                    autoFocus
                    inputMode="decimal"
                    dir="ltr"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder="0.00"
                    maxLength={16}
                    required
                    autoComplete="off"
                  />
                </label>
                <EntryCalculator
                  amount={amount}
                  onApply={setAmount}
                  disabled={busy}
                  currency={code}
                />
              </>
            )}
            {(modal.kind === "vault" || modal.kind === "entry") && (
              <CurrencyPicker
                label={c.currency}
                value={code}
                codes={modal.kind === "vault" ? undefined : currencies}
                disabled={busy}
                onChange={(next) => {
                  if (modal.kind === "vault") {
                    if (!enabledCurrencies.includes(next) && enabledCurrencies.length >= 64) return;
                    setEnabledCurrencies((current) =>
                      current.includes(next) ? current : [...current, next],
                    );
                  }
                  setCode(next);
                }}
              />
            )}
            {modal.kind === "vault" && (
              <EnabledCurrencies
                value={enabledCurrencies}
                defaultCurrency={code}
                onChange={setEnabledCurrencies}
                disabled={busy}
              />
            )}
            {modal.kind === "entry" && (
              <>
                <label>
                  {c.date}
                  <input
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    min="1970-01-01"
                    max={localDateValue()}
                    required
                  />
                  <small>{c.dateHint}</small>
                </label>
                <label>
                  {c.time}
                  <input
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    required
                    dir="ltr"
                  />
                </label>
                <label>
                  {c.note}
                  <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    rows={3}
                    maxLength={500}
                  />
                </label>
              </>
            )}
          </fieldset>
        )}
        {error && (
          <p role="alert" className="workspace-form-error">
            {error}
          </p>
        )}
        <div className="workspace-dialog-footer">
          <button type="button" className="workspace-button" disabled={busy} onClick={onClose}>
            {c.cancel}
          </button>
          <button
            type="submit"
            className={`workspace-button ${modal.kind === "delete" ? "danger" : "primary"}`}
            disabled={busy}
          >
            {busy
              ? c.saving
              : modal.kind === "delete"
                ? c.deleteConfirm
                : modal.kind === "vault"
                  ? c.create
                  : c.save}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function mutationError(error: unknown, c: WorkspaceCopy): string {
  const code =
    error && typeof error === "object"
      ? "code" in error
        ? String(error.code)
        : "reason" in error
          ? String(error.reason)
          : ""
      : "";
  if (/stale|conflict/.test(code)) return c.stale;
  if (/credit/.test(code)) return c.credit;
  if (/pending/.test(code)) return c.pending;
  if (/permission|insufficient_role/.test(code)) return c.forbidden;
  if (/secure_storage|browser/.test(code)) return c.crypto;
  if (code === "duplicate_phone") return c.duplicatePhone;
  if (code === "self_phone") return c.selfPhone;
  if (code === "settled_date") return c.settledDate;
  if (code === "entry_read_only" || code === "person_read_only") return c.stale;
  if (code === "signing_key_missing" || code === "device_unverified") return c.sessionEnded;
  if (code === "invalid_amount") return c.amountInvalid;
  if (code === "invalid_phone") return c.phoneInvalid;
  if (error instanceof WebApiError) {
    if (error.status === 401) return c.sessionEnded;
    if (error.status === 403) return c.forbidden;
    return c.saveError;
  }
  if (error instanceof Error && Object.values(c).includes(error.message)) return error.message;
  return c.saveError;
}

function SignOutDialog({
  c,
  busy,
  onCancel,
  onConfirm,
}: {
  c: WorkspaceCopy;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="workspace-dialog"
      aria-labelledby="workspace-signout-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="workspace-dialog-heading">
        <h2 id="workspace-signout-title">{c.signOut}</h2>
      </div>
      <p className="workspace-dialog-description">{c.signOutPending}</p>
      <div className="workspace-dialog-footer">
        <button className="workspace-button" disabled={busy} onClick={onCancel}>
          {c.cancel}
        </button>
        <button className="workspace-button danger" disabled={busy} onClick={onConfirm}>
          {c.signOutAnyway}
        </button>
      </div>
    </dialog>
  );
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`workspace-notice ${error ? "error" : ""}`} role={error ? "alert" : "status"}>
      <Icon name="info" />
      <span>{children}</span>
    </div>
  );
}

function Empty({
  title,
  body,
  icon,
  children,
}: {
  title: string;
  body: string;
  icon: IconName;
  children?: ReactNode;
}) {
  return (
    <div className="workspace-empty">
      <span className="workspace-empty-icon">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      {children}
    </div>
  );
}

type IconName =
  | "plus"
  | "people"
  | "computer"
  | "arrow"
  | "logout"
  | "refresh"
  | "down"
  | "up"
  | "book"
  | "search"
  | "link"
  | "cloud"
  | "back"
  | "edit"
  | "download"
  | "trash"
  | "close"
  | "info";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    people: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-3-5" />
      </>
    ),
    computer: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 21h8m-4-5v5" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    logout: (
      <>
        <path d="M9 3H4v18h5m-1-9h13m-4-4 4 4-4 4" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M20 12a8 8 0 0 0-14-6M4 12a8 8 0 0 0 14 6" />
      </>
    ),
    down: <path d="M12 4v16m-6-6 6 6 6-6" />,
    up: <path d="M12 20V4M6 10l6-6 6 6" />,
    book: (
      <>
        <path d="M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm-2 14h16M8 7h7m-7 4h5" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    link: (
      <>
        <path
          d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
          transform="translate(1 1)"
        />
      </>
    ),
    cloud: <path d="M6 18a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 0 10H6Zm3-5 3 3 5-5" />,
    back: <path d="m15 5-7 7 7 7" />,
    edit: (
      <>
        <path d="m15 4 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15v6Z" />
      </>
    ),
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v.01" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
