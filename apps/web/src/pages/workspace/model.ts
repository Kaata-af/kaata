import type { WebEntry, WebLedger, WebPerson } from "../../lib/web-ledger";

export type BalanceFilter = "all" | "collect" | "pay" | "settled";
export type PersonBalanceMap = Map<string, Map<string, bigint>>;
export type CurrencyBalance = { currency: string; balance: bigint };
export type CurrencyTotal = { currency: string; collect: bigint; pay: bigint };

export function asciiDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, (digit) =>
    String(digit.charCodeAt(0) - (digit >= "۰" ? 0x06f0 : 0x0660)),
  );
}

/** Money stays in major units on the wire; calculations use exact hundredths. */
export function minorUnits(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid ledger amount");
  return (
    (BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"))) * (match[1] ? -1n : 1n)
  );
}

export function amountInput(value: string): string | null {
  let normalized = asciiDigits(value).replace(/٫/g, ".").trim();
  if (/^\d*,\d{0,2}$/.test(normalized)) normalized = normalized.replace(",", ".");
  if (/^\.\d{1,2}$/.test(normalized)) normalized = `0${normalized}`;
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const minor = minorUnits(normalized);
  if (minor <= 0n || minor > 999_999_999_999n) return null;
  return `${minor / 100n}${minor % 100n ? `.${String(minor % 100n).padStart(2, "0")}` : ""}`;
}

export function money(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  const whole = String(magnitude / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}${magnitude % 100n ? `.${String(magnitude % 100n).padStart(2, "0")}` : ""}`;
}

export function balanceMap(entries: readonly WebEntry[]): PersonBalanceMap {
  const balances: PersonBalanceMap = new Map();
  for (const entry of entries) {
    if (entry.is_deleted) continue;
    const amount = minorUnits(String(entry.amount_afn)) * (entry.type === "debt" ? 1n : -1n);
    const currencies = balances.get(entry.relationship_id) ?? new Map<string, bigint>();
    // Keep zero rows when the person has history in that denomination.
    currencies.set(entry.currency, (currencies.get(entry.currency) ?? 0n) + amount);
    balances.set(entry.relationship_id, currencies);
  }
  return balances;
}

function currencyOrder(a: string, b: string, fallback: string): number {
  return a === b ? 0 : a === fallback ? -1 : b === fallback ? 1 : a.localeCompare(b);
}

export function personBalances(
  balances: PersonBalanceMap,
  relationshipID: string,
  fallback: string,
): CurrencyBalance[] {
  const currencies = balances.get(relationshipID);
  if (!currencies?.size) return [{ currency: fallback, balance: 0n }];
  return [...currencies]
    .map(([currency, balance]) => ({ currency, balance }))
    .sort((a, b) => currencyOrder(a.currency, b.currency, fallback));
}

const nameCollators = new Map<string, Intl.Collator>();

/** Match mobile's locale-aware names, including numbers typed in Dari/Arabic. */
function compareNames(a: string, b: string, locale: string): number {
  let collator = nameCollators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { sensitivity: "base" });
    nameCollators.set(locale, collator);
  }
  const left = asciiDigits(a).match(/\d+|\D+/g) ?? [];
  const right = asciiDigits(b).match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    let order: number;
    if (/^\d/.test(left[i]) && /^\d/.test(right[i])) {
      const x = left[i].replace(/^0+(?=\d)/, "");
      const y = right[i].replace(/^0+(?=\d)/, "");
      order = x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
    } else {
      order = collator.compare(left[i], right[i]);
    }
    if (order) return order;
  }
  return left.length - right.length || collator.compare(a, b);
}

export function peopleInView(
  people: readonly WebPerson[],
  balances: PersonBalanceMap,
  query: string,
  filter: BalanceFilter,
  locale = "en",
): WebPerson[] {
  const needle = asciiDigits(query).trim().toLocaleLowerCase(locale);
  return people
    .filter((person) => {
      if (person.archived_at != null) return false;
      if (
        needle &&
        !asciiDigits(`${person.name} ${person.phone_e164 ?? ""}`)
          .toLocaleLowerCase(locale)
          .includes(needle)
      )
        return false;
      if (filter === "all") return true;
      if (person.read_only_reason === "shared_tab") return false;
      const values = [...(balances.get(person.relationship_id)?.values() ?? [])];
      return filter === "collect"
        ? values.some((balance) => balance > 0n)
        : filter === "pay"
          ? values.some((balance) => balance < 0n)
          : values.every((balance) => balance === 0n);
    })
    .sort(
      (a, b) =>
        Number(a.is_settled === true) - Number(b.is_settled === true) ||
        (b.last_entry_at ?? b.created_at ?? 0) - (a.last_entry_at ?? a.created_at ?? 0) ||
        compareNames(a.name, b.name, locale) ||
        a.user_id.localeCompare(b.user_id) ||
        a.relationship_id.localeCompare(b.relationship_id),
    );
}

export function totals(
  people: readonly WebPerson[],
  balances: PersonBalanceMap,
  fallback: string,
): CurrencyTotal[] {
  const currencies = new Map<string, CurrencyTotal>();
  for (const person of people) {
    if (person.archived_at != null || person.read_only_reason === "shared_tab") continue;
    for (const [currency, value] of balances.get(person.relationship_id) ?? []) {
      const row = currencies.get(currency) ?? { currency, collect: 0n, pay: 0n };
      if (value > 0n) row.collect += value;
      else row.pay -= value;
      currencies.set(currency, row);
    }
  }
  const active = [...currencies.values()].filter((row) => row.collect !== 0n || row.pay !== 0n);
  return active.length
    ? active.sort((a, b) => currencyOrder(a.currency, b.currency, fallback))
    : [{ currency: fallback, collect: 0n, pay: 0n }];
}

export function ledgerCurrencies(ledger: WebLedger): string[] {
  return [
    ...new Set(
      [
        ledger.default_entry_currency,
        ...ledger.enabled_currencies,
        ...ledger.entries.map((entry) => entry.currency),
      ].filter(Boolean),
    ),
  ];
}

/** Pick only when opening a new draft; later user choices remain explicit. */
export function defaultPersonEntryCurrency(
  ledger: Pick<WebLedger, "entries" | "enabled_currencies" | "default_entry_currency">,
  person: Pick<WebPerson, "relationship_id" | "default_entry_currency">,
): string {
  const fallback = ledger.default_entry_currency;
  const override = person.default_entry_currency;
  if (override !== null)
    return /^[A-Z]{3}$/.test(override) && ledger.enabled_currencies.includes(override)
      ? override
      : fallback;
  const recorded = [
    ...new Set(
      ledger.entries
        .filter(
          (entry) =>
            entry.relationship_id === person.relationship_id &&
            !entry.is_deleted &&
            /^[A-Z]{3}$/.test(entry.currency),
        )
        .map((entry) => entry.currency),
    ),
  ];
  return recorded.length === 1 && ledger.enabled_currencies.includes(recorded[0])
    ? recorded[0]
    : fallback;
}

export function localDateValue(ms = Date.now()): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function entryDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = new Date(`${value}T12:00:00`).getTime();
  if (
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    localDateValue(timestamp) !== value ||
    value > localDateValue()
  )
    return null;
  return timestamp;
}

/** Stable across retries; today's new entries must stay after today's settlement. */
export function entryTimestamp(value: string, openedAt: number, original?: number): number | null {
  const date = entryDate(value);
  if (date === null) return null;
  if (original !== undefined && value === localDateValue(original)) return original;
  return value === localDateValue(openedAt) ? openedAt : date;
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  // A CSV opened in Excel must treat names/notes as text, never formulas.
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Only a complete, private-person statement can be exported in this release. */
export function statementCSV(person: WebPerson, entries: WebEntry[]): string {
  if (person.read_only_reason === "shared_tab")
    throw new Error("Shared statements are available in the mobile app");
  const rows: unknown[][] = [["Person", "Date", "Type", "Amount", "Currency", "Note"]];
  for (const entry of entries
    .filter((row) => row.relationship_id === person.relationship_id && !row.is_deleted)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))) {
    rows.push([
      person.name,
      localDateValue(entry.created_at),
      entry.type === "debt" ? "I gave" : "I received",
      entry.amount_afn,
      entry.currency,
      entry.note,
    ]);
  }
  return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
