import type { HLC } from "./hlc";

/** Change the business day without replacing the tally's local clock time. */
export function withEntryDay(timestamp: number, day: number): number {
  const date = new Date(timestamp);
  const selected = new Date(day);
  date.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
  return date.getTime();
}

/** Positive epoch milliseconds that round-trip through JavaScript Date. */
export function isValidEntryDate(ms: number): boolean {
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 8_640_000_000_000_000;
}

/** Immutable authoring time for shared-link boundaries, independent of the
 * editable business date stored in created_at. Old rows predate the date UI
 * and retain their original created_at until their first date amendment. */
export function entryRecordedAtSql(alias: string): string {
  return `COALESCE(json_extract(${alias}.field_hlcs, '$.recorded_at_ms.pms'), ${alias}.created_at)`;
}
/** Keep date-specific registers exact on recovery, even when a newer note or
 * amount change made the row's general updated_at floor more recent. */
export function restoredEntryDateHLCs(
  fallback: string,
  entry: { created_at: number; recorded_at_ms?: number; occurred_at_hlc?: HLC },
): string {
  const fields: Record<string, HLC> = JSON.parse(fallback);
  fields.recorded_at_ms = { pms: entry.recorded_at_ms ?? entry.created_at, l: 0, did: "" };
  if (entry.occurred_at_hlc) fields.occurred_at_ms = entry.occurred_at_hlc;
  return JSON.stringify(fields);
}
