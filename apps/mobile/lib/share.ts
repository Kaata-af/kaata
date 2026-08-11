import { Linking } from "react-native";
import { getBackendUrl } from "./api";
import { getEffectiveCalendar } from "./calendar";
import { getCurrentCurrencySymbol } from "./currency";
import { bumpUsageCounter } from "./db";
import { formatAmount } from "./format";
import { tIn, type LocaleCode } from "./i18n";
import type { Entry, Self } from "./types";

// Max entries carried in a shared snapshot. The backend caps at 500; a customer
// only needs the recent history, and it keeps the stored packet small.
const MAX_SHARED_ENTRIES = 100;
const SHARE_UPLOAD_TIMEOUT_MS = 8_000;

// Upload a small read-only snapshot of one person's ledger to the backend and
// return the public link (kaata.af/v/<token>) the customer can open to see the
// FULL ledger. Best-effort: returns null on any failure (offline / slow / error)
// so the WhatsApp share still works as a plain text message without a link.
async function uploadSharedLedger(args: {
  person: { id?: string; name: string };
  balance: number;
  entries: Entry[];
  self: Self | null;
  lang: LocaleCode;
  settled?: SettledInfo;
}): Promise<string | null> {
  const snapshot = {
    v: 1,
    shop: args.self?.shop_name ?? args.self?.name ?? "Kaata",
    person: args.person.name,
    currency: getCurrentCurrencySymbol(),
    balance: args.balance,
    // Message language, NOT the app UI language — the backend SSR shell and
    // the web CustomerView both render the /v/<token> page from this field,
    // so the page the customer opens matches the message they received.
    locale: args.lang,
    // Calendar is FROZEN INTO THE BILL at issue time, not resolved when the
    // page is opened. The paper rule (backend internal/shared/service.go) makes
    // a bill the recipient's permanent asset — a customer keeps it in a
    // WhatsApp thread for years as tamper-evidence — and the recipient has no
    // settings of ours. Resolving at view time would let a two-year-old bill
    // silently change shape when the SHOPKEEPER later flips this setting,
    // which is exactly the tampering the thread is supposed to rule out.
    //
    // Sent as a NEW field: the backend stores the payload verbatim, so old
    // snapshots simply lack it, and both renderers fall back to deriving the
    // calendar from `locale` — the pre-setting behaviour.
    calendar: getEffectiveCalendar(),
    entries: args.entries.slice(0, MAX_SHARED_ENTRIES).map((e) => ({
      type: e.type,
      amount: e.amount_afn,
      note: e.note,
      date: e.created_at,
    })),
    // Settled-chapter structure (2026-07-27): the web view collapses entries
    // dated at/before the boundary behind an "N settled accounts" row — the
    // customer sees the current account, with history one tap away. The
    // backend stores this payload verbatim (unknown fields pass through),
    // so no server change is needed; old payloads simply lack the fields.
    settled_chapters: args.settled?.settledChapters ?? 0,
    settled_boundary_ms: args.settled?.settledBoundaryMs ?? null,
    settled_boundaries: args.settled?.settledBoundaries ?? [],
    generated_at: Date.now(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHARE_UPLOAD_TIMEOUT_MS);
  try {
    const baseUrl = await getBackendUrl();
    const res = await fetch(`${baseUrl}/v1/shared`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    // PAPER RULE (2026-08-07): a shared bill is the recipient's asset —
    // permanent and unrevocable, like a paper bill handed across the counter.
    // The 2026-07-26 revocation registry (shared_links table + revoke_secret)
    // was deliberately removed; migration 026 dropped the table.
    const body = (await res.json()) as { url?: string };
    if (typeof body.url !== "string" || body.url.length === 0) return null;
    return body.url;
  } catch (err) {
    if (__DEV__) console.warn("[share] uploadSharedLedger failed (sharing without link)", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// WhatsApp ping. Wording, sign and color emoji are all framed from the
// *receiver's* perspective — banking convention, since they're the one
// reading. App's internal balance flips:
//   sender balance > 0 → receiver is debtor → "🔴 You owe: −X"
//   sender balance < 0 → receiver is creditor → "🟢 I owe you: +X"
// A short action line ("Please settle when you can." etc.) sits alongside
// the number so users who don't intuit "owe" still get a clear ask.
//
// Message body uses the caller-chosen `lang` (from share_lang_pref — may
// differ from the app UI language; most users keep the app in English but
// message in Dari). The footer now carries a link to the FULL ledger on
// kaata.af (a stored snapshot) instead of a "sent via" tagline, so the
// customer can open the complete transaction list. The link is best-effort:
// if the upload fails (offline), the message still sends without it.
// Returns true when WhatsApp opened.
/** Settled-chapter context for the ping (see person/[id].tsx settle-up). */
export type SettledInfo = {
  settledChapters: number;
  settledBoundaryMs: number | null;
  /** Every boundary (oldest→newest) so the web view can draw each dated
   *  ruled-off line, not just collapse at the latest one. */
  settledBoundaries?: number[];
};

export async function shareKaataViaWhatsApp(
  person: { id?: string; name: string; phone: string | null },
  balance: number,
  self: Self | null,
  entries: Entry[],
  lang: LocaleCode,
  settled?: SettledInfo,
): Promise<boolean> {
  const accountWith = self?.shop_name ?? self?.name ?? "Kaata";
  const currency = getCurrentCurrencySymbol();
  const amount = formatAmount(balance);
  const lines: string[] = [tIn(lang, "share.greeting", { name: person.name }), ""];

  if (balance > 0) {
    lines.push(tIn(lang, "share.theyOwe.header", { accountWith }));
    lines.push(tIn(lang, "share.theyOwe.amount", { amount, currency }));
    lines.push("");
    lines.push(tIn(lang, "share.theyOwe.cta"));
  } else if (balance < 0) {
    lines.push(tIn(lang, "share.youOwe.header"));
    lines.push(tIn(lang, "share.youOwe.amount", { amount, currency }));
    lines.push("");
    lines.push(tIn(lang, "share.youOwe.cta"));
  } else {
    lines.push(tIn(lang, "share.settled.line"));
    lines.push("");
    lines.push(tIn(lang, "share.settled.cta"));
  }

  // NOTE: the "N accounts settled together" trust line lives on the WEB page
  // only (statement card) — operator decision 2026-07-27: the prewritten
  // WhatsApp text stays short; the page carries the track record.

  // "See the full ledger on kaata.af" + link. Falls back to the plain tagline
  // when the snapshot upload couldn't produce a link (offline / error).
  const link = await uploadSharedLedger({ person, balance, entries, self, lang, settled });
  lines.push("");
  if (link) {
    lines.push(tIn(lang, "share.fullLedger"));
    lines.push(link);
  } else {
    lines.push(tIn(lang, "share.footer"));
  }

  const text = lines.join("\n");
  const phone = person.phone ? person.phone.replace(/[^0-9+]/g, "") : "";
  const url = phone
    ? `whatsapp://send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`
    : `whatsapp://send?text=${encodeURIComponent(text)}`;
  try {
    await Linking.openURL(url);
  } catch (err) {
    console.warn("[share] WhatsApp open failed", err);
    return false;
  }
  // Count only AFTER the open succeeded — bumping first inflated the
  // shares_sent telemetry on every failed attempt.
  await bumpUsageCounter("shares_sent").catch(() => undefined);
  return true;
}
