// Pure model behind the admin Outreach section (2026-09-29; outcomes, the
// prospect queue and source exclusions added 2026-09-30). React-free so
// `node --test` can pin it: search/filter/sort/preset predicates, the
// dial-code and Afghan-carrier tables, template filling and the wa.me link,
// the "open next" picker and the awaiting-outcome strip, the CSV export, the
// optimistic patch that flips a tick before the server answers and the
// authoritative patch that takes an outcome's state as-is; since batch 3
// (2026-09-30) also the message-language resolution (and the language an
// open chat keeps), each preset's opening order and the Books list's search
// and order. Four rules shape it:
//
// - `converted` and `follow_up_due` are READ from the server, never
//   recomputed. The backend owns the 48 h rule and the install-after-contact
//   comparison; a client re-derivation on a different clock would disagree
//   with the counts on the summary cards.
// - Money stays in integer hundredths parsed from the wire's decimal string
//   ("1234.50"), the same rule as lib/money.ts on mobile. No float64 anywhere.
// - An outcome (opened, sent, no_whatsapp, invalid, skip, retry) is never
//   applied optimistically. The server checks `expected_version` and answers
//   with the row's state; a guessed state would paint as sent a chat the
//   server refused, which is the double-message the versioning exists to stop.
// - Two paths count a message (2026-09-30): the version-checked outcome
//   `sent` (every message, first or follow-up) and bulk "Mark sent", which
//   records only a FIRST message — a row that is New, Not on WhatsApp or
//   Invalid and never recorded as sent. The mark mirror counts exactly the
//   rows the server would, and the queue offers only numbers the server
//   reports as never messaged (`never_messaged`), so nothing here can paint
//   a second message.
//
// Types mirror api.ts field-for-field; nothing here is persisted except the
// enum/number preferences that `parseOutreachPreferences` admits.

import type {
  OutreachBook,
  OutreachContact,
  OutreachCounts,
  OutreachCustomer,
  OutreachExclusion,
  OutreachLang,
  OutreachMarkBody,
  OutreachNumber,
  OutreachResult,
  OutreachState,
  OutreachStatus,
  OutreachTouch,
} from "./api";
import { reportingDay } from "./dates.ts";

export const OUTREACH_STATUSES: OutreachStatus[] = [
  "new",
  "sent",
  "replied",
  "interested",
  "installed",
  "declined",
  "do_not_contact",
  "no_whatsapp",
  "invalid",
];
export const STATUS_LABELS: Record<OutreachStatus, string> = {
  new: "New",
  sent: "Sent",
  replied: "Replied",
  interested: "Interested",
  installed: "Installed",
  declined: "Declined",
  do_not_contact: "Do not contact",
  no_whatsapp: "Not on WhatsApp",
  invalid: "Invalid number",
};
export function isOutreachStatus(value: unknown): value is OutreachStatus {
  return typeof value === "string" && (OUTREACH_STATUSES as string[]).includes(value);
}
// The server's status gates (2026-09-30), mirrored so the page never offers
// what the server refuses. Stopped: Declined and Do not contact refuse
// opened, sent, not-on-WhatsApp and invalid (409 "contact stopped").
// Unreachable: Not on WhatsApp and Invalid wait for Retry. Sendable: the
// statuses a send promotes to Sent; a bulk "Mark sent" leaves every other
// row untouched.
export function isStoppedStatus(status: OutreachStatus): boolean {
  return status === "declined" || status === "do_not_contact";
}
export function isUnreachableStatus(status: OutreachStatus): boolean {
  return status === "no_whatsapp" || status === "invalid";
}
export function isSendableStatus(status: OutreachStatus): boolean {
  return status === "new" || isUnreachableStatus(status);
}
// First contact only (2026-09-30): the server's `never_messaged` — no send
// ever recorded, and every chat ever opened for the number resolved as
// "nothing sent" (skip, retry, not on WhatsApp, invalid) — plus the
// contact_count check it implies, so no state, however it was built, can
// offer a number with a recorded send. Open next, the Prospects view and the
// "Messaged before" filter all read this one predicate.
export function isNeverMessaged(contact: OutreachContact): boolean {
  return contact.outreach.never_messaged === true && contact.outreach.contact_count === 0;
}

// ---- digits, dial codes, carriers ----

// Persian (U+06F0–U+06F9) and Arabic-Indic (U+0660–U+0669) digits → ASCII, so
// a number pasted from a Dari chat matches the E.164 stored server-side.
export function normalizeDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x6f0 ? code - 0x6f0 : code - 0x660);
  });
}
export function normalizedText(value: string): string {
  return normalizeDigits(value.toLocaleLowerCase());
}
// Digits of a typed phone in international form: "0093 70…" → "9370…" and a
// ten-digit national "0700 123 456" → "93700123456" (Afghan default).
export function internationalDigits(query: string): string {
  const digits = normalizeDigits(query).replace(/\D/g, "");
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.length === 10 && digits.startsWith("0")) return `93${digits.slice(1)}`;
  return digits;
}

const DIAL_CODES: [string, string][] = [
  ["93", "Afghanistan"],
  ["61", "Australia"],
  ["1", "US/Canada"],
  ["44", "UK"],
  ["49", "Germany"],
  ["90", "Türkiye"],
  ["98", "Iran"],
  ["92", "Pakistan"],
  ["971", "UAE"],
  ["966", "Saudi Arabia"],
  ["91", "India"],
  ["7", "Russia/Kazakhstan"],
  ["33", "France"],
  ["31", "Netherlands"],
  ["46", "Sweden"],
  ["47", "Norway"],
  ["45", "Denmark"],
  ["358", "Finland"],
  ["32", "Belgium"],
  ["43", "Austria"],
  ["41", "Switzerland"],
  ["39", "Italy"],
  ["34", "Spain"],
  ["351", "Portugal"],
  ["30", "Greece"],
  ["48", "Poland"],
  ["420", "Czechia"],
  ["36", "Hungary"],
  ["40", "Romania"],
  ["380", "Ukraine"],
  ["994", "Azerbaijan"],
  ["992", "Tajikistan"],
  ["998", "Uzbekistan"],
  ["996", "Kyrgyzstan"],
  ["993", "Turkmenistan"],
  ["60", "Malaysia"],
  ["62", "Indonesia"],
  ["65", "Singapore"],
  ["81", "Japan"],
  ["82", "Korea"],
  ["86", "China"],
  ["852", "Hong Kong"],
  ["974", "Qatar"],
  ["965", "Kuwait"],
  ["973", "Bahrain"],
  ["968", "Oman"],
  ["20", "Egypt"],
  ["212", "Morocco"],
  ["27", "South Africa"],
  ["234", "Nigeria"],
  ["254", "Kenya"],
  ["55", "Brazil"],
  ["52", "Mexico"],
  ["54", "Argentina"],
];
const DIAL_BY_CODE = new Map(DIAL_CODES);

// Longest-prefix match on 3, 2, then 1 digits; an unknown code reads as its
// own "+NNN" so the filter still groups it.
export function dialCode(phone: string): { code: string; country: string } {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return { code: "", country: "" };
  for (const length of [3, 2, 1]) {
    const code = digits.slice(0, length);
    const country = DIAL_BY_CODE.get(code);
    if (code.length === length && country) return { code: `+${code}`, country };
  }
  const code = `+${digits.slice(0, 3)}`;
  return { code, country: code };
}

export const AFGHAN_CARRIERS = ["AWCC", "Roshan", "Etisalat", "MTN", "Salaam", "Other"] as const;
export type AfghanCarrier = (typeof AFGHAN_CARRIERS)[number];
// The two digits after +93 name the network; "" for any other country.
export function afghanCarrier(phone: string): AfghanCarrier | "" {
  if (dialCode(phone).code !== "+93") return "";
  const prefix = phone.replace(/\D/g, "").slice(2, 4);
  if (prefix === "70" || prefix === "71") return "AWCC";
  if (prefix === "72" || prefix === "79") return "Roshan";
  if (prefix === "73" || prefix === "78") return "Etisalat";
  if (prefix === "76" || prefix === "77") return "MTN";
  if (prefix === "74" || prefix === "75") return "Salaam";
  return "Other";
}

// ---- money (integer hundredths, decimal strings on the wire) ----

export function parseMoney(value: string | null | undefined): number {
  const match = /^(-)?(\d+)(?:\.(\d{0,2})\d*)?$/.exec(String(value ?? "").trim());
  if (!match) return 0;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -cents : cents;
}
export function formatMoney(hundredths: number, grouped = false): string {
  const sign = hundredths < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(hundredths));
  const major = Math.trunc(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${grouped ? major.toLocaleString("en-US") : String(major)}.${minor}`;
}

// Per-currency totals across a customer's listings. `owes` = the person owes
// the shop (positive balances); `owed` = the shop owes the person. Mixed
// currencies are never summed into one number.
export type BalanceSummary = { currency: string; owes: number; owed: number; listings: number };
export function balanceSummary(customer: OutreachCustomer | null | undefined): BalanceSummary[] {
  if (!customer) return [];
  const byCurrency = new Map<string, BalanceSummary>();
  for (const listing of customer.listings) {
    const currency = listing.currency || "";
    const entry = byCurrency.get(currency) ?? { currency, owes: 0, owed: 0, listings: 0 };
    const balance = parseMoney(listing.balance);
    if (balance > 0) entry.owes += balance;
    else if (balance < 0) entry.owed -= balance;
    entry.listings += 1;
    byCurrency.set(currency, entry);
  }
  return [...byCurrency.values()];
}

// ---- messages: audience, language, templates, wa.me ----

export type Audience = "shopkeeper" | "customer";
export type MessageLanguage = "en" | "fa";
export const LANGUAGE_NAMES: Record<MessageLanguage, string> = { fa: "Dari", en: "English" };

export function audienceFor(contact: OutreachContact): Audience {
  return contact.kind === "customer" ? "customer" : "shopkeeper";
}
// The message language lives on the server (2026-09-30, batch 3), never in
// page memory, so every tab and device writes the same message: a
// session-wide choice in the outreach setting `pref.message_lang` (Dari when
// unset or unknown) and a per-number choice, `outreach.lang`, that wins over
// it. "Auto" is the locale rule below.
export type SessionLanguage = MessageLanguage | "auto";
export const SESSION_LANGUAGE_KEY = "pref.message_lang";
export const SESSION_LANGUAGE_OPTIONS: [SessionLanguage, string][] = [
  ["fa", "Dari"],
  ["en", "English"],
  ["auto", "Auto (each shop's app language)"],
];
export function sessionLanguage(settings: Record<string, string>): SessionLanguage {
  const value = settings[SESSION_LANGUAGE_KEY];
  return value === "en" || value === "auto" ? value : "fa";
}
export function isOutreachLang(value: unknown): value is OutreachLang {
  return value === "" || value === "en" || value === "fa";
}
// Auto: Dari for a fa or prs locale — the shop's app language (the
// shopkeeper's own install, else the first listing owner's) — else English.
export function localeLanguage(locale: string): MessageLanguage {
  const lower = (locale || "").toLowerCase();
  return lower.startsWith("fa") || lower.startsWith("prs") ? "fa" : "en";
}
// One contact's language: the per-number choice when set, else the session
// choice, else (Auto) the locale rule.
export function messageLanguage(
  contact: OutreachContact,
  settings: Record<string, string>,
): MessageLanguage {
  const own = contact.outreach.lang;
  if (own === "fa" || own === "en") return own;
  const session = sessionLanguage(settings);
  return session === "auto" ? localeLanguage(contact.locale) : session;
}
// What "Use session choice (…)" names for one number: the session's language,
// or on Auto what the locale rule picks for this number ("Auto: Dari").
export function sessionChoiceLabel(session: SessionLanguage, locale: string): string {
  return session === "auto"
    ? `Auto: ${LANGUAGE_NAMES[localeLanguage(locale)]}`
    : LANGUAGE_NAMES[session];
}

export const DEFAULT_TEMPLATES: Record<string, string> = {
  "template.shopkeeper.en":
    "Salaam {name}. This is the Kaata team. Thanks for installing Kaata. Here is a short guide to adding customers and sending them their balance on WhatsApp:\n{link}\nReply here if you need any help.",
  "template.shopkeeper.fa":
    "سلام {name}. از تیم کاتا هستیم. تشکر که کاتا را نصب کردید. این رهنمای کوتاه نشان می‌دهد چطور مشتری اضافه کنید و باقی‌مانده‌اش را در واتساپ برایش بفرستید:\n{link}\nاگر کمک لازم داشتید، همین‌جا جواب بدهید.",
  "template.customer.en":
    "Salaam. Kaata is a free app for keeping shop accounts — who owes what — and sending each person their balance on WhatsApp. Short guide and install link:\n{link}",
  "template.customer.fa":
    "سلام. کاتا یک اپ رایگان برای نگهداری حساب دکان است — چه کسی چقدر قرضدار است — و باقی‌مانده هر کس را در واتساپ برایش می‌فرستد. رهنمای کوتاه و لینک نصب:\n{link}",
};
export const DEFAULT_SLUGS: Record<Audience, string> = {
  shopkeeper: "wa-shop",
  customer: "wa-cust",
};

// ---- numbers (libphonenumber verdicts from the backend) ----

// The backend describes every number with the numbering plan
// (nyaruka/phonenumbers). An older backend omits the block; the default reads
// as VALID so a missing verdict never hides a row — only a real "false" does.
// Validity says nothing about WhatsApp: that is the operator-recorded status
// `no_whatsapp`.
export const DEFAULT_OUTREACH_NUMBER: OutreachNumber = {
  valid: true,
  possible: true,
  type: "unknown",
  region: "",
  national: "",
};
export function isMobileNumber(number: OutreachNumber): boolean {
  return number.type === "mobile" || number.type === "fixed_line_or_mobile";
}
export function numberTypeLabel(type: string): string {
  if (!type || type === "unknown") return "";
  if (type === "fixed_line_or_mobile") return "fixed or mobile";
  return type.replace(/_/g, " ");
}
// "AF · mobile": what the numbering plan reports, "" when it reports nothing.
export function numberCaption(number: OutreachNumber): string {
  return [number.region, numberTypeLabel(number.type)].filter(Boolean).join(" · ");
}

export function templateKey(audience: Audience, language: MessageLanguage): string {
  return `template.${audience}.${language}`;
}
export function slugKey(audience: Audience): string {
  return `slug.${audience}`;
}
// Same rule as Campaigns.sanitizeSlug: lowercase, spaces → hyphens, only
// URL-unreserved characters, 40 max.
export function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._~-]/g, "")
    .slice(0, 40);
}
export function linkFor(settings: Record<string, string>, audience: Audience): string {
  const slug = sanitizeSlug(settings[slugKey(audience)] ?? "") || DEFAULT_SLUGS[audience];
  return `https://kaata.af/download?s=${slug}`;
}
export function templateFor(
  settings: Record<string, string>,
  audience: Audience,
  language: MessageLanguage,
): string {
  const key = templateKey(audience, language);
  const saved = settings[key];
  return saved && saved.trim() ? saved : DEFAULT_TEMPLATES[key];
}

function tidyLine(line: string, name: string, shop: string): string {
  return line
    .replace(/\{name\}/g, name)
    .replace(/\{shop\}/g, shop)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,!?:;،؛؟])/g, "$1")
    .trim();
}
// `{link}` always ends up ALONE on its own line (WhatsApp previews and opens
// it only then); a template without the placeholder gets the link appended.
// A missing name collapses "Salaam {name}." to "Salaam.".
export function fillTemplate(
  template: string,
  vars: { name: string; shop: string; link: string },
): string {
  const name = (vars.name || "").trim();
  const shop = (vars.shop || "").trim();
  const out: string[] = [];
  let linked = false;
  for (const raw of template.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.includes("{link}")) {
      out.push(tidyLine(raw, name, shop));
      continue;
    }
    raw.split("{link}").forEach((part, index) => {
      if (index > 0) {
        out.push(vars.link);
        linked = true;
      }
      const text = tidyLine(part, name, shop);
      if (text) out.push(text);
    });
  }
  if (!linked && vars.link) out.push(vars.link);
  return out.join("\n");
}
export function waLink(phone: string, message: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`;
}

export type BuiltMessage = {
  audience: Audience;
  language: MessageLanguage;
  templateKey: string;
  link: string;
  text: string;
};
// The message for one contact in its resolved language (messageLanguage);
// `templateKey` (template.<audience>.<lang>) is what an opened or sent
// outcome records.
export function buildMessage(
  contact: OutreachContact,
  settings: Record<string, string>,
): BuiltMessage {
  const audience = audienceFor(contact);
  const language = messageLanguage(contact, settings);
  const link = linkFor(settings, audience);
  return {
    audience,
    language,
    templateKey: templateKey(audience, language),
    link,
    text: fillTemplate(templateFor(settings, audience, language), {
      name: contact.name,
      shop: contact.shop_name,
      link,
    }),
  };
}
// An open chat keeps the language it was opened in (2026-09-30). The text in
// the WhatsApp tab was prefilled when the chat opened, so that is what goes
// out, whatever the session or the number's own language says by the time
// Sent is pressed. While a contact is pending, its newest "opened" touch
// (touches arrive newest first) names that template, and `sent` records the
// same key. A detail that is not a template key reads as undefined; the
// caller then falls back to the current resolution (buildMessage).
const TEMPLATE_KEY = /^template\.(shopkeeper|customer)\.(en|fa)$/;
export function openedTemplateKey(contact: OutreachContact): string | undefined {
  if (!isPending(contact)) return undefined;
  const opened = contact.outreach.touches.find((touch) => touch.kind === "opened");
  return opened && TEMPLATE_KEY.test(opened.detail) ? opened.detail : undefined;
}
// The language a template key names ("template.customer.fa" → "fa").
export function templateLanguage(key: string): MessageLanguage | undefined {
  const match = TEMPLATE_KEY.exec(key);
  return match ? (match[2] as MessageLanguage) : undefined;
}

// ---- row helpers ----

export function contactDisplayName(contact: OutreachContact): string {
  return contact.name || contact.shop_name || contact.phone;
}
export function contactInitials(contact: OutreachContact): string {
  const source = contact.name || contact.shop_name;
  if (!source) return "#";
  return source
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toUpperCase();
}
export function kindLabel(kind: OutreachContact["kind"]): string {
  return kind === "shopkeeper" ? "Shopkeeper" : kind === "customer" ? "Customer" : "Both";
}
export function languageLabel(locale: string): string {
  if (!locale || locale === "__unknown__") return "Unknown";
  const lower = locale.toLowerCase();
  if (lower === "fa") return "Dari (fa)";
  if (lower === "en") return "English (en)";
  return locale;
}
export function platformLabel(platform: string): string {
  const lower = (platform || "").toLowerCase();
  if (lower === "ios") return "iOS";
  if (lower === "android") return "Android";
  return platform && platform !== "__unknown__" ? platform : "Unknown";
}
function parseTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}
export function lastTallyAt(contact: OutreachContact): string {
  const candidates = [
    contact.shopkeeper?.last_tally_at ?? "",
    contact.customer?.last_tally_at ?? "",
  ];
  let best = "";
  let bestTime: number | null = null;
  for (const iso of candidates) {
    const time = parseTime(iso);
    if (time !== null && (bestTime === null || time > bestTime)) {
      best = iso;
      bestTime = time;
    }
  }
  return best;
}
export function totalTallies(contact: OutreachContact): number {
  return (contact.shopkeeper?.tallies ?? 0) + (contact.customer?.tallies_total ?? 0);
}
// Owner names of the books a customer appears in, deduplicated, for the
// second line of a customer row.
export function ownerNames(customer: OutreachCustomer | null | undefined): string[] {
  if (!customer) return [];
  return [
    ...new Set(
      customer.listings.map((listing) => listing.owner_name || listing.vault_name).filter(Boolean),
    ),
  ];
}
export function listingsSummary(customer: OutreachCustomer | null | undefined): string {
  if (!customer) return "";
  return customer.listings
    .map((listing) => {
      const owner = listing.owner_name || listing.owner_phone;
      return owner ? `${listing.vault_name} (${owner})` : listing.vault_name;
    })
    .join(" · ");
}

export type PillTone = "green" | "amber" | "gray" | "red" | "blue";
export type ContactPill = { label: string; tone: PillTone; caption?: string };
// Every pill comes straight from a server flag or field — nothing here is
// re-derived. "Skipped today" is the one pill that needs the clock: a skip is
// a Kabul-day fact, not a stored flag.
export function contactPills(contact: OutreachContact, now: number): ContactPill[] {
  const pills: ContactPill[] = [
    { label: kindLabel(contact.kind), tone: contact.kind === "customer" ? "gray" : "blue" },
  ];
  if (!contact.number.valid)
    pills.push({
      label: "Invalid number",
      tone: "red",
      caption: numberCaption(contact.number) || undefined,
    });
  if (contact.customer?.is_wholesaler) pills.push({ label: "Wholesaler", tone: "amber" });
  if (contact.kind === "both") pills.push({ label: "Already a user", tone: "green" });
  if (contact.converted) pills.push({ label: "Converted", tone: "green" });
  if (contact.follow_up_due) pills.push({ label: "Follow-up due", tone: "amber" });
  if (isPending(contact)) pills.push({ label: "Awaiting outcome", tone: "amber" });
  if (isSkippedToday(contact, now)) pills.push({ label: "Skipped today", tone: "gray" });
  if (contact.outreach.status === "no_whatsapp")
    pills.push({ label: "Not on WhatsApp", tone: "gray" });
  // The operator's verdict, distinct from the numbering plan's above.
  if (contact.outreach.status === "invalid") pills.push({ label: "Marked invalid", tone: "gray" });
  if (contact.outreach.status === "do_not_contact")
    pills.push({ label: "Do not contact", tone: "red" });
  return pills;
}

// ---- the queue: pending, skipped, prospects, open next ----

// "Pending" = a chat was opened and no outcome has been recorded since. It is
// server state (pending_since), so a closed tab or a crashed browser cannot
// lose it, and the strip that lists these survives a reload. A missing field
// (older backend) reads as not pending.
export function isPending(contact: OutreachContact): boolean {
  return !!contact.outreach.pending_since;
}
// "Skip for now" hides a row for the rest of the Kabul reporting day; it comes
// back tomorrow on its own. No session table, no unskip button.
export function isSkippedToday(contact: OutreachContact, now: number): boolean {
  const day = reportingDay(contact.outreach.skipped_at);
  return day !== "" && day === reportingDay(now);
}
// The resumable prospect queue: customer-only numbers (no install matched),
// still New, never messaged (isNeverMessaged: a number reset to New after a
// send, or after a chat that was opened and never closed as nothing sent, is
// not a prospect), plausible per the numbering plan and a mobile number
// (2026-09-30: the plan's mobile or fixed-or-mobile, isMobileNumber, the
// same test as the "Number type: Mobile" filter), not archived everywhere,
// not awaiting an outcome, not skipped today; Afghanistan unless told
// otherwise. The country test uses the same dial-code lookup as the country
// filter so this predicate and `presetFilters("prospects")` select identical
// rows.
export function isProspect(contact: OutreachContact, now: number, country = "+93"): boolean {
  return (
    contact.kind === "customer" &&
    contact.outreach.status === "new" &&
    isNeverMessaged(contact) &&
    contact.number.valid &&
    isMobileNumber(contact.number) &&
    !contact.converted &&
    !contact.customer?.archived_everywhere &&
    !isPending(contact) &&
    !isSkippedToday(contact, now) &&
    (country ? dialCode(contact.phone).code === country : true)
  );
}
// What "Open next" may pick: New and never messaged (isNeverMessaged, first
// contact only), valid, not awaiting an outcome, not skipped today, not seen
// installing after an earlier contact. Declined, do-not-contact,
// not-on-WhatsApp and invalid rows are never New, so they fall out without a
// special case.
export function canOpen(contact: OutreachContact, now: number): boolean {
  return (
    contact.outreach.status === "new" &&
    isNeverMessaged(contact) &&
    contact.number.valid &&
    !isPending(contact) &&
    !isSkippedToday(contact, now) &&
    !contact.converted
  );
}
// The "Open next" target: the first openable row of the CURRENT view, in its
// sort order.
export function nextToOpen(rows: OutreachContact[], now: number): OutreachContact | undefined {
  return rows.find((contact) => canOpen(contact, now));
}
export function openableCount(rows: OutreachContact[], now: number): number {
  return rows.filter((contact) => canOpen(contact, now)).length;
}
// Whether a row offers the manual WhatsApp button at all (unlike canOpen,
// which is Open next's picker): never for a stopped row (the server refuses
// it until the status changes) nor an unreachable one (Retry first). An
// invalid-per-plan number keeps the button as a deliberate manual override.
export function offersChat(contact: OutreachContact): boolean {
  const status = contact.outreach.status;
  return !isStoppedStatus(status) && !isUnreachableStatus(status);
}
// Every chat opened without an outcome yet, across ALL contacts (not the
// current view), oldest first, so the longest-waiting chat is at the top.
export function pendingRows(contacts: OutreachContact[]): OutreachContact[] {
  return contacts
    .filter(isPending)
    .sort(
      (a, b) =>
        (parseTime(a.outreach.pending_since) ?? 0) - (parseTime(b.outreach.pending_since) ?? 0) ||
        a.phone.localeCompare(b.phone),
    );
}

// ---- filters, presets, search, sort ----

export type OutreachFilters = {
  kind: "all" | "shopkeeper" | "customer" | "both";
  status: "all" | OutreachStatus | "declined_any" | "unreachable";
  country: string;
  carrier: "" | AfghanCarrier;
  platform: string;
  language: string;
  source: string;
  signedIn: "all" | "yes" | "no";
  onboarded: "all" | "yes" | "no";
  alreadyUser: "all" | "yes" | "no";
  direction: "all" | "customer" | "supplier";
  archived: "hide" | "show" | "only";
  lastSeen: "all" | "7d" | "30d" | "older" | "never";
  contactedFrom: string;
  contactedTo: string;
  replied: "all" | "yes" | "no";
  followUp: "all" | "due";
  converted: "all" | "yes";
  wholesaler: "all" | "yes";
  // Numbering-plan verdict (libphonenumber), not WhatsApp use.
  validity: "all" | "valid" | "invalid";
  // mobile = mobile or fixed_line_or_mobile; fixed = fixed_line only.
  numberType: "all" | "mobile" | "fixed";
  // Opened with no outcome recorded since.
  pending: "all" | "yes" | "no";
  // "Skip for now" within the current Kabul day.
  skipped: "all" | "hide" | "only";
  // Messaged before: never = never messaged (isNeverMessaged, the queue's
  // own test); ever = a recorded send, or a chat opened and not closed as
  // nothing sent.
  contacted: "all" | "never" | "ever";
  minMentions: number;
  minTallies: number;
  minReceivable: number;
};
export const DEFAULT_OUTREACH_FILTERS: OutreachFilters = {
  kind: "all",
  status: "all",
  country: "",
  carrier: "",
  platform: "",
  language: "",
  source: "",
  signedIn: "all",
  onboarded: "all",
  alreadyUser: "all",
  direction: "all",
  archived: "hide",
  lastSeen: "all",
  contactedFrom: "",
  contactedTo: "",
  replied: "all",
  followUp: "all",
  converted: "all",
  wholesaler: "all",
  validity: "all",
  numberType: "all",
  pending: "all",
  skipped: "all",
  contacted: "all",
  minMentions: 0,
  minTallies: 0,
  minReceivable: 0,
};
export const FILTER_ENUMS = {
  kind: ["all", "shopkeeper", "customer", "both"],
  status: ["all", ...OUTREACH_STATUSES, "declined_any", "unreachable"],
  carrier: ["", ...AFGHAN_CARRIERS],
  signedIn: ["all", "yes", "no"],
  onboarded: ["all", "yes", "no"],
  alreadyUser: ["all", "yes", "no"],
  direction: ["all", "customer", "supplier"],
  archived: ["hide", "show", "only"],
  lastSeen: ["all", "7d", "30d", "older", "never"],
  replied: ["all", "yes", "no"],
  followUp: ["all", "due"],
  converted: ["all", "yes"],
  wholesaler: ["all", "yes"],
  validity: ["all", "valid", "invalid"],
  numberType: ["all", "mobile", "fixed"],
  pending: ["all", "yes", "no"],
  skipped: ["all", "hide", "only"],
  contacted: ["all", "never", "ever"],
} as const;

// `order` is the sentence a description spends on the preset's opening order
// (presetSort); presetDescription shows it only while that order is the one
// on screen (2026-09-30).
export const OUTREACH_PRESETS = [
  {
    id: "all",
    label: "All",
    description: "Every number the server knows, except customers archived in every book.",
  },
  {
    id: "prospects",
    label: "Prospects",
    description:
      "Customer-only mobile numbers, status New, never messaged (no send recorded, every opened chat closed as nothing sent), valid, not awaiting an outcome, not skipped today; Afghanistan by default (change the country filter).",
    order: "Newest tally first.",
  },
  {
    id: "shopkeepers",
    label: "Shopkeepers",
    description: "Numbers that come from installs and accounts only.",
  },
  {
    id: "customers",
    label: "Customers",
    description: "Numbers that appear only inside synced books, never as an install.",
    order: "Newest tally first.",
  },
  {
    id: "wholesalers",
    label: "Wholesalers",
    description: "Listed in two or more books, or recorded as a supplier anywhere.",
    order: "Newest tally first.",
  },
  { id: "to_contact", label: "To contact", description: "Status New — nothing sent yet." },
  {
    id: "pending",
    label: "Awaiting outcome",
    description: "Chats opened with no outcome recorded yet.",
  },
  {
    id: "follow_ups",
    label: "Follow-ups due",
    description: "Sent 48 hours ago or more with no reply.",
  },
  { id: "sent", label: "Sent", description: "A message went out; no reply yet." },
  { id: "replied", label: "Replied", description: "They answered." },
  { id: "interested", label: "Interested", description: "Marked interested by hand." },
  { id: "installed", label: "Installed", description: "Marked installed by hand." },
  { id: "declined", label: "Declined", description: "Declined or do not contact." },
  {
    id: "unreachable",
    label: "Unreachable",
    description: "Not on WhatsApp or invalid number — Retry puts a row back in the queue.",
  },
] as const;
export type OutreachPreset = (typeof OUTREACH_PRESETS)[number]["id"];

// Prospecting presets (all, prospects, shopkeepers, customers, wholesalers,
// to_contact) hide customers archived in every book; the status, pending and
// follow-up presets show them, so a conversation already in progress never
// vanishes from its queue because a shopkeeper archived the person meanwhile.
export function presetFilters(preset: OutreachPreset): OutreachFilters {
  const base = { ...DEFAULT_OUTREACH_FILTERS };
  const tracking: OutreachFilters = { ...base, archived: "show" };
  switch (preset) {
    case "prospects":
      return {
        ...base,
        kind: "customer",
        status: "new",
        country: "+93",
        validity: "valid",
        numberType: "mobile",
        pending: "no",
        skipped: "hide",
        contacted: "never",
      };
    case "shopkeepers":
      return { ...base, kind: "shopkeeper" };
    case "customers":
      return { ...base, kind: "customer" };
    case "wholesalers":
      return { ...base, wholesaler: "yes" };
    case "to_contact":
      return { ...base, status: "new" };
    case "pending":
      return { ...tracking, pending: "yes" };
    case "unreachable":
      return { ...tracking, status: "unreachable" };
    case "follow_ups":
      return { ...tracking, followUp: "due" };
    case "sent":
      return { ...tracking, status: "sent" };
    case "replied":
      return { ...tracking, status: "replied" };
    case "interested":
      return { ...tracking, status: "interested" };
    case "installed":
      return { ...tracking, status: "installed" };
    case "declined":
      return { ...tracking, status: "declined_any" };
    default:
      return base;
  }
}
// The "Installed after contact" card is not a preset tab; it applies the
// default view narrowed to converted rows.
export const CONVERTED_FILTERS: OutreachFilters = { ...DEFAULT_OUTREACH_FILTERS, converted: "yes" };
// Matches on filters only: a sort changed on top of a preset keeps its tab.
export function activePreset(filters: OutreachFilters): OutreachPreset | undefined {
  return OUTREACH_PRESETS.find((p) => {
    const preset = presetFilters(p.id);
    return (Object.keys(preset) as (keyof OutreachFilters)[]).every(
      (key) => preset[key] === filters[key],
    );
  })?.id;
}

// A search that looks like a phone number (digits, +, spaces, brackets,
// dashes; Persian and Arabic-Indic digits too) finds `phone` when its digits
// appear in it, or when its international form IS it ("0700 123 456" is
// +93700123456). Shared by the directory and the Books list (2026-09-30).
export function phoneQueryMatches(phone: string, search: string): boolean {
  const trimmed = search.trim();
  if (!phone || !/^[+\d\s()\-۰-۹٠-٩]+$/.test(trimmed)) return false;
  const compact = phone.replace(/\D/g, "");
  const digits = normalizeDigits(trimmed).replace(/\D/g, "");
  if (digits && compact.includes(digits)) return true;
  const international = internationalDigits(trimmed);
  return !!international && compact === international;
}
export function matchesOutreachSearch(contact: OutreachContact, search: string): boolean {
  const query = normalizedText(search.trim());
  if (!query) return true;
  if (phoneQueryMatches(contact.phone, search)) return true;
  const fields = [
    contact.name,
    contact.shop_name,
    contact.phone,
    contact.shopkeeper?.email ?? "",
    ...(contact.shopkeeper?.kaatas.map((kaata) => kaata.name) ?? []),
    ...(contact.customer?.listings.flatMap((listing) => [
      listing.person_name,
      listing.owner_name,
      listing.vault_name,
    ]) ?? []),
  ].map(normalizedText);
  // Every word must appear somewhere, allowing "Ahmad grocery".
  return query.split(/\s+/).every((word) => fields.some((field) => field.includes(word)));
}

function matchesLastSeen(
  contact: OutreachContact,
  lastSeen: OutreachFilters["lastSeen"],
  now: number,
): boolean {
  if (lastSeen === "all") return true;
  const time = parseTime(contact.shopkeeper?.last_seen);
  const known = time !== null && time <= now;
  if (lastSeen === "never") return !known;
  if (!known) return false;
  const age = now - time;
  if (lastSeen === "7d") return age < 7 * 86_400_000;
  if (lastSeen === "30d") return age < 30 * 86_400_000;
  return age >= 30 * 86_400_000;
}

export function facetValue(
  contact: OutreachContact,
  field: "platform" | "language" | "source",
): string {
  if (field === "language") return contact.locale || "__unknown__";
  if (field === "platform")
    return (contact.shopkeeper?.platform || "").toLowerCase() || "__unknown__";
  return contact.shopkeeper?.source || "__unknown__";
}

export function filterOutreach(
  rows: OutreachContact[],
  filters: OutreachFilters,
  search: string,
  now: number,
): OutreachContact[] {
  return rows.filter((contact) => {
    const { shopkeeper, customer, outreach } = contact;
    if (filters.kind !== "all" && contact.kind !== filters.kind) return false;
    if (filters.status === "declined_any") {
      if (outreach.status !== "declined" && outreach.status !== "do_not_contact") return false;
    } else if (filters.status === "unreachable") {
      if (outreach.status !== "no_whatsapp" && outreach.status !== "invalid") return false;
    } else if (filters.status !== "all" && outreach.status !== filters.status) return false;
    if (filters.validity === "valid" && !contact.number.valid) return false;
    if (filters.validity === "invalid" && contact.number.valid) return false;
    if (filters.numberType === "mobile" && !isMobileNumber(contact.number)) return false;
    if (filters.numberType === "fixed" && contact.number.type !== "fixed_line") return false;
    if (filters.pending === "yes" && !isPending(contact)) return false;
    if (filters.pending === "no" && isPending(contact)) return false;
    if (filters.skipped === "hide" && isSkippedToday(contact, now)) return false;
    if (filters.skipped === "only" && !isSkippedToday(contact, now)) return false;
    if (filters.contacted === "never" && !isNeverMessaged(contact)) return false;
    if (filters.contacted === "ever" && isNeverMessaged(contact)) return false;
    if (filters.country && dialCode(contact.phone).code !== filters.country) return false;
    if (filters.carrier && afghanCarrier(contact.phone) !== filters.carrier) return false;
    for (const field of ["platform", "language", "source"] as const) {
      if (filters[field] && filters[field] !== facetValue(contact, field)) return false;
    }
    if (filters.signedIn === "yes" && !shopkeeper?.signed_in) return false;
    if (filters.signedIn === "no" && (!shopkeeper || shopkeeper.signed_in)) return false;
    if (filters.onboarded === "yes" && !shopkeeper?.has_onboarded) return false;
    if (filters.onboarded === "no" && (!shopkeeper || shopkeeper.has_onboarded)) return false;
    if (filters.alreadyUser === "yes" && contact.kind !== "both") return false;
    if (filters.alreadyUser === "no" && contact.kind !== "customer") return false;
    if (filters.direction === "customer" && !customer?.is_customer_anywhere) return false;
    if (filters.direction === "supplier" && !customer?.is_supplier_anywhere) return false;
    // Only PURE customers hide on archive: a "both" row is a live app user
    // whatever the books that listed them did.
    if (filters.archived === "hide" && contact.kind === "customer" && customer?.archived_everywhere)
      return false;
    if (filters.archived === "only" && !customer?.archived_everywhere) return false;
    if (!matchesLastSeen(contact, filters.lastSeen, now)) return false;
    if (filters.contactedFrom || filters.contactedTo) {
      const day = reportingDay(outreach.contacted_at);
      if (!day) return false;
      if (filters.contactedFrom && day < filters.contactedFrom) return false;
      if (filters.contactedTo && day > filters.contactedTo) return false;
    }
    if (filters.replied === "yes" && !outreach.replied_at) return false;
    if (filters.replied === "no" && outreach.replied_at) return false;
    if (filters.followUp === "due" && !contact.follow_up_due) return false;
    if (filters.converted === "yes" && !contact.converted) return false;
    if (filters.wholesaler === "yes" && !customer?.is_wholesaler) return false;
    if (filters.minMentions > 0 && (customer?.mention_count ?? 0) < filters.minMentions)
      return false;
    if (filters.minTallies > 0 && totalTallies(contact) < filters.minTallies) return false;
    if (
      filters.minReceivable > 0 &&
      parseMoney(shopkeeper?.receivable_total) < filters.minReceivable * 100
    )
      return false;
    return matchesOutreachSearch(contact, search);
  });
}

// Summary cards and the pipeline strip are derived CLIENT-side from the exact
// predicate their click applies, so a card never reads N while the list it
// opens shows fewer rows (the server's counts include archived-everywhere
// customers that the prospecting presets hide). "Today" stays server-side: it
// counts touches, not rows.
export type PresetCounts = Record<OutreachPreset | "converted", number>;
export function presetCounts(contacts: OutreachContact[], now: number): PresetCounts {
  const counts = {} as PresetCounts;
  for (const preset of OUTREACH_PRESETS)
    counts[preset.id] = filterOutreach(contacts, presetFilters(preset.id), "", now).length;
  counts.converted = filterOutreach(contacts, CONVERTED_FILTERS, "", now).length;
  return counts;
}

export type OutreachSortKey =
  | "name"
  | "phone"
  | "last_seen"
  | "last_tally"
  | "contacted"
  | "replied"
  | "mentions"
  | "tallies"
  | "receivable"
  | "installed"
  | "first_added"
  | "people";
export const OUTREACH_SORT_OPTIONS: [OutreachSortKey, string][] = [
  ["last_seen", "Last seen"],
  ["last_tally", "Last tally"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["name", "Name"],
  ["phone", "Phone"],
  // mention_count counts distinct books (2026-09-30), so the label says so.
  ["mentions", "Books listing it"],
  ["tallies", "Tallies"],
  ["receivable", "Receivable"],
  ["installed", "Installed"],
  ["first_added", "First added"],
  ["people", "People"],
];

export type OutreachSort = { sortKey: OutreachSortKey; sortDesc: boolean };
export const DEFAULT_OUTREACH_SORT: OutreachSort = { sortKey: "last_seen", sortDesc: true };
// Each preset's opening order (2026-09-30). The views of ledger people —
// Prospects, Customers, Wholesalers — open on the newest tally, the person a
// shop dealt with most recently; every other view, and the default one,
// keeps last seen. A sort chosen afterwards holds until a preset is applied
// again (withPreset).
export function presetSort(preset: OutreachPreset): OutreachSort {
  switch (preset) {
    case "prospects":
    case "customers":
    case "wholesalers":
      return { sortKey: "last_tally", sortDesc: true };
    default:
      return { ...DEFAULT_OUTREACH_SORT };
  }
}
// Applying a preset — a tab, a summary card, a #outreach?view= link or the
// fresh-tab default — sets its filters AND its sort; page size stays.
export function withPreset(
  preferences: OutreachPreferences,
  preset: OutreachPreset,
): OutreachPreferences {
  return { ...preferences, filters: presetFilters(preset), ...presetSort(preset) };
}
// A preset's description as the page shows it (2026-09-30). The sentence
// about its opening order ("Newest tally first.") is kept only while the
// current sort IS that order: once the operator re-sorts, it would describe
// a list that is no longer on screen. A tab's tooltip passes the preset's
// own sort, because clicking the tab applies it.
export function presetDescription(preset: OutreachPreset, sort: OutreachSort): string {
  const entry = OUTREACH_PRESETS.find((p) => p.id === preset);
  if (!entry) return "";
  const own = presetSort(preset);
  return "order" in entry && own.sortKey === sort.sortKey && own.sortDesc === sort.sortDesc
    ? `${entry.description} ${entry.order}`
    : entry.description;
}

// Missing values sort last in both directions. Ties break on the phone,
// except on the last tally (2026-09-30): there the number more books list
// comes first (mention_count, most first, whatever the direction), then the
// phone. The ties that matter are the people with no tally at all, who sort
// last together.
export function sortOutreach(
  rows: OutreachContact[],
  key: OutreachSortKey,
  descending: boolean,
): OutreachContact[] {
  const direction = descending ? -1 : 1;
  const mentions = (c: OutreachContact) => c.customer?.mention_count ?? 0;
  const tie = (a: OutreachContact, b: OutreachContact) =>
    (key === "last_tally" ? mentions(b) - mentions(a) : 0) || a.phone.localeCompare(b.phone);
  const value = (c: OutreachContact): string | number | null => {
    switch (key) {
      case "name":
        return c.name || c.shop_name || null;
      case "phone":
        return c.phone;
      case "last_seen":
        return parseTime(c.shopkeeper?.last_seen);
      case "last_tally":
        return parseTime(lastTallyAt(c));
      case "contacted":
        return parseTime(c.outreach.contacted_at);
      case "replied":
        return parseTime(c.outreach.replied_at);
      case "mentions":
        return c.customer ? c.customer.mention_count : null;
      case "tallies":
        return c.shopkeeper || c.customer ? totalTallies(c) : null;
      case "receivable":
        return c.shopkeeper ? parseMoney(c.shopkeeper.receivable_total) : null;
      case "installed":
        return parseTime(c.shopkeeper?.installed_at);
      case "first_added":
        return parseTime(c.customer?.first_added_at);
      case "people":
        return c.shopkeeper ? c.shopkeeper.people : null;
    }
  };
  return [...rows].sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av === null && bv === null) return tie(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    const result =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    return result * direction || tie(a, b);
  });
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---- CSV ----

// A leading = + - @ would run as a formula in a spreadsheet; the quote prefix
// is the standard guard and applies to every cell, phones included.
export function csvCell(value: string | number | boolean | null | undefined): string {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export const CSV_COLUMNS: [string, (c: OutreachContact) => string | number | boolean][] = [
  ["phone", (c) => c.phone],
  ["kind", (c) => c.kind],
  ["name", (c) => c.name],
  ["shop_name", (c) => c.shop_name],
  ["locale", (c) => c.locale],
  ["country", (c) => dialCode(c.phone).country],
  ["carrier", (c) => afghanCarrier(c.phone)],
  ["number_valid", (c) => c.number.valid],
  ["number_type", (c) => c.number.type],
  ["region", (c) => c.number.region],
  ["status", (c) => c.outreach.status],
  ["contact_count", (c) => c.outreach.contact_count],
  ["contacted_at", (c) => c.outreach.contacted_at],
  ["first_contacted_at", (c) => c.outreach.first_contacted_at],
  ["replied_at", (c) => c.outreach.replied_at],
  ["opened_at", (c) => c.outreach.opened_at],
  ["pending_since", (c) => c.outreach.pending_since],
  ["skipped_at", (c) => c.outreach.skipped_at],
  ["open_count", (c) => c.outreach.open_count],
  ["note", (c) => c.outreach.note],
  // The stored per-number choice ("" = follows the session language).
  ["lang", (c) => c.outreach.lang],
  ["converted", (c) => c.converted],
  ["follow_up_due", (c) => c.follow_up_due],
  ["account_id", (c) => c.shopkeeper?.account_id ?? ""],
  ["email", (c) => c.shopkeeper?.email ?? ""],
  ["signed_in", (c) => c.shopkeeper?.signed_in ?? ""],
  ["install_count", (c) => c.shopkeeper?.install_count ?? ""],
  ["platform", (c) => c.shopkeeper?.platform ?? ""],
  ["app_version", (c) => c.shopkeeper?.app_version ?? ""],
  ["source", (c) => c.shopkeeper?.source ?? ""],
  ["attribution", (c) => c.shopkeeper?.attribution ?? ""],
  ["installed_at", (c) => c.shopkeeper?.installed_at ?? ""],
  ["first_seen", (c) => c.shopkeeper?.first_seen ?? ""],
  ["last_seen", (c) => c.shopkeeper?.last_seen ?? ""],
  ["last_activity_at", (c) => c.shopkeeper?.last_activity_at ?? ""],
  ["has_onboarded", (c) => c.shopkeeper?.has_onboarded ?? ""],
  ["check_in_count", (c) => c.shopkeeper?.check_in_count ?? ""],
  ["usage_entries", (c) => c.shopkeeper?.usage_entries ?? ""],
  ["usage_customers", (c) => c.shopkeeper?.usage_customers ?? ""],
  ["usage_shares", (c) => c.shopkeeper?.usage_shares ?? ""],
  ["people", (c) => c.shopkeeper?.people ?? ""],
  ["tallies", (c) => c.shopkeeper?.tallies ?? ""],
  ["receivable_total", (c) => c.shopkeeper?.receivable_total ?? ""],
  ["payable_total", (c) => c.shopkeeper?.payable_total ?? ""],
  ["currency", (c) => c.shopkeeper?.currency ?? ""],
  ["shopkeeper_last_tally_at", (c) => c.shopkeeper?.last_tally_at ?? ""],
  [
    "kaatas",
    (c) =>
      (c.shopkeeper?.kaatas ?? [])
        .map(
          (k) =>
            `${k.name} (${k.role}, ${k.currency}, ${k.people} people, ${k.tallies} tallies${k.archived ? ", archived" : ""})`,
        )
        .join(" · "),
  ],
  // The distinct books that list the number (mention_count); the header says
  // what it counts (2026-09-30).
  ["books", (c) => c.customer?.mention_count ?? ""],
  ["first_added_at", (c) => c.customer?.first_added_at ?? ""],
  ["customer_last_tally_at", (c) => c.customer?.last_tally_at ?? ""],
  ["tallies_total", (c) => c.customer?.tallies_total ?? ""],
  ["archived_everywhere", (c) => c.customer?.archived_everywhere ?? ""],
  ["is_supplier_anywhere", (c) => c.customer?.is_supplier_anywhere ?? ""],
  ["is_customer_anywhere", (c) => c.customer?.is_customer_anywhere ?? ""],
  ["is_wholesaler", (c) => c.customer?.is_wholesaler ?? ""],
  ["listings", (c) => listingsSummary(c.customer)],
  [
    "balances",
    (c) =>
      balanceSummary(c.customer)
        .map(
          (b) =>
            `owes ${formatMoney(b.owes)} ${b.currency} / owed ${formatMoney(b.owed)} ${b.currency}`,
        )
        .join(" · "),
  ],
];
export function outreachCsv(rows: OutreachContact[]): string {
  const lines = [
    CSV_COLUMNS.map(([header]) => csvCell(header)).join(","),
    ...rows.map((contact) => CSV_COLUMNS.map(([, pick]) => csvCell(pick(contact))).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ---- books (the Books list in the Excluded sources card, 2026-09-30) ----

// The owner as the operator reads it: name, else email, else phone, else id.
export function bookOwnerLabel(book: OutreachBook): string {
  return book.owner_name || book.owner_email || book.owner_phone || book.owner_account_id;
}
// Book name, owner name, email and phone; a phone-shaped search goes through
// the directory's own phone matching (phoneQueryMatches), and every word of a
// text search must appear somewhere, as in the directory.
export function matchesBookSearch(book: OutreachBook, search: string): boolean {
  const query = normalizedText(search.trim());
  if (!query) return true;
  if (phoneQueryMatches(book.owner_phone, search)) return true;
  const fields = [book.name, book.owner_name, book.owner_email, book.owner_phone].map(
    normalizedText,
  );
  return query.split(/\s+/).every((word) => fields.some((field) => field.includes(word)));
}
export type BookSortKey = "numbers" | "last_activity" | "created" | "owner" | "name";
export const BOOK_SORT_OPTIONS: [BookSortKey, string][] = [
  ["numbers", "Numbers"],
  ["last_activity", "Last activity"],
  ["created", "Created"],
  ["owner", "Owner"],
  ["name", "Name"],
];
function newestFirst(a: string, b: string): number {
  const at = parseTime(a);
  const bt = parseTime(b);
  if (at === null || bt === null) return at === bt ? 0 : at === null ? 1 : -1;
  return bt - at;
}
function textFirst(a: string, b: string): number {
  if (!a || !b) return a === b ? 0 : a ? -1 : 1;
  return a.localeCompare(b);
}
// Numbers is the server's own order (sortOutreachBooks: most numbers, then
// the newest last tally, then name and vault id compared byte-wise, as Go
// compares strings), kept exactly as received (2026-09-30): re-deriving it
// here with localeCompare disagreed with Go wherever case or accents differ
// ("Zebra" comes before "apple" byte-wise), so the default list was not the
// server's. Last activity and Created: newest first; Owner and Name: A to Z.
// A missing date or name sorts last, and every tie keeps the server's order
// (its index), never a client comparison.
export function sortBooks(books: OutreachBook[], key: BookSortKey): OutreachBook[] {
  if (key === "numbers") return [...books];
  const primary = (a: OutreachBook, b: OutreachBook): number => {
    switch (key) {
      case "last_activity":
        return newestFirst(a.last_tally_at, b.last_tally_at);
      case "created":
        return newestFirst(a.created_at, b.created_at);
      case "owner":
        return textFirst(bookOwnerLabel(a), bookOwnerLabel(b));
      case "name":
        return textFirst(a.name, b.name);
    }
  };
  return books
    .map((book, index) => ({ book, index }))
    .sort((a, b) => primary(a.book, b.book) || a.index - b.index)
    .map(({ book }) => book);
}
// Distinct numbers among these books' listings, read from the contacts: a
// number that several of the books list counts once, as in the directory.
export function numbersInBooks(contacts: OutreachContact[], books: OutreachBook[]): number {
  const vaults = new Set(books.map((book) => book.vault_id));
  return contacts.filter((contact) =>
    contact.customer?.listings.some((listing) => vaults.has(listing.vault_id)),
  ).length;
}

// ---- optimistic patches ----

function clampRunes(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}
// Whether the server leaves a row out of a mark entirely (2026-09-30), so
// the mirror below leaves it exactly as it was: no count, no touch, no
// version bump, not even the other fields of the same mark. A `contacted`
// mark records only a FIRST message: it skips a row that is not sendable
// (New, Not on WhatsApp, Invalid) or already has a recorded send. A status
// mark never lifts a stop by accident: it skips a Declined / Do-not-contact
// row it would move to any other status unless `lift_stop`. Setting or
// re-setting a stop always applies; a reply or a note on a stopped row
// applies and keeps the stop.
function markSkipsRow(state: OutreachState, body: OutreachMarkBody): boolean {
  if (body.contacted && (!isSendableStatus(state.status) || state.contact_count > 0)) return true;
  return (
    body.status !== undefined &&
    isStoppedStatus(state.status) &&
    !isStoppedStatus(body.status) &&
    body.lift_stop !== true
  );
}
// Mirrors the backend's mark rules (MarkOutreach + writeOutreachMark) so a
// tick flips before the round trip. Rows the server would skip stay as they
// were (markSkipsRow): a second "Mark sent" never counts a message twice,
// and a bulk status change never lifts a stop. A status together with
// contacted or replied is refused whole by the server (400), so the mirror
// changes nothing at all. A counted send promotes the row to Sent and ends
// first contact (never_messaged false); a Not-on-WhatsApp or Invalid status
// resolves an opened chat as nothing sent, as the server's reading of the
// touch log does. A send, a reply, or an explicit status other than New ends
// any pending/skipped state; an explicit New keeps it, so resetting a row
// cannot silently drop a chat opened without an outcome. replied stamps
// replied_at; the note is clamped to 2000 runes and its touch to 200; a lang
// is set without a touch and never ends a wait; every write bumps `version`,
// as the server does. follow_up_due is only ever CLEARED here — a reply or a
// fresh send cancels it; nothing sets it.
export function applyMarkLocally(
  result: OutreachResult,
  body: OutreachMarkBody,
  nowIso: string,
): OutreachResult {
  if (body.status !== undefined && (body.contacted || body.replied)) return result;
  const phones = new Set(body.phones);
  let sent = 0;
  let replied = 0;
  const contacts = result.contacts.map((contact) => {
    if (!phones.has(contact.phone)) return contact;
    if (markSkipsRow(contact.outreach, body)) return contact;
    const touches: OutreachTouch[] = [...contact.outreach.touches];
    const touch = (kind: OutreachTouch["kind"], detail: string) =>
      touches.unshift({ kind, detail, at: nowIso });
    const outreach = { ...contact.outreach };
    let status: OutreachStatus = outreach.status;
    if (body.contacted) {
      outreach.contacted_at = nowIso;
      outreach.first_contacted_at = outreach.first_contacted_at || nowIso;
      outreach.contact_count += 1;
      outreach.never_messaged = false;
      touch("sent", body.template_key ?? "");
      status = "sent";
      sent += 1;
    }
    if (body.replied) {
      outreach.replied_at = nowIso;
      touch("replied", "");
      if (status === "new" || status === "sent") status = "replied";
      replied += 1;
    }
    if (body.status !== undefined) {
      status = body.status;
      touch("status", body.status);
      if (isUnreachableStatus(body.status)) outreach.never_messaged = outreach.contact_count === 0;
    }
    if (body.note !== undefined) {
      outreach.note = clampRunes(body.note, 2000);
      touch("note", clampRunes(body.note, 200));
    }
    // A preference, not an outreach event (2026-09-30): no touch, but a
    // write like any other, so the version still moves below.
    if (body.lang !== undefined) outreach.lang = body.lang;
    if (body.contacted || body.replied || (body.status !== undefined && body.status !== "new")) {
      outreach.pending_since = "";
      outreach.skipped_at = "";
    }
    outreach.status = status;
    outreach.updated_at = nowIso;
    outreach.version += 1;
    outreach.touches = touches.slice(0, 20);
    const follow_up_due =
      contact.follow_up_due && status === "sent" && !body.contacted && !body.replied;
    return { ...contact, outreach, follow_up_due };
  });
  return {
    ...result,
    contacts,
    counts: recountOutreach(contacts, {
      ...result.counts,
      sent_today: result.counts.sent_today + sent,
      replied_today: result.counts.replied_today + replied,
    }),
  };
}
// The mark response is authoritative: each returned state replaces the
// matching contact's outreach block wholesale (server timestamps, touch
// order, clamps), normalized by withStateDefaults. `skipped` lists the rows
// the mark left untouched (see markSkipsRow): they keep their follow-up
// flag. For the rest follow_up_due, which is not in the response, follows
// the optimistic patch's rule — a send or a reply cancels it, nothing sets
// it.
export function applyMarkResponse(
  result: OutreachResult,
  updated: OutreachState[],
  body: OutreachMarkBody,
  skipped: string[] = [],
): OutreachResult {
  const byPhone = new Map(updated.map((state) => [state.phone, state]));
  const untouched = new Set(skipped);
  const contacts = result.contacts.map((contact) => {
    const state = byPhone.get(contact.phone);
    if (!state) return contact;
    const outreach = withStateDefaults(state);
    const follow_up_due = untouched.has(contact.phone)
      ? contact.follow_up_due
      : contact.follow_up_due && outreach.status === "sent" && !body.contacted && !body.replied;
    return { ...contact, outreach, follow_up_due };
  });
  return { ...result, contacts, counts: recountOutreach(contacts, result.counts) };
}
// Status-derived counts follow the contacts; source-derived ones (total, the
// kinds, wholesalers, invalid numbers, today's tallies) stay the server's.
export function recountOutreach(
  contacts: OutreachContact[],
  counts: OutreachCounts,
): OutreachCounts {
  const next: OutreachCounts = {
    ...counts,
    to_contact: 0,
    sent: 0,
    replied: 0,
    interested: 0,
    installed: 0,
    declined: 0,
    unreachable: 0,
    pending: 0,
    follow_ups_due: 0,
    converted: 0,
  };
  for (const contact of contacts) {
    switch (contact.outreach.status) {
      case "new":
        next.to_contact += 1;
        break;
      case "sent":
        next.sent += 1;
        break;
      case "replied":
        next.replied += 1;
        break;
      case "interested":
        next.interested += 1;
        break;
      case "installed":
        next.installed += 1;
        break;
      case "no_whatsapp":
      case "invalid":
        next.unreachable += 1;
        break;
      default:
        next.declined += 1;
    }
    if (isPending(contact)) next.pending += 1;
    if (contact.follow_up_due) next.follow_ups_due += 1;
    if (contact.converted) next.converted += 1;
  }
  return next;
}
// An outcome's answer is the row's state read back in the server's own
// transaction; it replaces the cached block wholesale (normalized by
// withStateDefaults) — nothing was applied ahead of it. follow_up_due is not
// in the response, so the same rule as the mark patches applies: a fresh
// send (contacted_at moved) or any status other than sent clears it;
// nothing sets it.
export function applyStateLocally(result: OutreachResult, raw: OutreachState): OutreachResult {
  const state = withStateDefaults(raw);
  let changed = false;
  const contacts = result.contacts.map((contact) => {
    if (contact.phone !== state.phone) return contact;
    changed = true;
    const follow_up_due =
      contact.follow_up_due &&
      state.status === "sent" &&
      state.contacted_at === contact.outreach.contacted_at;
    return { ...contact, outreach: state, follow_up_due };
  });
  if (!changed) return result;
  return { ...result, contacts, counts: recountOutreach(contacts, result.counts) };
}
// The exclusion endpoints answer with the full current list. The contacts
// themselves are refetched (an excluded source changes which rows exist).
// The Books list drops at once every book the new list excludes (2026-09-30)
// — the book itself, or any book whose owner account is excluded, the
// server's own rule — so no book sits in Books and in the exclusions list at
// the same time. An Undo brings a book back with the refetch only.
export function applyExclusionsLocally(
  result: OutreachResult,
  exclusions: OutreachExclusion[],
): OutreachResult {
  const vaults = new Set<string>();
  const accounts = new Set<string>();
  for (const exclusion of exclusions) {
    if (exclusion.kind === "vault") vaults.add(exclusion.id);
    else if (exclusion.kind === "account") accounts.add(exclusion.id);
  }
  const books = result.books.filter(
    (book) => !vaults.has(book.vault_id) && !accounts.has(book.owner_account_id),
  );
  return { ...result, exclusions, books };
}
export function applySettingLocally(
  result: OutreachResult,
  key: string,
  value: string,
): OutreachResult {
  const settings = { ...result.settings };
  if (value.trim()) settings[key] = value;
  else delete settings[key];
  return { ...result, settings };
}

// ---- wire tolerance (older backends) ----

export const EMPTY_OUTREACH_COUNTS: OutreachCounts = {
  total: 0,
  shopkeepers: 0,
  customers: 0,
  both: 0,
  wholesalers: 0,
  to_contact: 0,
  sent: 0,
  replied: 0,
  interested: 0,
  installed: 0,
  declined: 0,
  follow_ups_due: 0,
  converted: 0,
  sent_today: 0,
  replied_today: 0,
  pending: 0,
  unreachable: 0,
  invalid: 0,
  opened_today: 0,
};
// Every OutreachState that enters the cache passes through here — the GET
// (withOutreachDefaults), a mark's answer (applyMarkResponse) and an
// outcome's answer (applyStateLocally) — so a field an older backend omits
// reads as empty, never undefined: strings "", numbers 0, touches []. A
// missing status reads as New, the server's own default for a number with
// no row. A missing never_messaged is derived CONSERVATIVELY: true only when
// no send, no open and no pending chat is on record, so a number that was
// opened and then skipped reads as messaged until the backend itself says
// otherwise — never offered twice. A missing or unknown lang (a backend
// before migration 046) reads as "", which follows the session choice. The
// result is a fresh object with exactly the known fields.
export function withStateDefaults(raw: unknown): OutreachState {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const contactCount = count(s.contact_count);
  const openCount = count(s.open_count);
  const pendingSince = text(s.pending_since);
  return {
    phone: text(s.phone),
    status: typeof s.status === "string" && s.status ? (s.status as OutreachStatus) : "new",
    contacted_at: text(s.contacted_at),
    first_contacted_at: text(s.first_contacted_at),
    replied_at: text(s.replied_at),
    contact_count: contactCount,
    never_messaged:
      typeof s.never_messaged === "boolean"
        ? s.never_messaged
        : contactCount === 0 && openCount === 0 && !pendingSince,
    note: text(s.note),
    updated_at: text(s.updated_at),
    touches: Array.isArray(s.touches) ? (s.touches as OutreachTouch[]) : [],
    opened_at: text(s.opened_at),
    pending_since: pendingSince,
    skipped_at: text(s.skipped_at),
    open_count: openCount,
    version: count(s.version),
    lang: isOutreachLang(s.lang) ? s.lang : "",
  };
}
// The outreach endpoints deploy with the backend, and this page may be
// deployed first. Every field batch 2 added is defaulted here so a payload
// from the 2026-09-29 backend still renders: no verdict reads as valid (never
// hide a row by accident), no exclusions, no pending/skipped state, version 0
// (the old backend ignores expected_version), never_messaged derived from the
// send count (withStateDefaults). Batch 3's fields likewise (2026-09-30): no
// books, and every lang "" (withStateDefaults). Arrays are never null.
export function withOutreachDefaults(raw: unknown): OutreachResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<OutreachResult>;
  const contacts = (Array.isArray(r.contacts) ? r.contacts : []).map(
    (contact): OutreachContact => ({
      ...contact,
      number:
        contact.number && typeof contact.number === "object"
          ? { ...DEFAULT_OUTREACH_NUMBER, ...contact.number }
          : DEFAULT_OUTREACH_NUMBER,
      shopkeeper: contact.shopkeeper
        ? {
            ...contact.shopkeeper,
            install_ids: Array.isArray(contact.shopkeeper.install_ids)
              ? contact.shopkeeper.install_ids
              : [],
          }
        : null,
      outreach: withStateDefaults(contact.outreach),
    }),
  );
  return {
    contacts,
    settings: r.settings && typeof r.settings === "object" ? r.settings : {},
    counts: { ...EMPTY_OUTREACH_COUNTS, ...(r.counts ?? {}) },
    exclusions: Array.isArray(r.exclusions) ? r.exclusions : [],
    books: Array.isArray(r.books) ? r.books : [],
    generated_at: r.generated_at ?? "",
  };
}

// ---- preferences (sessionStorage) ----

// Only enum/number preferences are restored. Search text, phone numbers,
// notes, selection and result data are deliberately absent from this contract.
export type OutreachPreferences = {
  filters: OutreachFilters;
  sortKey: OutreachSortKey;
  sortDesc: boolean;
  pageSize: number;
};
export function parseOutreachPreferences(value: unknown): OutreachPreferences {
  const defaults: OutreachPreferences = {
    filters: { ...DEFAULT_OUTREACH_FILTERS },
    ...DEFAULT_OUTREACH_SORT,
    pageSize: 25,
  };
  if (!value || typeof value !== "object") return defaults;
  const saved = value as Record<string, unknown>;
  const filters =
    saved.filters && typeof saved.filters === "object"
      ? (saved.filters as Record<string, unknown>)
      : {};
  for (const key of Object.keys(FILTER_ENUMS) as (keyof typeof FILTER_ENUMS)[]) {
    const allowed = FILTER_ENUMS[key] as readonly string[];
    if (typeof filters[key] === "string" && allowed.includes(filters[key] as string))
      Object.assign(defaults.filters, { [key]: filters[key] });
  }
  if (typeof filters.country === "string" && /^\+\d{1,3}$/.test(filters.country))
    defaults.filters.country = filters.country;
  for (const key of ["platform", "language", "source"] as const) {
    if (typeof filters[key] === "string" && /^[A-Za-z0-9._~-]{0,64}$/.test(filters[key]))
      defaults.filters[key] = filters[key];
  }
  for (const key of ["contactedFrom", "contactedTo"] as const) {
    const day = filters[key];
    if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const date = new Date(`${day}T00:00:00Z`);
      if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day)
        defaults.filters[key] = day;
    }
  }
  for (const key of ["minMentions", "minTallies", "minReceivable"] as const) {
    const n = Number(filters[key]);
    if (Number.isInteger(n) && n >= 0 && n <= 1_000_000_000) defaults.filters[key] = n;
  }
  if (OUTREACH_SORT_OPTIONS.some(([key]) => key === saved.sortKey))
    defaults.sortKey = saved.sortKey as OutreachSortKey;
  if (typeof saved.sortDesc === "boolean") defaults.sortDesc = saved.sortDesc;
  if ([25, 50, 100].includes(Number(saved.pageSize))) defaults.pageSize = Number(saved.pageSize);
  return defaults;
}
