// Pure model behind the admin Outreach section (2026-09-29). React-free so
// `node --test` can pin it: search/filter/sort/preset predicates, the
// dial-code and Afghan-carrier tables, template filling and the wa.me link,
// the "send next" picker, the CSV export and the optimistic patch that flips a
// tick before the server answers. Two rules shape it:
//
// - `converted` and `follow_up_due` are READ from the server, never
//   recomputed. The backend owns the 48 h rule and the install-after-contact
//   comparison; a client re-derivation on a different clock would disagree
//   with the counts on the summary cards.
// - Money stays in integer hundredths parsed from the wire's decimal string
//   ("1234.50"), the same rule as lib/money.ts on mobile. No float64 anywhere.
//
// Types mirror api.ts field-for-field; nothing here is persisted except the
// enum/number preferences that `parseOutreachPreferences` admits.

import type {
  OutreachContact,
  OutreachCounts,
  OutreachCustomer,
  OutreachMarkBody,
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
];
export const STATUS_LABELS: Record<OutreachStatus, string> = {
  new: "New",
  sent: "Sent",
  replied: "Replied",
  interested: "Interested",
  installed: "Installed",
  declined: "Declined",
  do_not_contact: "Do not contact",
};
export function isOutreachStatus(value: unknown): value is OutreachStatus {
  return typeof value === "string" && (OUTREACH_STATUSES as string[]).includes(value);
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
export type LanguageOverride = "auto" | MessageLanguage;

export function audienceFor(contact: OutreachContact): Audience {
  return contact.kind === "customer" ? "customer" : "shopkeeper";
}
export function messageLanguage(
  locale: string,
  override: LanguageOverride = "auto",
): MessageLanguage {
  if (override !== "auto") return override;
  const lower = (locale || "").toLowerCase();
  return lower.startsWith("fa") || lower.startsWith("prs") ? "fa" : "en";
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
export const AUTO_MARK_KEY = "pref.auto_mark";

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
export function buildMessage(
  contact: OutreachContact,
  settings: Record<string, string>,
  override: LanguageOverride = "auto",
): BuiltMessage {
  const audience = audienceFor(contact);
  const language = messageLanguage(contact.locale, override);
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
export type ContactPill = { label: string; tone: PillTone };
// Every pill comes straight from a server flag — nothing here is re-derived.
export function contactPills(contact: OutreachContact): ContactPill[] {
  const pills: ContactPill[] = [
    { label: kindLabel(contact.kind), tone: contact.kind === "customer" ? "gray" : "blue" },
  ];
  if (contact.customer?.is_wholesaler) pills.push({ label: "Wholesaler", tone: "amber" });
  if (contact.kind === "both") pills.push({ label: "Already a user", tone: "green" });
  if (contact.converted) pills.push({ label: "Converted", tone: "green" });
  if (contact.follow_up_due) pills.push({ label: "Follow-up due", tone: "amber" });
  if (contact.outreach.status === "do_not_contact")
    pills.push({ label: "Do not contact", tone: "red" });
  return pills;
}

// ---- filters, presets, search, sort ----

export type OutreachFilters = {
  kind: "all" | "shopkeeper" | "customer" | "both";
  status: "all" | OutreachStatus | "declined_any";
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
  minMentions: 0,
  minTallies: 0,
  minReceivable: 0,
};
export const FILTER_ENUMS = {
  kind: ["all", "shopkeeper", "customer", "both"],
  status: ["all", ...OUTREACH_STATUSES, "declined_any"],
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
} as const;

export const OUTREACH_PRESETS = [
  {
    id: "all",
    label: "All",
    description: "Every number the server knows, except customers archived in every book.",
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
  },
  {
    id: "wholesalers",
    label: "Wholesalers",
    description: "Listed in two or more books, or recorded as a supplier anywhere.",
  },
  { id: "to_contact", label: "To contact", description: "Status New — nothing sent yet." },
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
] as const;
export type OutreachPreset = (typeof OUTREACH_PRESETS)[number]["id"];

// Prospecting presets (all, shopkeepers, customers, wholesalers, to_contact)
// hide customers archived in every book; the status and follow-up presets show
// them, so a conversation already in progress never vanishes from its queue
// because a shopkeeper archived the person meanwhile.
export function presetFilters(preset: OutreachPreset): OutreachFilters {
  const base = { ...DEFAULT_OUTREACH_FILTERS };
  const tracking: OutreachFilters = { ...base, archived: "show" };
  switch (preset) {
    case "shopkeepers":
      return { ...base, kind: "shopkeeper" };
    case "customers":
      return { ...base, kind: "customer" };
    case "wholesalers":
      return { ...base, wholesaler: "yes" };
    case "to_contact":
      return { ...base, status: "new" };
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
export function activePreset(filters: OutreachFilters): OutreachPreset | undefined {
  return OUTREACH_PRESETS.find((p) => {
    const preset = presetFilters(p.id);
    return (Object.keys(preset) as (keyof OutreachFilters)[]).every(
      (key) => preset[key] === filters[key],
    );
  })?.id;
}

export function matchesOutreachSearch(contact: OutreachContact, search: string): boolean {
  const query = normalizedText(search.trim());
  if (!query) return true;
  const compactPhone = contact.phone.replace(/\D/g, "");
  if (/^[+\d\s()\-۰-۹٠-٩]+$/.test(search.trim())) {
    const digits = query.replace(/\D/g, "");
    if (digits && compactPhone.includes(digits)) return true;
    const international = internationalDigits(query);
    if (international && compactPhone === international) return true;
  }
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
    } else if (filters.status !== "all" && outreach.status !== filters.status) return false;
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
  ["mentions", "Mentions"],
  ["tallies", "Tallies"],
  ["receivable", "Receivable"],
  ["installed", "Installed"],
  ["first_added", "First added"],
  ["people", "People"],
];

export function sortOutreach(
  rows: OutreachContact[],
  key: OutreachSortKey,
  descending: boolean,
): OutreachContact[] {
  const direction = descending ? -1 : 1;
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
    if (av === null && bv === null) return a.phone.localeCompare(b.phone);
    if (av === null) return 1;
    if (bv === null) return -1;
    const result =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    return result * direction || a.phone.localeCompare(b.phone);
  });
}

// The "Send next" target: first row of the CURRENT view that is still New and
// was not seen installing after an earlier contact. Do-not-contact rows can
// never be New, but the check stays explicit.
export function nextToContact(rows: OutreachContact[]): OutreachContact | undefined {
  return rows.find(
    (c) =>
      c.outreach.status === "new" &&
      (c.outreach.status as OutreachStatus) !== "do_not_contact" &&
      !c.converted,
  );
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
  ["status", (c) => c.outreach.status],
  ["contact_count", (c) => c.outreach.contact_count],
  ["contacted_at", (c) => c.outreach.contacted_at],
  ["first_contacted_at", (c) => c.outreach.first_contacted_at],
  ["replied_at", (c) => c.outreach.replied_at],
  ["note", (c) => c.outreach.note],
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
  ["mention_count", (c) => c.customer?.mention_count ?? ""],
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

// ---- optimistic patches ----

function clampRunes(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}
// Mirrors the backend's mark rules so a tick flips before the round trip:
// contacted bumps the count and stamps contacted_at (first_contacted_at once);
// replied stamps replied_at; an explicit status wins; the note is clamped to
// 2000 runes and its touch to 200. follow_up_due is only ever CLEARED here —
// a reply or a fresh send cancels it; nothing sets it.
export function applyMarkLocally(
  result: OutreachResult,
  body: OutreachMarkBody,
  nowIso: string,
): OutreachResult {
  const phones = new Set(body.phones);
  let sent = 0;
  let replied = 0;
  const contacts = result.contacts.map((contact) => {
    if (!phones.has(contact.phone)) return contact;
    const touches: OutreachTouch[] = [...contact.outreach.touches];
    const touch = (kind: OutreachTouch["kind"], detail: string) =>
      touches.unshift({ kind, detail, at: nowIso });
    const outreach = { ...contact.outreach };
    let status: OutreachStatus = outreach.status;
    if (body.contacted) {
      outreach.contacted_at = nowIso;
      outreach.first_contacted_at = outreach.first_contacted_at || nowIso;
      outreach.contact_count += 1;
      touch("sent", body.template_key ?? "");
      if (body.status === undefined && status === "new") status = "sent";
      sent += 1;
    }
    if (body.replied) {
      outreach.replied_at = nowIso;
      touch("replied", "");
      if (body.status === undefined && (status === "new" || status === "sent")) status = "replied";
      replied += 1;
    }
    if (body.status !== undefined) {
      status = body.status;
      touch("status", body.status);
    }
    if (body.note !== undefined) {
      outreach.note = clampRunes(body.note, 2000);
      touch("note", clampRunes(body.note, 200));
    }
    outreach.status = status;
    outreach.updated_at = nowIso;
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
// matching contact's outreach block wholesale (touch ids, server timestamps,
// clamps). follow_up_due is not in the response, so the same clearing rule as
// the optimistic patch applies — a send or a reply cancels it, nothing sets it.
export function applyMarkResponse(
  result: OutreachResult,
  updated: OutreachState[],
  body: OutreachMarkBody,
): OutreachResult {
  const byPhone = new Map(updated.map((state) => [state.phone, state]));
  const contacts = result.contacts.map((contact) => {
    const outreach = byPhone.get(contact.phone);
    if (!outreach) return contact;
    const follow_up_due =
      contact.follow_up_due && outreach.status === "sent" && !body.contacted && !body.replied;
    return { ...contact, outreach, follow_up_due };
  });
  return { ...result, contacts, counts: recountOutreach(contacts, result.counts) };
}
// Status-derived counts follow the contacts; source-derived ones (total, the
// kinds, wholesalers, today's tallies) stay the server's.
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
      default:
        next.declined += 1;
    }
    if (contact.follow_up_due) next.follow_ups_due += 1;
    if (contact.converted) next.converted += 1;
  }
  return next;
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
    sortKey: "last_seen",
    sortDesc: true,
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
