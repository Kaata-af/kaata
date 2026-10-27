import { sumAmounts } from "./money";
import {
  summarizeSelectedPeople,
  summarizeSelectionEntries,
  type SelectionFinancialSummary,
} from "./selection-summary";
import type { Entry, PersonWithBalance } from "./types";

export type CurrencySelectionSummary = { currency: string; summary: SelectionFinancialSummary };

export function personCurrencyRows(person: PersonWithBalance): readonly PersonWithBalance[] {
  return person.currency_balances?.length ? person.currency_balances : [person];
}

export function mergeCurrencyPeople(
  lists: readonly PersonWithBalance[][],
  preferred: string,
): PersonWithBalance[] {
  const grouped = new Map<string, PersonWithBalance[]>();
  for (const list of lists)
    for (const person of list) {
      const rows = grouped.get(person.id) ?? [];
      if (!rows.some((row) => row.currency === person.currency)) rows.push(person);
      grouped.set(person.id, rows);
    }
  return [...grouped.values()].map((rows) => {
    const base = rows.find((row) => row.currency === preferred) ?? rows[0];
    const active = rows.filter(
      (row) =>
        row.last_entry_at != null ||
        row.balance !== 0 ||
        row.tab_id ||
        row.tab_unsynced === 1 ||
        (row.tab_pending_count ?? 0) > 0,
    );
    const linked =
      rows.find((row) => row.tab_id && row.tab_closed_at == null) ?? rows.find((row) => row.tab_id);
    return {
      ...base,
      ...(linked ? { tab_id: linked.tab_id, tab_closed_at: linked.tab_closed_at } : {}),
      last_entry_at: Math.max(...rows.map((row) => row.last_entry_at ?? 0)) || null,
      is_settled: active.length > 0 && active.every((row) => row.is_settled === 1) ? 1 : 0,
      tab_unsynced: rows.some((row) => row.tab_unsynced === 1) ? 1 : 0,
      currency_balances: active.length ? active : [base],
    };
  });
}

export function currencyBalances(people: readonly PersonWithBalance[], fallback: string) {
  const grouped = new Map<string, PersonWithBalance[]>();
  for (const person of people)
    for (const row of personCurrencyRows(person)) {
      const code = row.currency ?? fallback;
      const rows = grouped.get(code) ?? [];
      rows.push(row);
      grouped.set(code, rows);
    }
  return [...grouped].map(([currency, rows]) => ({
    currency,
    collect: sumAmounts(
      rows.filter((row) => row.tab_unsynced !== 1 && row.balance > 0).map((row) => row.balance),
    ),
    pay: sumAmounts(
      rows.filter((row) => row.tab_unsynced !== 1 && row.balance < 0).map((row) => -row.balance),
    ),
    pending: rows.some((row) => row.tab_unsynced === 1),
  }));
}

export function selectedPeopleByCurrency(
  people: readonly PersonWithBalance[],
  fallback: string,
): CurrencySelectionSummary[] {
  const grouped = new Map<string, PersonWithBalance[]>();
  for (const person of people)
    for (const row of personCurrencyRows(person)) {
      const code = row.currency ?? fallback;
      const rows = grouped.get(code) ?? [];
      rows.push(row);
      grouped.set(code, rows);
    }
  if (!grouped.size) grouped.set(fallback, []);
  return [...grouped].map(([currency, rows]) => ({
    currency,
    summary: summarizeSelectedPeople(rows),
  }));
}

export function selectedEntriesByCurrency(
  entries: readonly Entry[],
  fallback: string,
): CurrencySelectionSummary[] {
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    const code = entry.currency ?? fallback;
    const rows = grouped.get(code) ?? [];
    rows.push(entry);
    grouped.set(code, rows);
  }
  if (!grouped.size) grouped.set(fallback, []);
  return [...grouped].map(([currency, rows]) => ({
    currency,
    summary: summarizeSelectionEntries(
      rows.map((entry) => ({
        amount: entry.amount_afn,
        currency,
        direction: entry.type === "debt" ? "collect" : "pay",
      })),
    ),
  }));
}
