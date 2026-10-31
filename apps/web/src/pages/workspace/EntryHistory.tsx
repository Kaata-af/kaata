import { useEffect, useId, useMemo, useState } from "react";
import { useI18n, type Lang } from "../../lib/i18n";
import type { WebEntry } from "../../lib/web-ledger";
import {
  EMPTY_HISTORY_FILTERS,
  filterEntryHistory,
  historyDateRange,
  historyFiltersActive,
  summarizeEntryHistory,
  type HistoryDatePreset,
} from "../../lib/web-history";
import { minorUnits, money } from "./model";
import "./EntryHistory.css";

const en = {
  history: "History",
  export: "Export all history",
  given: "I gave",
  received: "I received",
  whole: "All history",
  entry: "{count} entry",
  entries: "{count} entries",
  match: "{count} matching entry",
  matches: "{count} matching entries",
  search: "Search notes or exact amount",
  currency: "Currency",
  allCurrencies: "All currencies",
  dates: "Dates (Gregorian)",
  all: "All dates",
  today: "Today",
  last7: "Last 7 days",
  last30: "Last 30 days",
  month: "This month",
  custom: "Custom range",
  from: "From",
  to: "To",
  gregorian: "Dates use the Gregorian calendar. Both end dates are included.",
  dateError: "Choose a valid range with the start date before or on the end date.",
  clear: "Clear filters",
  settled: "Settled",
  settledHistory: "Settled history",
  disputed: "Disputed",
  disputedHelp: "Given/received totals and entry counts exclude disputed entries.",
  empty: "No entries yet.",
  noMatches: "No entries match these filters.",
  noCurrent: "No current entries. Earlier entries are in settled history.",
  edit: "Edit entry",
  remove: "Delete entry",
};
type Copy = { [K in keyof typeof en]: string };
const fa: Copy = {
  history: "تاریخچه",
  export: "صدور تمام تاریخچه",
  given: "دادم",
  received: "گرفتم",
  whole: "تمام تاریخچه",
  entry: "{count} ثبت",
  entries: "{count} ثبت",
  match: "{count} ثبت مطابق",
  matches: "{count} ثبت مطابق",
  search: "جستجوی یادداشت یا مبلغ دقیق",
  currency: "واحد پول",
  allCurrencies: "تمام واحدهای پول",
  dates: "تاریخ‌ها (میلادی)",
  all: "تمام تاریخ‌ها",
  today: "امروز",
  last7: "۷ روز گذشته",
  last30: "۳۰ روز گذشته",
  month: "این ماه",
  custom: "بازهٔ دلخواه",
  from: "از",
  to: "تا",
  gregorian: "تاریخ‌ها میلادی‌اند. روز آغاز و پایان نیز شامل می‌شوند.",
  dateError: "بازهٔ معتبری انتخاب کنید که تاریخ آغاز پس از پایان نباشد.",
  clear: "پاک کردن فیلترها",
  settled: "تصفیه‌شده",
  settledHistory: "تاریخچۀ تصفیه‌شده",
  disputed: "مورد اختلاف",
  disputedHelp: "در مجموع و تعداد «دادم» و «گرفتم»، ثبت‌های مورد اختلاف حساب نمی‌شوند.",
  empty: "هنوز ثبتی وجود ندارد.",
  noMatches: "هیچ ثبتی مطابق این فیلترها نیست.",
  noCurrent: "ثبت جاری وجود ندارد. ثبت‌های پیشین در تاریخچۀ تصفیه‌شده‌اند.",
  edit: "ویرایش ثبت",
  remove: "حذف ثبت",
};
const ps: Copy = {
  history: "تاریخچه",
  export: "ټوله تاریخچه صادره کړئ",
  given: "ورکړل",
  received: "واخیستل",
  whole: "ټوله تاریخچه",
  entry: "{count} ثبت",
  entries: "{count} ثبتونه",
  match: "{count} برابر ثبت",
  matches: "{count} برابر ثبتونه",
  search: "یادښت یا کره اندازه ولټوئ",
  currency: "اسعار",
  allCurrencies: "ټول اسعار",
  dates: "نېټې (میلادي)",
  all: "ټولې نېټې",
  today: "نن",
  last7: "تېرې ۷ ورځې",
  last30: "تېرې ۳۰ ورځې",
  month: "دا میاشت",
  custom: "خپله موده",
  from: "له",
  to: "تر",
  gregorian: "نېټې میلادي دي. د پیل او پای دواړه ورځې پکې شاملې دي.",
  dateError: "سمه موده وټاکئ چې د پیل نېټه له پای وروسته نه وي.",
  clear: "چاڼونه پاک کړئ",
  settled: "تصفیه شوی",
  settledHistory: "تصفیه شوې تاریخچه",
  disputed: "لانجمن",
  disputedHelp: "لانجمن ثبتونه د ورکړو او اخیستنو په مجموع او شمېر کې نه حسابېږي.",
  empty: "تراوسه ثبت نشته.",
  noMatches: "له دې چاڼونو سره برابر ثبت نشته.",
  noCurrent: "اوسني ثبتونه نشته. پخواني ثبتونه په تصفیه شوې تاریخچه کې دي.",
  edit: "ثبت سمول",
  remove: "ثبت ړنګول",
};
const copies: Record<Lang, Copy> = { en, fa, ps };
const datePresets: HistoryDatePreset[] = ["all", "today", "last7", "last30", "month", "custom"];

export function EntryHistory({
  entries,
  canAmend,
  onEdit,
  onDelete,
  onExport,
}: {
  entries: readonly WebEntry[];
  canAmend: boolean;
  onEdit: (entry: WebEntry) => void;
  onDelete: (entry: WebEntry) => void;
  onExport: () => void;
}) {
  const { lang } = useI18n();
  const c = copies[lang];
  const id = useId();
  const [filters, setFilters] = useState({ ...EMPTY_HISTORY_FILTERS });
  const [settledOpen, setSettledOpen] = useState(false);
  const active = historyFiltersActive(filters);
  const whole = useMemo(() => entries.filter((entry) => !entry.is_deleted), [entries]);
  const summary = useMemo(() => summarizeEntryHistory(entries), [entries]);
  const currencies = useMemo(
    () =>
      [
        ...new Set([
          ...whole.map((entry) => entry.currency),
          ...(filters.currency ? [filters.currency] : []),
        ]),
      ].sort(),
    [whole, filters.currency],
  );
  const matches = useMemo(() => filterEntryHistory(entries, filters), [entries, filters]);
  const current = matches.filter((entry) => entry.settled_at == null);
  const settled = matches.filter((entry) => entry.settled_at != null);
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(lang === "en" ? "en-GB" : lang === "fa" ? "fa-AF" : "ps-AF", {
        day: "numeric",
        month: "short",
        year: "numeric",
        calendar: "gregory",
      }),
    [lang],
  );
  const countFormatter = useMemo(() => new Intl.NumberFormat(lang), [lang]);
  const count = (value: number) =>
    (value === 1 ? c.entry : c.entries).replace("{count}", countFormatter.format(value));
  const range = historyDateRange(filters);

  useEffect(() => {
    setSettledOpen(active);
  }, [active, filters.query, filters.currency, filters.preset, filters.from, filters.to]);

  const rows = (values: readonly WebEntry[]) =>
    values.map((entry) => {
      const date = formatter.format(entry.created_at);
      const amount = `${money(minorUnits(String(entry.amount_afn)))} ${entry.currency}`;
      const amendable = canAmend && !entry.read_only && entry.disputed_at == null;
      return (
        <article className="entry-history-row" key={entry.id}>
          <span
            className={`entry-history-direction ${entry.type === "debt" ? "is-given" : "is-received"}`}
            aria-hidden="true"
          >
            {entry.type === "debt" ? "↑" : "↓"}
          </span>
          <div className="entry-history-description">
            <strong>{entry.type === "debt" ? c.given : c.received}</strong>
            <time dateTime={new Date(entry.created_at).toISOString()}>{date}</time>
            {entry.note && <p>{entry.note}</p>}
            <div className="entry-history-tags">
              {entry.settled_at != null && <span>{c.settled}</span>}
              {entry.disputed_at != null && <span className="is-disputed">{c.disputed}</span>}
            </div>
          </div>
          <div className="entry-history-end">
            <strong dir="ltr">
              {money(minorUnits(String(entry.amount_afn)))} <small>{entry.currency}</small>
            </strong>
            {amendable && (
              <div className="entry-history-controls">
                <button
                  type="button"
                  aria-label={`${c.edit} · ${date} · ${amount}`}
                  title={c.edit}
                  onClick={() => onEdit(entry)}
                >
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    aria-hidden="true"
                  >
                    <path d="m13 3 4 4M3 17l4-1L17 6a2.8 2.8 0 0 0-4-4L3 12v5Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label={`${c.remove} · ${date} · ${amount}`}
                  title={c.remove}
                  onClick={() => onDelete(entry)}
                >
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    aria-hidden="true"
                  >
                    <path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6m4-6v6" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </article>
      );
    });

  return (
    <section className="entry-history" aria-labelledby={`${id}-title`}>
      <header className="entry-history-heading">
        <h3 id={`${id}-title`}>
          {c.history} <span>{countFormatter.format(whole.length)}</span>
        </h3>
        <button type="button" disabled={!whole.length} onClick={onExport}>
          {c.export}
        </button>
      </header>
      {!!summary.length && (
        <div className="entry-history-summary">
          <p>{c.whole}</p>
          <table>
            <thead>
              <tr>
                <th scope="col">{c.currency}</th>
                <th scope="col">{c.given}</th>
                <th scope="col">{c.received}</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.currency}>
                  <th scope="row">
                    <bdi>{row.currency}</bdi>
                  </th>
                  <td>
                    <bdi>{money(row.given)}</bdi>
                    <small>{count(row.givenCount)}</small>
                  </td>
                  <td>
                    <bdi>{money(row.received)}</bdi>
                    <small>{count(row.receivedCount)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {whole.some((entry) => entry.disputed_at != null) && (
        <p className="entry-history-disputed-help">{c.disputedHelp}</p>
      )}
      <div className="entry-history-filters">
        <label className="entry-history-search">
          <span className="sr-only">{c.search}</span>
          <input
            type="search"
            value={filters.query}
            placeholder={c.search}
            onChange={(event) => setFilters({ ...filters, query: event.target.value })}
          />
        </label>
        <div className="entry-history-selects">
          <label>
            <span>{c.currency}</span>
            <select
              value={filters.currency}
              onChange={(event) => setFilters({ ...filters, currency: event.target.value })}
            >
              <option value="">{c.allCurrencies}</option>
              {currencies.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{c.dates}</span>
            <select
              value={filters.preset}
              onChange={(event) =>
                setFilters({ ...filters, preset: event.target.value as HistoryDatePreset })
              }
            >
              {datePresets.map((preset) => (
                <option key={preset} value={preset}>
                  {c[preset]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {filters.preset === "custom" && (
          <div className="entry-history-custom">
            <label>
              {c.from}
              <input
                type="date"
                dir="ltr"
                value={filters.from}
                onChange={(event) => setFilters({ ...filters, from: event.target.value })}
                aria-describedby={`${id}-date-hint`}
              />
            </label>
            <label>
              {c.to}
              <input
                type="date"
                dir="ltr"
                value={filters.to}
                onChange={(event) => setFilters({ ...filters, to: event.target.value })}
                aria-describedby={`${id}-date-hint`}
              />
            </label>
            <p id={`${id}-date-hint`}>{c.gregorian}</p>
            {!range.valid && (
              <p className="entry-history-date-error" role="alert">
                {c.dateError}
              </p>
            )}
          </div>
        )}
        {active && (
          <div className="entry-history-match-count">
            <span role="status">
              {(matches.length === 1 ? c.match : c.matches).replace(
                "{count}",
                countFormatter.format(matches.length),
              )}
            </span>
            <button type="button" onClick={() => setFilters({ ...EMPTY_HISTORY_FILTERS })}>
              {c.clear}
            </button>
          </div>
        )}
      </div>
      <div className="entry-history-records">
        {!whole.length ? (
          <p className="entry-history-empty">{c.empty}</p>
        ) : !matches.length ? (
          <p className="entry-history-empty">{c.noMatches}</p>
        ) : (
          <>
            {current.length ? rows(current) : <p className="entry-history-empty">{c.noCurrent}</p>}
            {!!settled.length && (
              <details
                className="entry-history-settled"
                open={settledOpen}
                onToggle={(event) => setSettledOpen(event.currentTarget.open)}
              >
                <summary>
                  {c.settledHistory} <span>{countFormatter.format(settled.length)}</span>
                </summary>
                {rows(settled)}
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}
