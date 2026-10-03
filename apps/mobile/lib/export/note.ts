// apps/mobile/lib/export/note.ts
//
// One rule, shared by the CSV and PDF statement builders: what a row's
// description says — an entry's note (noteFor) and a shared clearance
// marker's rule-off line (clearanceNote).
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

type SentenceRender = { text: (s: string) => string; value: (s: string) => string };
const PLAIN: SentenceRender = { text: (s) => s, value: (s) => s };

/**
 * The rule-off line for a SHARED clearance marker, in the document's own
 * wording: "Cleared by {name} on {date}". Never the UI chip
 * (tab.settle.history, "Cleared by {name} · {date}"): a document does not
 * reuse a chip carrying "·" (see export.doc.settledOn), and the chip's date
 * slot once carried a raw ISO time that the bidi algorithm ran into a Dari
 * name. `date` is the caller's formatSettlementDate in the statement's own
 * calendar; the exact UTC time belongs to the evidence, not this sentence.
 *
 * The name is the clearer's Google/Apple display name, so Dari script and an
 * EMPTY name are both normal (Apple can withhold it). An empty name takes its
 * own sentence instead of "Cleared by  on …", or "Not recorded" posing as a
 * name.
 *
 * `render` lets the PDF escape the template's words and isolate each value;
 * the CSV takes plain text. Values are spliced in by position, never through
 * a string replace, whose "$&" / "$'" patterns would rewrite such a name.
 */
export function clearanceNote(
  actorName: string | null | undefined,
  date: string,
  locale: LocaleCode,
  render: SentenceRender = PLAIN,
): string {
  const name = (actorName ?? "").trim();
  return tIn(locale, name ? "export.doc.clearedBy" : "export.doc.clearedUnnamed")
    .split(/(\{name\}|\{date\})/)
    .map((part) =>
      part === "{name}"
        ? render.value(name)
        : part === "{date}"
          ? render.value(date)
          : render.text(part),
    )
    .join("");
}
