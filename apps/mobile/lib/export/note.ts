// apps/mobile/lib/export/note.ts
//
// One rule, shared by the CSV and PDF statement builders: what a row's
// description says.
//
// A mutual tab's OPENING entry deliberately carries no note on the wire
// (docs/mutual-tab-design.md D7/§4.4). Its meaning is structural — "this is
// the balance that was carried over when the account became shared" — not
// something the author typed, so freezing one party's wording into a record
// the other party reads would hand a Dari customer an English sentence. Each
// surface labels it in ITS OWN language instead: the person screen's row
// (components/EntryRow.tsx), the counterparty's web page
// (internal/tabs/templates.go), the customer's bill (lib/share.ts) — and a
// statement, through here.
//
// This lives in its own module rather than in lib/export/data.ts because
// data.ts must not gain a RUNTIME edge to lib/i18n.ts: i18n pulls
// expo-localization, and money-selftest loads data.ts in plain Node, where
// initializing expo-modules-core throws. csv.ts and pdf.ts already import
// tIn, so for them this edge costs nothing.

import { tIn, type LocaleCode } from "../i18n";

/**
 * The description to print for a row, in the document's language. Any note the
 * author actually wrote wins; a tab's unlabelled opening entry gets the
 * carried-over-balance label; everything else keeps its own note (or null).
 *
 * Takes the two fields rather than a row type because the per-person
 * statement carries them as `Entry` (note + tab.kind) and the whole-kaata
 * journal as `ExportEntryRow` (note + kind).
 */
export function noteFor(
  note: string | null,
  kind: string | null | undefined,
  locale: LocaleCode,
): string | null {
  if (note != null) return note;
  if (kind === "opening") return tIn(locale, "tab.opening.note");
  return null;
}
