import type { WebEntry, WebLedger, WebPerson } from "../../lib/web-ledger";

export type BalanceFilter = "all" | "collect" | "pay" | "settled";

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

export function balanceMap(entries: WebEntry[], currency: string): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  for (const entry of entries) {
    if (entry.is_deleted || entry.currency !== currency) continue;
    const amount = minorUnits(String(entry.amount_afn)) * (entry.type === "debt" ? 1n : -1n);
    balances.set(entry.relationship_id, (balances.get(entry.relationship_id) ?? 0n) + amount);
  }
  return balances;
}

export function peopleInView(
  people: WebPerson[],
  balances: Map<string, bigint>,
  query: string,
  filter: BalanceFilter,
): WebPerson[] {
  const needle = asciiDigits(query).trim().toLocaleLowerCase();
  return people
    .filter((person) => {
      if (person.archived_at != null) return false;
      if (
        needle &&
        !`${person.name} ${person.phone_e164 ?? ""}`.toLocaleLowerCase().includes(needle)
      )
        return false;
      if (filter === "all") return true;
      if (person.read_only_reason === "shared_tab") return false;
      const balance = balances.get(person.relationship_id) ?? 0n;
      return filter === "collect" ? balance > 0n : filter === "pay" ? balance < 0n : balance === 0n;
    })
    .sort(
      (a, b) => a.name.localeCompare(b.name) || a.relationship_id.localeCompare(b.relationship_id),
    );
}

export function totals(people: WebPerson[], balances: Map<string, bigint>) {
  let collect = 0n,
    pay = 0n;
  for (const person of people) {
    if (person.archived_at != null || person.read_only_reason === "shared_tab") continue;
    const value = balances.get(person.relationship_id) ?? 0n;
    if (value > 0n) collect += value;
    else pay -= value;
  }
  return { collect, pay };
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
