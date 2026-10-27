export type SharedEntry = {
  type: "debt" | "payment";
  amount: number;
  note: string | null;
  date: number;
  currency?: string;
};

export type CurrencyStatement = {
  currency: string;
  currency_code?: string;
  balance: number;
  entries: SharedEntry[];
  settled_chapters?: number;
  settled_boundary_ms?: number | null;
  settled_boundaries?: number[];
};

type BillMetadata = {
  shop: string;
  person: string;
  locale: string;
  calendar?: string;
  qamari_offset?: number;
  generated_at: number;
};
export type SingleCurrencyBill = BillMetadata & CurrencyStatement & { v: 0 | 1 };
export type MultiCurrencyBill = BillMetadata & { v: 2; currencies: CurrencyStatement[] };
export type SharedLedger = SingleCurrencyBill | MultiCurrencyBill;

export function billCurrencyLabel(code: string | undefined, label: string): string {
  return code && !label.includes(code) ? `${code} ${label}` : label;
}

function validMoney(value: unknown): value is number {
  if (typeof value !== "number") return false;
  const minor = value * 100;
  return (
    Number.isFinite(minor) &&
    Number.isSafeInteger(Math.round(minor)) &&
    Math.abs(minor - Math.round(minor)) < 0.000001
  );
}
const validDate = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8640000000000000;

/** Legacy snapshots keep their original interpretation. V2 never has a mixed total. */
export function parseSharedLedger(raw: unknown): SharedLedger | null {
  if (!raw || typeof raw !== "object") return null;
  const bill = raw as Record<string, unknown>;
  if (typeof bill.person !== "string" || !bill.person.trim()) return null;
  if (bill.v !== 2) {
    return (bill.v == null || bill.v === 0 || bill.v === 1) && Array.isArray(bill.entries)
      ? (raw as SingleCurrencyBill)
      : null;
  }
  if (
    !Array.isArray(bill.currencies) ||
    !bill.currencies.length ||
    bill.currencies.length > 100 ||
    (Array.isArray(bill.entries) && bill.entries.length)
  )
    return null;
  const seen = new Set<string>();
  let count = 0;
  for (const candidate of bill.currencies) {
    if (!candidate || typeof candidate !== "object") return null;
    const section = candidate as Record<string, unknown>;
    const code = section.currency_code;
    if (
      typeof code !== "string" ||
      !/^[A-Z]{3}$/.test(code) ||
      seen.has(code) ||
      typeof section.currency !== "string" ||
      !section.currency.trim() ||
      !validMoney(section.balance) ||
      !Array.isArray(section.entries)
    )
      return null;
    seen.add(code);
    count += section.entries.length;
    if (count > 5000) return null;
    if (
      section.settled_chapters != null &&
      (!Number.isSafeInteger(section.settled_chapters) ||
        Number(section.settled_chapters) < 0 ||
        Number(section.settled_chapters) > 5000)
    )
      return null;
    if (section.settled_boundary_ms != null && !validDate(section.settled_boundary_ms)) return null;
    if (
      section.settled_boundaries != null &&
      (!Array.isArray(section.settled_boundaries) ||
        section.settled_boundaries.length > 5000 ||
        !section.settled_boundaries.every(validDate))
    )
      return null;
    for (const entry of section.entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        entry.currency !== code ||
        (entry.type !== "debt" && entry.type !== "payment") ||
        !validMoney(entry.amount) ||
        entry.amount < 0 ||
        !validDate(entry.date) ||
        (entry.note != null && typeof entry.note !== "string")
      )
        return null;
    }
  }
  return raw as MultiCurrencyBill;
}
