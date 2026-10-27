import { Linking } from "react-native";
import { getBackendUrl } from "./api";
import { getEffectiveCalendar, getQamariOffset } from "./calendar";
import { getCurrentCurrencyCode, getCurrencySymbol } from "./currency";
import { assertSingleCurrency } from "./currency-totals";
import { bumpUsageCounter } from "./db";
import { formatAmount } from "./format";
import { tIn, type LocaleCode } from "./i18n";
import type { Entry, Self } from "./types";
import { countsTowardBalance } from "./export/shared-record";
import { requireCurrencyCode } from "./currency-scope";
import { toMinorUnits } from "./money";

// The public endpoint rejects an oversized bill as a whole. Never publish a
// shortened history behind a link described as the complete statement.
const MAX_SHARED_BILL_ENTRIES = 5_000;
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
  currencyCode: string;
  currencyLabel: string;
  settled?: SettledInfo;
  signal?: AbortSignal;
}): Promise<string | null> {
  const snapshot = {
    v: 1,
    shop: args.self?.shop_name ?? args.self?.name ?? "Kaata",
    person: args.person.name,
    currency: args.currencyLabel,
    currency_code: args.currencyCode,
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
    // The Qamari adjustment is frozen the same way (audit #15): a bill keeps
    // the dates it was sent with. Absent on other calendars and on old bills,
    // which every renderer reads as no adjustment.
    ...(getEffectiveCalendar() === "qamari" && getQamariOffset() !== 0
      ? { qamari_offset: getQamariOffset() }
      : {}),
    // A linked contact's rows come from the mutual tab and include voided
    // originals (struck on screen). A bill is a statement of account, not an
    // audit trail: a voided tally is not part of the account, so it is left
    // out here — the same rule lib/export applies.
    entries: args.entries.filter(countsTowardBalance).map((e) => ({
      type: e.type,
      amount: e.amount_afn,
      // A tab's opening entry stores no note (each side labels it in its
      // own language), but a bill is frozen and the recipient has none of
      // our settings — so the label is baked in here, in the language this
      // bill is being written in, or the biggest line on a permanent
      // document would have no description at all.
      note: e.note ?? (e.tab?.kind === "opening" ? tIn(args.lang, "tab.opening.note") : null),
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

  return uploadSharedSnapshot(snapshot, args.signal);
}

async function uploadSharedSnapshot(
  snapshot: object,
  signal?: AbortSignal,
  billVersion?: 2,
): Promise<string | null> {
  // Freeze the complete packet before awaiting the backend address/network.
  const body = JSON.stringify(snapshot);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), SHARE_UPLOAD_TIMEOUT_MS);
  try {
    const baseUrl = await getBackendUrl();
    if (billVersion === 2) {
      const capability = await fetch(`${baseUrl}/v1/shared/capabilities`, {
        signal: controller.signal,
      });
      if (!capability.ok) return null;
      const supported = (await capability.json()) as { bill_versions?: unknown };
      if (!Array.isArray(supported.bill_versions) || !supported.bill_versions.includes(2))
        return null;
    }
    const res = await fetch(`${baseUrl}/v1/shared`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    // PAPER RULE (2026-08-07): a shared bill is the recipient's asset —
    // permanent and unrevocable, like a paper bill handed across the counter.
    // The 2026-07-26 revocation registry (shared_links table + revoke_secret)
    // was deliberately removed; migration 026 dropped the table.
    const response = (await res.json()) as { url?: string; bill_version?: number };
    if (billVersion === 2 && response.bill_version !== 2) return null;
    if (typeof response.url !== "string" || response.url.length === 0) return null;
    return response.url;
  } catch (err) {
    if (__DEV__) console.warn("[share] uploadSharedLedger failed (sharing without link)", err);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
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

export type WhatsAppShareStage = "preparing" | "opening";

export type WhatsAppCurrencyStatement = {
  currency: string;
  balance: number;
  /** Full per-currency history, unaffected by visible search/date filters. */
  entries: readonly Entry[];
  settled?: SettledInfo;
  /** An unrestored shared cache cannot be published as a settled balance. */
  pending?: boolean;
};

/** One permanent bill with independent balances and complete currency sections.
 * The caller supplies one coherent customer snapshot; no implicit DB read can
 * expand an explicitly selected/scoped share into another set of tallies. */
export async function shareKaataCurrenciesViaWhatsApp(
  person: { id?: string; name: string; phone: string | null },
  self: Self | null,
  statements: readonly WhatsAppCurrencyStatement[],
  lang: LocaleCode,
  onStage?: (stage: WhatsAppShareStage) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const recipient = { name: person.name, phone: person.phone };
  if (statements.length === 0) throw new Error("No bill currencies");
  const codes = new Set<string>();
  const ids = new Set<string>();
  const sections = statements.map((statement) => {
    const code = requireCurrencyCode(statement.currency);
    if (codes.has(code)) throw new Error("Duplicate bill currency");
    codes.add(code);
    if (statement.pending) throw new Error("Shared bill is not fully synced");
    toMinorUnits(statement.balance);
    assertSingleCurrency(statement.entries, code);
    const symbol = getCurrencySymbol(code);
    const currency = symbol === code ? code : `${symbol} ${code}`;
    const entries = statement.entries.filter(countsTowardBalance).map((entry) => {
      if (ids.has(entry.id)) throw new Error("Duplicate bill entry");
      ids.add(entry.id);
      toMinorUnits(entry.amount_afn);
      return {
        currency: code,
        type: entry.type,
        amount: entry.amount_afn,
        note: entry.note ?? (entry.tab?.kind === "opening" ? tIn(lang, "tab.opening.note") : null),
        date: entry.created_at,
      };
    });
    return {
      currency,
      currency_code: code,
      balance: statement.balance,
      entries,
      settled_chapters: statement.settled?.settledChapters ?? 0,
      settled_boundary_ms: statement.settled?.settledBoundaryMs ?? null,
      settled_boundaries: [...(statement.settled?.settledBoundaries ?? [])],
    };
  });
  const calendar = getEffectiveCalendar();
  const qamariOffset = getQamariOffset();
  const accountWith = self?.shop_name ?? self?.name ?? "Kaata";
  const snapshot = {
    v: 2,
    shop: accountWith,
    person: person.name,
    locale: lang,
    calendar,
    ...(calendar === "qamari" && qamariOffset !== 0 ? { qamari_offset: qamariOffset } : {}),
    currencies: sections,
    generated_at: Date.now(),
  };
  const lines = [tIn(lang, "share.greeting", { name: person.name }), ""];
  if (sections.length === 1) {
    // Keep the familiar single-currency reminder wording.
    const section = sections[0];
    if (section.balance > 0)
      lines.push(
        tIn(lang, "share.theyOwe.header", { accountWith }),
        tIn(lang, "share.theyOwe.amount", {
          amount: formatAmount(section.balance),
          currency: section.currency,
        }),
        "",
        tIn(lang, "share.theyOwe.cta"),
      );
    else if (section.balance < 0)
      lines.push(
        tIn(lang, "share.youOwe.header"),
        tIn(lang, "share.youOwe.amount", {
          amount: formatAmount(section.balance),
          currency: section.currency,
        }),
        "",
        tIn(lang, "share.youOwe.cta"),
      );
    else
      lines.push(
        tIn(lang, "share.currencySettled", { currency: section.currency }),
        "",
        tIn(lang, "share.settled.cta"),
      );
  } else {
    lines.push(tIn(lang, "share.theyOwe.header", { accountWith }));
    for (const section of sections)
      lines.push(
        section.balance === 0
          ? tIn(lang, "share.currencySettled", { currency: section.currency })
          : tIn(lang, section.balance > 0 ? "share.theyOwe.amount" : "share.youOwe.amount", {
              amount: formatAmount(section.balance),
              currency: section.currency,
            }),
      );
    lines.push("");
    if (sections.some((section) => section.balance > 0)) lines.push(tIn(lang, "share.theyOwe.cta"));
    if (sections.some((section) => section.balance < 0)) lines.push(tIn(lang, "share.youOwe.cta"));
    if (sections.every((section) => section.balance === 0))
      lines.push(tIn(lang, "share.settled.cta"));
  }
  onStage?.("preparing");
  const count = sections.reduce((count, section) => count + section.entries.length, 0);
  const link =
    count > MAX_SHARED_BILL_ENTRIES ? null : await uploadSharedSnapshot(snapshot, signal, 2);
  if (signal?.aborted) return false;
  lines.push("");
  if (link) lines.push(tIn(lang, "share.fullLedger"), link);
  else lines.push(tIn(lang, "share.billUnavailable"), tIn(lang, "share.footer"));
  return openWhatsApp(recipient, lines, onStage, signal);
}

async function openWhatsApp(
  person: { phone: string | null },
  lines: readonly string[],
  onStage?: (stage: WhatsAppShareStage) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const text = lines.join("\n");
  const phone = person.phone ? person.phone.replace(/[^0-9+]/g, "") : "";
  const url = phone
    ? `whatsapp://send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`
    : `whatsapp://send?text=${encodeURIComponent(text)}`;
  onStage?.("opening");
  try {
    await Linking.openURL(url);
  } catch (err) {
    console.warn("[share] WhatsApp open failed", err);
    return false;
  }
  await bumpUsageCounter("shares_sent").catch(() => undefined);
  return true;
}

export async function shareKaataViaWhatsApp(
  person: { id?: string; name: string; phone: string | null; currency?: string },
  balance: number,
  self: Self | null,
  entries: Entry[],
  lang: LocaleCode,
  settled?: SettledInfo,
  onStage?: (stage: WhatsAppShareStage) => void,
  signal?: AbortSignal,
  currencyCode: string = getCurrentCurrencyCode(),
): Promise<boolean> {
  if (signal?.aborted) return false;
  assertSingleCurrency([person, ...entries], currencyCode);
  onStage?.("preparing");
  const accountWith = self?.shop_name ?? self?.name ?? "Kaata";
  // Freeze the selected currency before upload; changing the view while the
  // request is in flight must never relabel this permanent statement.
  const symbol = getCurrencySymbol(currencyCode);
  const currency = symbol === currencyCode ? currencyCode : `${symbol} ${currencyCode}`;
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
  const link = await uploadSharedLedger({
    person,
    balance,
    entries,
    self,
    lang,
    settled,
    signal,
    currencyCode,
    currencyLabel: currency,
  });
  // Leaving the contact cancels its pending reminder. A late upload must not
  // launch another app from the screen the user navigated to in the meantime.
  if (signal?.aborted) return false;
  lines.push("");
  if (link) {
    lines.push(tIn(lang, "share.fullLedger"));
    lines.push(link);
  } else {
    lines.push(tIn(lang, "share.footer"));
  }

  return openWhatsApp(person, lines, onStage, signal);
}
