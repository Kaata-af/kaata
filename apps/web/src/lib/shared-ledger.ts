export type SharedEntry = {
  id?: string;
  type: "debt" | "payment";
  amount: number;
  note: string | null;
  date: number;
  /** Immutable recording time; the separate date remains the displayed business day. */
  recorded_at_ms?: number;
  currency?: string;
};

export type SharedHistoryGroup = {
  kind: "pre_link" | "closed_shared";
  entries: SharedEntry[];
  settlements?: { after_entry_id: string | null; date: number }[] | null;
};

export type CurrencyStatement = {
  currency: string;
  currency_code?: string;
  balance: number;
  entries: SharedEntry[];
  settled_chapters?: number;
  settled_boundary_ms?: number | null;
  settled_boundaries?: number[];
  history?: SharedHistoryGroup[] | null;
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
export type MultiCurrencyBill = BillMetadata & { v: 2 | 3; currencies: CurrencyStatement[] };
export type SharedLedger = SingleCurrencyBill | MultiCurrencyBill;

export function isMultiCurrencyBill(bill: SharedLedger): bill is MultiCurrencyBill {
  return bill.v === 2 || bill.v === 3;
}

export function billCurrencyLabel(code: string | undefined, label: string): string {
  return code || label;
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

/** Older permanent bills predate recording metadata and retain their date fallback. */
export function sharedEntryRecordedAt(entry: SharedEntry): number {
  return validDate(entry.recorded_at_ms) ? entry.recorded_at_ms : entry.date;
}

/** Legacy snapshots retain their interpretation; historical V3 money stays separate. */
export function parseSharedLedger(raw: unknown): SharedLedger | null {
  if (!raw || typeof raw !== "object") return null;
  const bill = raw as Record<string, unknown>;
  if (typeof bill.person !== "string" || !bill.person.trim()) return null;
  if (bill.v !== 2 && bill.v !== 3) {
    return (bill.v == null || bill.v === 0 || bill.v === 1) && Array.isArray(bill.entries)
      ? (raw as SingleCurrencyBill)
      : null;
  }
  if (
    !Array.isArray(bill.currencies) ||
    !bill.currencies.length ||
    bill.currencies.length > 256 ||
    (Array.isArray(bill.entries) && bill.entries.length)
  )
    return null;
  const seen = new Set<string>();
  const entryIds = new Set<string>();
  const v3 = bill.v === 3;
  let count = 0;
  let markers = 0;
  const validEntry = (candidate: unknown, code: string): candidate is SharedEntry => {
    if (!candidate || typeof candidate !== "object") return false;
    const entry = candidate as Record<string, unknown>;
    if (
      entry.currency !== code ||
      (entry.type !== "debt" && entry.type !== "payment") ||
      !validMoney(entry.amount) ||
      entry.amount < 0 ||
      !validDate(entry.date) ||
      (entry.recorded_at_ms != null && !validDate(entry.recorded_at_ms)) ||
      (entry.note != null && typeof entry.note !== "string")
    )
      return false;
    if (v3) {
      if (typeof entry.id !== "string" || !entry.id.trim() || entryIds.has(entry.id)) return false;
      entryIds.add(entry.id);
    }
    return true;
  };
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
    if (!section.entries.every((entry) => validEntry(entry, code))) return null;
    if (!v3) {
      if (section.history != null) return null;
      continue;
    }
    markers +=
      Array.isArray(section.settled_boundaries) && section.settled_boundaries.length
        ? section.settled_boundaries.length
        : section.settled_boundary_ms != null
          ? 1
          : 0;
    if (markers > 5000) return null;
    if (section.history == null) continue;
    if (!Array.isArray(section.history) || section.history.length > 5000) return null;
    for (const candidateGroup of section.history) {
      if (!candidateGroup || typeof candidateGroup !== "object") return null;
      const group = candidateGroup as Record<string, unknown>;
      if (
        (group.kind !== "pre_link" && group.kind !== "closed_shared") ||
        !Array.isArray(group.entries) ||
        !group.entries.length ||
        (group.settlements != null && !Array.isArray(group.settlements))
      )
        return null;
      count += group.entries.length;
      if (count > 5000) return null;
      const positions = new Map<string, number>();
      let runningMinor = 0;
      for (const [position, entry] of group.entries.entries()) {
        if (!validEntry(entry, code)) return null;
        positions.set(entry.id!, position);
        runningMinor += (entry.type === "payment" ? -1 : 1) * Math.round(entry.amount * 100);
        if (!Number.isSafeInteger(runningMinor)) return null;
      }
      let previousPosition = -1;
      for (const marker of (group.settlements ?? []) as unknown[]) {
        if (!marker || typeof marker !== "object") return null;
        const value = marker as Record<string, unknown>;
        const position =
          value.after_entry_id == null
            ? -1
            : typeof value.after_entry_id === "string"
              ? positions.get(value.after_entry_id)
              : undefined;
        if (position === undefined || position < previousPosition || !validDate(value.date))
          return null;
        previousPosition = position;
        if (++markers > 5000) return null;
      }
    }
  }
  return raw as MultiCurrencyBill;
}
