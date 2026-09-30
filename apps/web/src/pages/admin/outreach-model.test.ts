import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  OutreachBook,
  OutreachContact,
  OutreachCustomer,
  OutreachExclusion,
  OutreachLang,
  OutreachListing,
  OutreachMarkBody,
  OutreachNumber,
  OutreachResult,
  OutreachShopkeeper,
  OutreachState,
} from "./api";
import {
  BOOK_SORT_OPTIONS,
  CONVERTED_FILTERS,
  DEFAULT_OUTREACH_FILTERS,
  DEFAULT_OUTREACH_NUMBER,
  DEFAULT_OUTREACH_SORT,
  DEFAULT_TEMPLATES,
  LANGUAGE_NAMES,
  OUTREACH_PRESETS,
  OUTREACH_STATUSES,
  SESSION_LANGUAGE_KEY,
  SESSION_LANGUAGE_OPTIONS,
  STATUS_LABELS,
  activePreset,
  afghanCarrier,
  applyExclusionsLocally,
  applyMarkLocally,
  applyMarkResponse,
  applySettingLocally,
  applyStateLocally,
  balanceSummary,
  bookOwnerLabel,
  buildMessage,
  canOpen,
  contactPills,
  csvCell,
  dialCode,
  fillTemplate,
  filterOutreach,
  formatMoney,
  internationalDigits,
  isMobileNumber,
  isNeverMessaged,
  isOutreachLang,
  isPending,
  isProspect,
  isSendableStatus,
  isSkippedToday,
  isStoppedStatus,
  isUnreachableStatus,
  listingsSummary,
  localeLanguage,
  matchesBookSearch,
  messageLanguage,
  nextToOpen,
  normalizeDigits,
  numberCaption,
  numberTypeLabel,
  numbersInBooks,
  offersChat,
  openableCount,
  openedTemplateKey,
  outreachCsv,
  parseMoney,
  parseOutreachPreferences,
  pendingRows,
  phoneQueryMatches,
  presetCounts,
  presetDescription,
  presetFilters,
  presetSort,
  recountOutreach,
  sessionChoiceLabel,
  sessionLanguage,
  sortBooks,
  sortOutreach,
  templateLanguage,
  waLink,
  withOutreachDefaults,
  withPreset,
  withStateDefaults,
} from "./outreach-model.ts";

// 2026-09-29 12:30 in Kabul.
const NOW = Date.parse("2026-09-29T08:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
// The Kabul reporting day that contains NOW starts here (UTC+04:30).
const KABUL_MIDNIGHT = "2026-09-28T19:30:00.000Z";

// Unless a fixture says otherwise, never_messaged follows the same
// conservative reading withStateDefaults gives an older backend: true only
// with no send, no open and no pending chat on record. Fixtures for a chat
// that was opened and then resolved set the server's flag explicitly.
function state(overrides: Partial<OutreachState> = {}): OutreachState {
  const s: OutreachState = {
    phone: "",
    status: "new",
    contacted_at: "",
    first_contacted_at: "",
    replied_at: "",
    contact_count: 0,
    never_messaged: true,
    note: "",
    updated_at: "",
    touches: [],
    opened_at: "",
    pending_since: "",
    skipped_at: "",
    open_count: 0,
    version: 0,
    lang: "",
    ...overrides,
  };
  if (overrides.never_messaged === undefined)
    s.never_messaged = s.contact_count === 0 && s.open_count === 0 && !s.pending_since;
  return s;
}
function number(overrides: Partial<OutreachNumber> = {}): OutreachNumber {
  return {
    valid: true,
    possible: true,
    type: "mobile",
    region: "AF",
    national: "070 000 0001",
    ...overrides,
  };
}
function shopkeeper(overrides: Partial<OutreachShopkeeper> = {}): OutreachShopkeeper {
  return {
    account_id: "acct-1",
    email: "ahmad@example.test",
    signed_in: true,
    install_count: 1,
    platform: "android",
    app_version: "2.0.0",
    locale: "fa",
    source: "market-qr",
    attribution: "ip_match",
    installed_at: iso(20),
    first_seen: iso(20),
    last_seen: iso(1),
    last_activity_at: iso(1),
    has_onboarded: true,
    check_in_count: 12,
    usage_entries: 30,
    usage_customers: 8,
    usage_shares: 2,
    kaatas: [
      {
        vault_id: "vault-1",
        name: "Sabz Grocery",
        currency: "AFN",
        role: "owner",
        archived: false,
        member_count: 1,
        people: 8,
        tallies: 30,
        receivable: "1200.50",
        payable: "0.00",
        last_tally_at: iso(2),
      },
    ],
    people: 8,
    tallies: 30,
    receivable_total: "1200.50",
    payable_total: "0.00",
    currency: "AFN",
    last_tally_at: iso(2),
    install_ids: ["install-1"],
    ...overrides,
  };
}
function listing(overrides: Partial<OutreachListing> = {}): OutreachListing {
  return {
    vault_id: "vault-1",
    vault_name: "Sabz Grocery",
    currency: "AFN",
    owner_name: "Ahmad Karimi",
    owner_phone: "+93700000001",
    person_name: "Wali",
    context: "peer",
    archived: false,
    first_added_at: iso(15),
    last_tally_at: iso(3),
    tallies: 4,
    balance: "300.00",
    role: "customer",
    linked: false,
    ...overrides,
  };
}
// mention_count counts distinct BOOKS, as the server does (2026-09-30): one
// book listing a number twice still counts once.
function customer(overrides: Partial<OutreachCustomer> = {}): OutreachCustomer {
  const listings = overrides.listings ?? [listing()];
  return {
    listings,
    mention_count: new Set(listings.map((l) => l.vault_id)).size,
    first_added_at: iso(15),
    last_tally_at: iso(3),
    tallies_total: listings.reduce((sum, l) => sum + l.tallies, 0),
    archived_everywhere: false,
    is_supplier_anywhere: false,
    is_customer_anywhere: true,
    is_wholesaler: false,
    ...overrides,
  };
}
function contact(phone: string, overrides: Partial<OutreachContact> = {}): OutreachContact {
  return {
    phone,
    kind: "shopkeeper",
    name: "Ahmad Karimi",
    shop_name: "Sabz Grocery",
    locale: "fa",
    number: number(),
    shopkeeper: shopkeeper(),
    customer: null,
    outreach: state({ phone }),
    converted: false,
    follow_up_due: false,
    ...overrides,
  };
}
function result(
  contacts: OutreachContact[],
  settings: Record<string, string> = {},
  exclusions: OutreachExclusion[] = [],
  books: OutreachBook[] = [],
): OutreachResult {
  const counts = {
    total: contacts.length,
    shopkeepers: contacts.filter((c) => c.kind === "shopkeeper").length,
    customers: contacts.filter((c) => c.kind === "customer").length,
    both: contacts.filter((c) => c.kind === "both").length,
    wholesalers: contacts.filter((c) => c.customer?.is_wholesaler).length,
    to_contact: contacts.filter((c) => c.outreach.status === "new").length,
    sent: contacts.filter((c) => c.outreach.status === "sent").length,
    replied: contacts.filter((c) => c.outreach.status === "replied").length,
    interested: contacts.filter((c) => c.outreach.status === "interested").length,
    installed: contacts.filter((c) => c.outreach.status === "installed").length,
    declined: contacts.filter(
      (c) => c.outreach.status === "declined" || c.outreach.status === "do_not_contact",
    ).length,
    follow_ups_due: contacts.filter((c) => c.follow_up_due).length,
    converted: contacts.filter((c) => c.converted).length,
    sent_today: 0,
    replied_today: 0,
    pending: contacts.filter((c) => c.outreach.pending_since !== "").length,
    unreachable: contacts.filter(
      (c) => c.outreach.status === "no_whatsapp" || c.outreach.status === "invalid",
    ).length,
    invalid: contacts.filter((c) => !c.number.valid).length,
    opened_today: 0,
  };
  return {
    contacts,
    settings,
    counts,
    exclusions,
    books,
    generated_at: new Date(NOW).toISOString(),
  };
}

// One fixture set exercised by every preset/filter/sort test below.
const fixtures: OutreachContact[] = [
  contact("+93700000001", { name: "Ahmad Karimi", shop_name: "Sabz Grocery" }),
  contact("+93720000002", {
    kind: "customer",
    name: "Wali Wholesale",
    shop_name: "",
    locale: "",
    shopkeeper: null,
    customer: customer({
      listings: [
        listing({ person_name: "Wali", owner_name: "Ahmad Karimi", vault_name: "Sabz Grocery" }),
        listing({
          vault_id: "vault-2",
          vault_name: "Mandawi Rice",
          owner_name: "Zahra Noori",
          owner_phone: "+93790000007",
          person_name: "Wali agha",
          balance: "-450.00",
          role: "supplier",
          currency: "AFN",
        }),
      ],
      is_supplier_anywhere: true,
      is_wholesaler: true,
    }),
    outreach: state({
      phone: "+93720000002",
      status: "sent",
      contacted_at: iso(3),
      first_contacted_at: iso(3),
      contact_count: 1,
    }),
    follow_up_due: true,
  }),
  contact("+93730000003", {
    kind: "both",
    name: "Zahra Noori",
    shop_name: "Mandawi Rice",
    locale: "en",
    shopkeeper: shopkeeper({ locale: "en", last_seen: iso(10), source: "street" }),
    customer: customer({
      listings: [listing({ person_name: "Zahra", balance: "0.00", role: "settled" })],
    }),
    outreach: state({
      phone: "+93730000003",
      status: "replied",
      contacted_at: iso(5),
      first_contacted_at: iso(5),
      replied_at: iso(4),
      contact_count: 2,
    }),
    converted: true,
  }),
  contact("+61400000004", {
    kind: "customer",
    name: "Sara",
    shop_name: "",
    locale: "en",
    number: number({ region: "AU", national: "0400 000 004" }),
    shopkeeper: null,
    customer: customer({
      listings: [
        listing({ archived: true, person_name: "Sara", balance: "0.00", role: "settled" }),
      ],
      archived_everywhere: true,
    }),
    outreach: state({ phone: "+61400000004", status: "declined" }),
  }),
  contact("+93760000005", {
    name: "Karim",
    shop_name: "",
    shopkeeper: shopkeeper({ last_seen: "", signed_in: false, has_onboarded: false }),
    outreach: state({ phone: "+93760000005", status: "do_not_contact" }),
  }),
  contact("+93740000006", {
    kind: "customer",
    name: "Farid Supplier",
    shop_name: "",
    locale: "prs-AF",
    shopkeeper: null,
    customer: customer({
      listings: [listing({ person_name: "Farid", balance: "-90.00", role: "supplier" })],
      is_supplier_anywhere: true,
      is_customer_anywhere: false,
      is_wholesaler: true,
    }),
    outreach: state({ phone: "+93740000006", status: "interested" }),
  }),
  contact("+93790000007", {
    name: "Nazir",
    shop_name: "Nazir Store",
    locale: "fa",
    shopkeeper: shopkeeper({
      last_seen: iso(45),
      platform: "iOS",
      people: 2,
      tallies: 3,
      receivable_total: "40.00",
    }),
    outreach: state({ phone: "+93790000007", status: "installed" }),
  }),
  // A live app user (signed in, seen yesterday) whose only listing was
  // archived by the shop that kept it: archived_everywhere is true, but the
  // row is "both", not a pure customer, so the default view must keep it.
  contact("+93780000008", {
    kind: "both",
    name: "Hamid Rahimi",
    shop_name: "Hamid Bakery",
    locale: "fa",
    shopkeeper: shopkeeper({
      account_id: "acct-8",
      email: "hamid@example.test",
      last_seen: iso(1),
      people: 3,
      tallies: 5,
      receivable_total: "80.00",
    }),
    customer: customer({
      listings: [
        listing({
          vault_id: "vault-7",
          vault_name: "Nazir Store",
          owner_name: "Nazir",
          owner_phone: "+93790000007",
          person_name: "Hamid",
          archived: true,
          balance: "0.00",
          role: "settled",
        }),
      ],
      archived_everywhere: true,
    }),
    outreach: state({ phone: "+93780000008" }),
  }),
];
const ids = (rows: OutreachContact[]) => rows.map((row) => row.phone);

// The prospect queue's edge cases: pure customers, one per rule. Appended to
// the base fixtures where a test needs them; none of the base fixtures is a
// prospect (their statuses moved on), which the tests below pin too.
function prospect(
  phone: string,
  overrides: Partial<OutreachContact> = {},
  s: Partial<OutreachState> = {},
): OutreachContact {
  return contact(phone, {
    kind: "customer",
    name: `Prospect ${phone.slice(-3)}`,
    shop_name: "",
    locale: "fa",
    shopkeeper: null,
    customer: customer({ listings: [listing({ person_name: `P${phone.slice(-3)}` })] }),
    outreach: state({ phone, ...s }),
    ...overrides,
  });
}
const queue: OutreachContact[] = [
  prospect("+93700000101"),
  // Opened 12 h ago, nothing recorded since.
  prospect(
    "+93700000102",
    {},
    { opened_at: iso(0.5), pending_since: iso(0.5), open_count: 1, version: 2 },
  ),
  // Skipped at the first instant of today's Kabul day.
  prospect("+93700000103", {}, { skipped_at: KABUL_MIDNIGHT, version: 1 }),
  // Skipped one second before that: yesterday, so it is back.
  prospect("+93700000104", {}, { skipped_at: "2026-09-28T19:29:59Z", version: 1 }),
  // The numbering plan rejects it; status is still New.
  prospect("+93700000105", {
    number: number({ valid: false, possible: false, type: "unknown", national: "" }),
  }),
  // Valid, but Australian.
  prospect("+61400000106", { number: number({ region: "AU", national: "0400 000 106" }) }),
  prospect("+93700000107", {}, { status: "no_whatsapp", version: 3 }),
  prospect("+93700000108", {}, { status: "invalid", version: 1 }),
  prospect("+93700000109", {
    customer: customer({ listings: [listing({ archived: true })], archived_everywhere: true }),
  }),
  // Opened two days ago: the oldest pending chat.
  prospect(
    "+93700000110",
    {},
    { opened_at: iso(2), pending_since: iso(2), open_count: 3, version: 5 },
  ),
  // A landline: valid and New, but not a mobile, so never a prospect
  // (2026-09-30: Prospects is mobile numbers only).
  prospect("+93201000111", {
    number: number({ type: "fixed_line", national: "020 100 0111" }),
  }),
  // Messaged once, then reset to New from the status menu: New and valid,
  // but first contact only — never a prospect, never offered by Open next.
  prospect(
    "+93700000112",
    {},
    { contact_count: 1, contacted_at: iso(4), first_contacted_at: iso(4), version: 3 },
  ),
];
const all = [...fixtures, ...queue];
// Chats that were opened and later resolved (2026-09-30). never_messaged is
// the server's reading of the whole touch log, so these carry the flag the
// server would send, not the helper's derived default.
const resolved: OutreachContact[] = [
  // Opened, marked Interested, then reset to New: New, no recorded send, not
  // pending — but the chat was never closed as nothing sent, so a message may
  // have gone out. Never a first contact again.
  prospect(
    "+93700000113",
    {},
    { opened_at: iso(2), open_count: 1, never_messaged: false, version: 3 },
  ),
  // Opened, then "Skip for now" yesterday: nothing was sent, so it is a first
  // contact again, back in the queue today.
  prospect(
    "+93700000114",
    {},
    {
      opened_at: "2026-09-28T19:00:00Z",
      skipped_at: "2026-09-28T19:29:59Z",
      open_count: 1,
      never_messaged: true,
      version: 2,
    },
  ),
  // The same, skipped this morning: out until the next Kabul day.
  prospect(
    "+93700000115",
    {},
    {
      opened_at: "2026-09-29T01:55:00Z",
      skipped_at: "2026-09-29T02:00:00Z",
      open_count: 1,
      never_messaged: true,
      version: 2,
    },
  ),
];
// The next Kabul reporting day, when today's skips are over.
const TOMORROW = NOW + 86_400_000;

// The Books list (2026-09-30): the books behind the fixtures' listings.
function book(overrides: Partial<OutreachBook> = {}): OutreachBook {
  return {
    vault_id: "vault-1",
    name: "Sabz Grocery",
    currency: "AFN",
    archived: false,
    created_at: iso(30),
    owner_account_id: "acct-1",
    owner_name: "Ahmad Karimi",
    owner_email: "ahmad@example.test",
    owner_phone: "+93700000001",
    member_count: 1,
    people: 8,
    numbers: 4,
    tallies: 30,
    last_tally_at: iso(2),
    ...overrides,
  };
}
const books: OutreachBook[] = [
  book(),
  book({
    vault_id: "vault-2",
    name: "Mandawi Rice",
    owner_account_id: "acct-2",
    owner_name: "Zahra Noori",
    owner_email: "zahra@example.test",
    owner_phone: "+93790000007",
    people: 1,
    numbers: 1,
    tallies: 4,
    last_tally_at: iso(1),
    created_at: iso(40),
  }),
  // No owner name and no owner phone; archived; never a tally.
  book({
    vault_id: "vault-7",
    name: "Nazir Store",
    archived: true,
    owner_account_id: "acct-7",
    owner_name: "",
    owner_email: "nazir@example.test",
    owner_phone: "",
    people: 3,
    numbers: 1,
    tallies: 0,
    last_tally_at: "",
    created_at: iso(5),
  }),
  // Ahmad's second book: nothing in it yet.
  book({
    vault_id: "vault-9",
    name: "Test book",
    people: 0,
    numbers: 0,
    tallies: 0,
    last_tally_at: "",
    created_at: iso(1),
  }),
];
const vaultIds = (rows: OutreachBook[]) => rows.map((row) => row.vault_id);

test("statuses gained the two unreachable verdicts with their labels", () => {
  assert.deepEqual(OUTREACH_STATUSES.slice(-2), ["no_whatsapp", "invalid"]);
  assert.equal(STATUS_LABELS.no_whatsapp, "Not on WhatsApp");
  assert.equal(STATUS_LABELS.invalid, "Invalid number");
});

test("normalizeDigits maps Persian and Arabic-Indic digits; international form handles 00 and 0", () => {
  assert.equal(normalizeDigits("۰۷۰۰ ١٢٣"), "0700 123");
  assert.equal(internationalDigits("0093 700 123 456"), "93700123456");
  assert.equal(internationalDigits("0700 123 456"), "93700123456");
  assert.equal(internationalDigits("+۹۳ (۷۰۰) ۱۲۳-۴۵۶"), "93700123456");
  assert.equal(internationalDigits("700123456"), "700123456");
});

test("dialCode uses the longest matching prefix and labels unknown codes as +NNN", () => {
  assert.deepEqual(dialCode("+971501234567"), { code: "+971", country: "UAE" });
  assert.deepEqual(dialCode("+93700000001"), { code: "+93", country: "Afghanistan" });
  assert.deepEqual(dialCode("+12125551234"), { code: "+1", country: "US/Canada" });
  assert.deepEqual(dialCode("+79161234567"), { code: "+7", country: "Russia/Kazakhstan" });
  assert.deepEqual(dialCode("+5999123456"), { code: "+599", country: "+599" });
  assert.deepEqual(dialCode(""), { code: "", country: "" });
});

test("afghanCarrier reads the two digits after +93 and is blank elsewhere", () => {
  const cases: [string, string][] = [
    ["+93700000001", "AWCC"],
    ["+93710000001", "AWCC"],
    ["+93720000001", "Roshan"],
    ["+93790000001", "Roshan"],
    ["+93730000001", "Etisalat"],
    ["+93780000001", "Etisalat"],
    ["+93760000001", "MTN"],
    ["+93770000001", "MTN"],
    ["+93740000001", "Salaam"],
    ["+93750000001", "Salaam"],
    ["+93200000001", "Other"],
    ["+61400000004", ""],
  ];
  for (const [phone, carrier] of cases) assert.equal(afghanCarrier(phone), carrier, phone);
});

test("number helpers read the numbering-plan verdict and never guess", () => {
  assert.equal(numberTypeLabel("mobile"), "mobile");
  assert.equal(numberTypeLabel("fixed_line"), "fixed line");
  assert.equal(numberTypeLabel("fixed_line_or_mobile"), "fixed or mobile");
  assert.equal(numberTypeLabel("unknown"), "");
  assert.equal(numberTypeLabel(""), "");
  assert.equal(numberCaption(number()), "AF · mobile");
  assert.equal(numberCaption(number({ type: "unknown" })), "AF");
  assert.equal(numberCaption(DEFAULT_OUTREACH_NUMBER), "");
  assert.equal(isMobileNumber(number()), true);
  assert.equal(isMobileNumber(number({ type: "fixed_line_or_mobile" })), true);
  assert.equal(isMobileNumber(number({ type: "fixed_line" })), false);
  assert.equal(isMobileNumber(DEFAULT_OUTREACH_NUMBER), false);
  assert.equal(DEFAULT_OUTREACH_NUMBER.valid, true, "a missing verdict never hides a row");
});

test("money parses decimal strings into integer hundredths and formats them back", () => {
  assert.equal(parseMoney("1234.50"), 123450);
  assert.equal(parseMoney("-300.00"), -30000);
  assert.equal(parseMoney("0.5"), 50);
  assert.equal(parseMoney("12"), 1200);
  assert.equal(parseMoney(""), 0);
  assert.equal(parseMoney(undefined), 0);
  assert.equal(formatMoney(123450), "1234.50");
  assert.equal(formatMoney(-30000), "-300.00");
  assert.equal(formatMoney(123450, true), "1,234.50");
});

test("balance summary keeps currencies apart and splits owes from owed", () => {
  const summary = balanceSummary(
    customer({
      listings: [
        listing({ balance: "300.00", currency: "AFN" }),
        listing({ balance: "-450.00", currency: "AFN" }),
        listing({ balance: "20.25", currency: "USD" }),
      ],
    }),
  );
  assert.deepEqual(summary, [
    { currency: "AFN", owes: 30000, owed: 45000, listings: 2 },
    { currency: "USD", owes: 2025, owed: 0, listings: 1 },
  ]);
  assert.deepEqual(balanceSummary(null), []);
});

test("each preset selects exactly its fixture rows", () => {
  const run = (preset: Parameters<typeof presetFilters>[0]) =>
    ids(filterOutreach(fixtures, presetFilters(preset), "", NOW));
  // Archived-everywhere PURE customers are hidden by default; the "both" row
  // whose listing was archived stays, it is a live app user.
  assert.deepEqual(run("all"), [
    "+93700000001",
    "+93720000002",
    "+93730000003",
    "+93760000005",
    "+93740000006",
    "+93790000007",
    "+93780000008",
  ]);
  assert.deepEqual(run("shopkeepers"), ["+93700000001", "+93760000005", "+93790000007"]);
  assert.deepEqual(run("customers"), ["+93720000002", "+93740000006"]);
  assert.deepEqual(run("wholesalers"), ["+93720000002", "+93740000006"]);
  assert.deepEqual(run("to_contact"), ["+93700000001", "+93780000008"]);
  assert.deepEqual(run("follow_ups"), ["+93720000002"]);
  assert.deepEqual(run("sent"), ["+93720000002"]);
  assert.deepEqual(run("replied"), ["+93730000003"]);
  assert.deepEqual(run("interested"), ["+93740000006"]);
  assert.deepEqual(run("installed"), ["+93790000007"]);
  // Status presets show archived customers: Sara was declined, then archived.
  assert.deepEqual(run("declined"), ["+61400000004", "+93760000005"]);
  // None of the base fixtures is a prospect, pending or unreachable.
  assert.deepEqual(run("prospects"), []);
  assert.deepEqual(run("pending"), []);
  assert.deepEqual(run("unreachable"), []);
  assert.deepEqual(
    ids(filterOutreach(fixtures, { ...presetFilters("declined"), archived: "hide" }, "", NOW)),
    ["+93760000005"],
  );
  for (const preset of [
    "all",
    "prospects",
    "shopkeepers",
    "customers",
    "wholesalers",
    "to_contact",
  ] as const)
    assert.equal(presetFilters(preset).archived, "hide", preset);
  for (const preset of [
    "sent",
    "replied",
    "interested",
    "installed",
    "declined",
    "follow_ups",
    "pending",
    "unreachable",
  ] as const)
    assert.equal(presetFilters(preset).archived, "show", preset);
  // An archived customer mid-conversation stays in the follow-up queue.
  const archivedSent = contact("+61400000009", {
    kind: "customer",
    name: "Omid",
    shop_name: "",
    shopkeeper: null,
    customer: customer({
      listings: [listing({ archived: true, person_name: "Omid" })],
      archived_everywhere: true,
    }),
    outreach: state({
      phone: "+61400000009",
      status: "sent",
      contacted_at: iso(3),
      first_contacted_at: iso(3),
      contact_count: 1,
    }),
    follow_up_due: true,
  });
  assert.deepEqual(
    ids(filterOutreach([...fixtures, archivedSent], presetFilters("follow_ups"), "", NOW)),
    ["+93720000002", "+61400000009"],
  );
  assert.deepEqual(
    ids(filterOutreach([...fixtures, archivedSent], presetFilters("sent"), "", NOW)),
    ["+93720000002", "+61400000009"],
  );
  assert.equal(activePreset(presetFilters("follow_ups")), "follow_ups");
  assert.equal(activePreset(presetFilters("sent")), "sent");
  assert.equal(activePreset(presetFilters("prospects")), "prospects");
  assert.equal(activePreset(presetFilters("pending")), "pending");
  assert.equal(activePreset(presetFilters("unreachable")), "unreachable");
  assert.equal(activePreset({ ...presetFilters("follow_ups"), country: "+93" }), undefined);
  assert.equal(activePreset({ ...presetFilters("sent"), archived: "hide" }), undefined);
  assert.equal(activePreset({ ...presetFilters("prospects"), country: "" }), undefined);
  assert.equal(activePreset({ ...presetFilters("prospects"), contacted: "all" }), undefined);
  assert.equal(activePreset({ ...presetFilters("prospects"), numberType: "all" }), undefined);
  assert.equal(presetFilters("prospects").contacted, "never", "first contact only");
  assert.equal(OUTREACH_PRESETS[1].id, "prospects", "Prospects is the first tab after All");
});

test("the prospect queue: preset and predicate agree, and each rule removes its row", () => {
  const prospects = ids(filterOutreach(all, presetFilters("prospects"), "", NOW));
  // +93700000112 was messaged before and reset to New, and +93201000111 is a
  // landline (Prospects is mobile numbers only): in neither list.
  assert.deepEqual(prospects, ["+93700000101", "+93700000104"]);
  assert.equal(
    all.some((c) => c.phone === "+93700000112"),
    true,
  );
  assert.equal(
    all.some((c) => c.phone === "+93201000111"),
    true,
  );
  assert.deepEqual(ids(all.filter((c) => isProspect(c, NOW, "+93"))), prospects);
  assert.deepEqual(ids(all.filter((c) => isProspect(c, NOW))), prospects, "+93 is the default");
  // No country: the Australian number joins; the other rules still apply.
  assert.deepEqual(ids(all.filter((c) => isProspect(c, NOW, ""))), [
    "+93700000101",
    "+93700000104",
    "+61400000106",
  ]);
  // Mobile numbers only: the landline is out of both lists and the same row
  // with a mobile verdict is in; a fixed-or-mobile number counts as mobile,
  // an unknown type does not.
  const landline = all.find((c) => c.phone === "+93201000111")!;
  assert.equal(landline.number.type, "fixed_line");
  assert.equal(isProspect(landline, NOW), false);
  assert.equal(isProspect({ ...landline, number: number() }, NOW), true);
  assert.equal(presetFilters("prospects").numberType, "mobile");
  const typed = [
    ...all,
    prospect("+93700000119", { number: number({ type: "fixed_line_or_mobile" }) }),
    prospect("+93700000120", { number: number({ type: "unknown" }) }),
  ];
  const typedProspects = ids(filterOutreach(typed, presetFilters("prospects"), "", NOW));
  assert.deepEqual(typedProspects, ["+93700000101", "+93700000104", "+93700000119"]);
  assert.deepEqual(ids(typed.filter((c) => isProspect(c, NOW))), typedProspects);
  assert.deepEqual(ids(all.filter((c) => isProspect(c, NOW, "+61"))), ["+61400000106"]);
  // A shopkeeper or "both" row is never a prospect, whatever its status.
  assert.equal(isProspect(fixtures[0], NOW, ""), false);
  assert.equal(isProspect(fixtures[7], NOW, ""), false);
  // Converted is read from the server: a customer flagged converted drops out.
  assert.equal(isProspect({ ...queue[0], converted: true }, NOW), false);
  assert.deepEqual(ids(filterOutreach(all, presetFilters("pending"), "", NOW)), [
    "+93700000102",
    "+93700000110",
  ]);
  assert.deepEqual(ids(filterOutreach(all, presetFilters("unreachable"), "", NOW)), [
    "+93700000107",
    "+93700000108",
  ]);
  // Chats opened and later resolved: the preset and the predicate still pick
  // identical rows. Opened → Interested → New (113) is out for good; opened →
  // skipped is a first contact again once its skip day is over (114 today,
  // 115 tomorrow, together with the base queue's own skip, 103).
  const reopened = [...all, ...resolved];
  const today = ids(filterOutreach(reopened, presetFilters("prospects"), "", NOW));
  assert.deepEqual(today, ["+93700000101", "+93700000104", "+93700000114"]);
  assert.deepEqual(ids(reopened.filter((c) => isProspect(c, NOW))), today);
  const tomorrow = ids(filterOutreach(reopened, presetFilters("prospects"), "", TOMORROW));
  assert.deepEqual(tomorrow, [
    "+93700000101",
    "+93700000103",
    "+93700000104",
    "+93700000114",
    "+93700000115",
  ]);
  assert.deepEqual(ids(reopened.filter((c) => isProspect(c, TOMORROW))), tomorrow);
});

test("first contact follows never_messaged: an unresolved open never returns, a skipped one does", () => {
  const [reopened, skippedYesterday, skippedToday] = resolved;
  // Opened → Interested → New passes every other rule and is still no first contact.
  assert.equal(reopened.outreach.status, "new");
  assert.equal(reopened.outreach.contact_count, 0);
  assert.equal(isPending(reopened), false);
  assert.equal(isSkippedToday(reopened, NOW), false);
  assert.equal(isNeverMessaged(reopened), false);
  assert.equal(canOpen(reopened, NOW), false);
  assert.equal(isProspect(reopened, NOW), false);
  assert.equal(isProspect(reopened, TOMORROW), false, "not a matter of time");
  // Opened → skipped: nothing was sent, so it returns once the skip day is over.
  assert.equal(isNeverMessaged(skippedYesterday), true);
  assert.equal(canOpen(skippedYesterday, NOW), true);
  assert.equal(isProspect(skippedYesterday, NOW), true);
  assert.equal(canOpen(skippedToday, NOW), false);
  assert.equal(isProspect(skippedToday, NOW), false);
  assert.equal(canOpen(skippedToday, TOMORROW), true);
  assert.equal(isProspect(skippedToday, TOMORROW), true);
  // Open next steps over the unresolved open.
  assert.equal(nextToOpen(resolved, NOW)?.phone, "+93700000114");
  assert.equal(openableCount(resolved, TOMORROW), 2);
  // A recorded send always wins over the flag, however the state was built.
  const inconsistent = {
    ...skippedYesterday,
    outreach: { ...skippedYesterday.outreach, contact_count: 1 },
  };
  assert.equal(isNeverMessaged(inconsistent), false);
  assert.equal(canOpen(inconsistent, NOW), false);
  assert.equal(isProspect(inconsistent, NOW), false);
  // "Messaged before": Never messaged / Messaged or opened.
  const f = (contacted: "never" | "ever") =>
    ids(filterOutreach(resolved, { ...DEFAULT_OUTREACH_FILTERS, contacted }, "", NOW));
  assert.deepEqual(f("never"), ["+93700000114", "+93700000115"]);
  assert.deepEqual(f("ever"), ["+93700000113"]);
});

test("pending and skipped-today are read from state; a skip is a Kabul-day fact", () => {
  assert.equal(isPending(queue[0]), false);
  assert.equal(isPending(queue[1]), true);
  const skippedAt = (at: string) =>
    contact("+93700000200", { outreach: state({ phone: "+93700000200", skipped_at: at }) });
  assert.equal(isSkippedToday(skippedAt(KABUL_MIDNIGHT), NOW), true);
  assert.equal(isSkippedToday(skippedAt("2026-09-28T19:29:59Z"), NOW), false);
  // The first second of tomorrow's Kabul day is another day too.
  assert.equal(isSkippedToday(skippedAt("2026-09-29T19:30:00Z"), NOW), false);
  assert.equal(isSkippedToday(skippedAt(""), NOW), false);
  assert.equal(isSkippedToday(skippedAt("not a date"), NOW), false);
  // Yesterday's skip counts as skipped when "now" was yesterday.
  assert.equal(
    isSkippedToday(skippedAt("2026-09-28T19:29:59Z"), Date.parse("2026-09-28T10:00:00Z")),
    true,
  );
});

test("nextToOpen takes the first openable row in view order; pending rows list oldest first", () => {
  assert.equal(nextToOpen(queue, NOW)?.phone, "+93700000101");
  // Pending and skipped-today rows are stepped over; yesterday's skip is back.
  assert.equal(nextToOpen(queue.slice(1), NOW)?.phone, "+93700000104");
  // Invalid per the plan, unreachable statuses and pending rows never open;
  // country and archive state are the VIEW's business, not this picker's.
  assert.equal(nextToOpen(queue.slice(4), NOW)?.phone, "+61400000106");
  assert.equal(nextToOpen(queue.slice(6, 8), NOW), undefined);
  assert.equal(nextToOpen([queue[1], queue[9]], NOW), undefined);
  assert.equal(nextToOpen([], NOW), undefined);
  assert.equal(openableCount(queue, NOW), 5);
  assert.equal(canOpen({ ...queue[0], converted: true }, NOW), false);
  assert.equal(canOpen(fixtures[0], NOW), true, "a New shopkeeper is openable in its view");
  assert.equal(canOpen(fixtures[1], NOW), false, "sent is not New");
  assert.deepEqual(ids(pendingRows(all)), ["+93700000110", "+93700000102"]);
  assert.deepEqual(pendingRows(fixtures), []);
  assert.deepEqual(ids(all).length, 20, "pendingRows must not mutate the input");
});

test("first contact only: a number messaged before is never a prospect nor offered by Open next", () => {
  const messaged = queue[11];
  assert.equal(messaged.outreach.status, "new");
  assert.equal(messaged.number.valid, true);
  assert.equal(canOpen(messaged, NOW), false);
  assert.equal(isProspect(messaged, NOW), false);
  assert.equal(isProspect(messaged, NOW, ""), false);
  // One recorded send is enough, whatever the status says.
  const once = { ...queue[0], outreach: { ...queue[0].outreach, contact_count: 1 } };
  assert.equal(canOpen(once, NOW), false);
  assert.equal(isProspect(once, NOW), false);
  assert.equal(nextToOpen([messaged, once, queue[3]], NOW)?.phone, "+93700000104");
  // "Messaged before" follows never_messaged: "ever" is a recorded send or a
  // chat opened and not closed as nothing sent — the two pending chats
  // (+93700000102, +93700000110) included — and "never" is everything else.
  const f = (contacted: "all" | "never" | "ever") =>
    ids(filterOutreach(all, { ...DEFAULT_OUTREACH_FILTERS, archived: "show", contacted }, "", NOW));
  assert.deepEqual(f("ever"), [
    "+93720000002",
    "+93730000003",
    "+93700000102",
    "+93700000110",
    "+93700000112",
  ]);
  assert.equal(f("never").includes("+93700000112"), false);
  assert.equal(f("never").length, all.length - 5);
  assert.equal(f("all").length, all.length);
});

test("status gates mirror the server; a row offers a chat only outside them", () => {
  assert.deepEqual(OUTREACH_STATUSES.filter(isStoppedStatus), ["declined", "do_not_contact"]);
  assert.deepEqual(OUTREACH_STATUSES.filter(isUnreachableStatus), ["no_whatsapp", "invalid"]);
  assert.deepEqual(OUTREACH_STATUSES.filter(isSendableStatus), ["new", "no_whatsapp", "invalid"]);
  assert.equal(offersChat(fixtures[0]), true, "New");
  assert.equal(offersChat(fixtures[1]), true, "a sent row can be reopened for a follow-up");
  assert.equal(offersChat(fixtures[3]), false, "declined");
  assert.equal(offersChat(fixtures[4]), false, "do not contact");
  assert.equal(offersChat(queue[6]), false, "not on WhatsApp: Retry first");
  assert.equal(offersChat(queue[7]), false, "marked invalid: Retry first");
  assert.equal(offersChat(queue[4]), true, "invalid per the plan stays a manual override");
});

test("presetCounts equals the length of the list each card or tab opens", () => {
  const counts = presetCounts(all, NOW);
  for (const preset of OUTREACH_PRESETS)
    assert.equal(
      counts[preset.id],
      filterOutreach(all, presetFilters(preset.id), "", NOW).length,
      preset.id,
    );
  assert.equal(counts.all, 18);
  // The landline is New, valid and never messaged, but not a mobile.
  assert.equal(counts.prospects, 2);
  assert.equal(counts.pending, 2);
  assert.equal(counts.unreachable, 2);
  // Twelve New rows, minus the archived-everywhere pure customer the tab hides.
  assert.equal(counts.to_contact, 11);
  assert.equal(counts.declined, 2);
  assert.equal(counts.converted, filterOutreach(all, CONVERTED_FILTERS, "", NOW).length);
  assert.equal(counts.converted, 1);
  // The server's total counts the archived customers the "all" view hides.
  assert.equal(result(all).counts.total, 20);
  assert.deepEqual(presetCounts([], NOW).all, 0);
});

test("filters cover country, carrier, direction, already-a-user, last seen, replied and minimums", () => {
  const f = (patch: Partial<typeof DEFAULT_OUTREACH_FILTERS>) =>
    ids(
      filterOutreach(
        fixtures,
        { ...DEFAULT_OUTREACH_FILTERS, archived: "show", ...patch },
        "",
        NOW,
      ),
    );
  assert.deepEqual(f({ country: "+61" }), ["+61400000004"]);
  assert.deepEqual(f({ carrier: "Roshan" }), ["+93720000002", "+93790000007"]);
  assert.deepEqual(f({ direction: "supplier" }), ["+93720000002", "+93740000006"]);
  assert.deepEqual(f({ alreadyUser: "yes" }), ["+93730000003", "+93780000008"]);
  assert.deepEqual(f({ alreadyUser: "no" }), ["+93720000002", "+61400000004", "+93740000006"]);
  assert.deepEqual(f({ lastSeen: "7d" }), ["+93700000001", "+93780000008"]);
  assert.deepEqual(f({ lastSeen: "30d" }), ["+93700000001", "+93730000003", "+93780000008"]);
  assert.deepEqual(f({ lastSeen: "older" }), ["+93790000007"]);
  assert.deepEqual(f({ lastSeen: "never" }), [
    "+93720000002",
    "+61400000004",
    "+93760000005",
    "+93740000006",
  ]);
  assert.deepEqual(f({ replied: "yes" }), ["+93730000003"]);
  assert.deepEqual(f({ signedIn: "no" }), ["+93760000005"]);
  assert.deepEqual(f({ onboarded: "no" }), ["+93760000005"]);
  assert.deepEqual(f({ converted: "yes" }), ["+93730000003"]);
  assert.deepEqual(f({ archived: "only" }), ["+61400000004", "+93780000008"]);
  assert.deepEqual(f({ archived: "hide", kind: "both" }), ["+93730000003", "+93780000008"]);
  assert.deepEqual(f({ minMentions: 2 }), ["+93720000002"]);
  // Karim's install inherits the fixture receivable, so he counts too.
  assert.deepEqual(f({ minReceivable: 100 }), ["+93700000001", "+93730000003", "+93760000005"]);
  assert.deepEqual(f({ minReceivable: 1201 }), []);
  assert.deepEqual(f({ minTallies: 31 }), ["+93730000003"]);
  assert.deepEqual(f({ platform: "ios" }), ["+93790000007"]);
  assert.deepEqual(f({ language: "__unknown__" }), ["+93720000002"]);
  assert.deepEqual(f({ source: "street" }), ["+93730000003"]);
  assert.deepEqual(f({ contactedFrom: "2026-09-25", contactedTo: "2026-09-26" }), ["+93720000002"]);
});

test("filters cover validity, number type, pending, skipped today and the unreachable status", () => {
  const f = (patch: Partial<typeof DEFAULT_OUTREACH_FILTERS>) =>
    ids(filterOutreach(all, { ...DEFAULT_OUTREACH_FILTERS, archived: "show", ...patch }, "", NOW));
  assert.deepEqual(f({ validity: "invalid" }), ["+93700000105"]);
  assert.equal(f({ validity: "valid" }).includes("+93700000105"), false);
  assert.equal(f({ validity: "valid" }).length, all.length - 1);
  assert.deepEqual(f({ numberType: "fixed" }), ["+93201000111"]);
  const mobile = f({ numberType: "mobile" });
  assert.equal(mobile.includes("+93201000111"), false, "a landline is not mobile");
  assert.equal(mobile.includes("+93700000105"), false, "unknown type is not mobile");
  assert.equal(mobile.length, all.length - 2);
  assert.deepEqual(f({ pending: "yes" }), ["+93700000102", "+93700000110"]);
  assert.equal(f({ pending: "no" }).includes("+93700000102"), false);
  assert.equal(f({ pending: "no" }).length, all.length - 2);
  assert.deepEqual(f({ skipped: "only" }), ["+93700000103"]);
  const unskipped = f({ skipped: "hide" });
  assert.equal(unskipped.includes("+93700000103"), false);
  assert.equal(unskipped.includes("+93700000104"), true, "yesterday's skip is back");
  assert.deepEqual(f({ status: "unreachable" }), ["+93700000107", "+93700000108"]);
  assert.deepEqual(f({ status: "no_whatsapp" }), ["+93700000107"]);
  assert.deepEqual(f({ status: "invalid" }), ["+93700000108"]);
});

test("search covers listing names, owners, shops, email and normalized phone digits", () => {
  const s = (search: string) =>
    ids(filterOutreach(fixtures, { ...DEFAULT_OUTREACH_FILTERS, archived: "show" }, search, NOW));
  assert.deepEqual(s("wali agha"), ["+93720000002"]);
  assert.deepEqual(s("mandawi"), ["+93720000002", "+93730000003"]);
  // Email lives on the shopkeeper block only; pure customers have none.
  assert.deepEqual(s("ahmad@example.test"), [
    "+93700000001",
    "+93730000003",
    "+93760000005",
    "+93790000007",
  ]);
  assert.deepEqual(s("0720 000 002"), ["+93720000002"]);
  assert.deepEqual(s("0093 720 000 002"), ["+93720000002"]);
  assert.deepEqual(s("+۹۳ ۷۲۰"), ["+93720000002"]);
  assert.deepEqual(s("0061 400"), []);
  assert.deepEqual(s("61400000004"), ["+61400000004"]);
  assert.deepEqual(s("sara nowhere"), []);
});

test("sorting keeps missing values last in both directions and breaks ties by phone", () => {
  const desc = ids(sortOutreach(fixtures, "last_seen", true));
  // 001 and 008 were both seen a day ago; the tie breaks on the phone.
  assert.deepEqual(desc.slice(0, 4), [
    "+93700000001",
    "+93780000008",
    "+93730000003",
    "+93790000007",
  ]);
  assert.deepEqual(desc.slice(4), ["+61400000004", "+93720000002", "+93740000006", "+93760000005"]);
  const asc = ids(sortOutreach(fixtures, "last_seen", false));
  assert.deepEqual(asc.slice(0, 4), [
    "+93790000007",
    "+93730000003",
    "+93700000001",
    "+93780000008",
  ]);
  assert.deepEqual(asc.slice(4), desc.slice(4));
  assert.deepEqual(ids(sortOutreach(fixtures, "mentions", true)).slice(0, 1), ["+93720000002"]);
  assert.equal(ids(sortOutreach(fixtures, "name", false))[0], "+93700000001");
  assert.equal(ids(sortOutreach(fixtures, "receivable", true))[0], "+93700000001");
  assert.deepEqual(ids(sortOutreach(fixtures, "phone", false)).slice(0, 2), [
    "+61400000004",
    "+93700000001",
  ]);
  assert.deepEqual(ids(fixtures).length, 8, "sorting must not mutate the input");
});

test("fillTemplate puts the link alone on its own line and collapses a missing name", () => {
  const link = "https://kaata.af/download?s=wa-shop";
  const en = fillTemplate(DEFAULT_TEMPLATES["template.shopkeeper.en"], {
    name: "",
    shop: "",
    link,
  });
  assert.equal(en.startsWith("Salaam. This is the Kaata team."), true, en);
  assert.deepEqual(en.split("\n")[1], link);
  const named = fillTemplate(DEFAULT_TEMPLATES["template.shopkeeper.en"], {
    name: "Ahmad",
    shop: "",
    link,
  });
  assert.equal(named.startsWith("Salaam Ahmad. This is"), true);
  const fa = fillTemplate(DEFAULT_TEMPLATES["template.shopkeeper.fa"], {
    name: "",
    shop: "",
    link,
  });
  assert.equal(fa.startsWith("سلام. از تیم کاتا هستیم."), true, fa);
  assert.equal(fa.includes("می‌دهد"), true, "Persian text (with ZWNJ) untouched");
  assert.equal(fa.split("\n")[1], link);
  assert.equal(fa.split("\n").length, 3);
  assert.equal(
    fillTemplate("Install here: {link} today {shop}", { name: "", shop: "Sabz", link }),
    `Install here:\n${link}\ntoday Sabz`,
  );
  assert.equal(
    fillTemplate("No placeholder at all", { name: "", shop: "", link }),
    `No placeholder at all\n${link}`,
  );
  assert.equal(
    fillTemplate("Hi {name},\r\n{link}", { name: "Sara", shop: "", link }),
    `Hi Sara,\n${link}`,
  );
});

// A contact with a per-number message language, as the server stores it.
const speaking = (c: OutreachContact, lang: OutreachLang): OutreachContact => ({
  ...c,
  outreach: { ...c.outreach, lang },
});
const AUTO = { "pref.message_lang": "auto" };

test("the locale rule (Auto) reads fa and prs as Dari; templates and slugs come from settings", () => {
  assert.equal(localeLanguage("fa"), "fa");
  assert.equal(localeLanguage("prs-AF"), "fa");
  assert.equal(localeLanguage("fa-AF"), "fa");
  assert.equal(localeLanguage("en"), "en");
  assert.equal(localeLanguage(""), "en");
  const shop = buildMessage(fixtures[0], {});
  assert.equal(shop.templateKey, "template.shopkeeper.fa");
  assert.equal(shop.link, "https://kaata.af/download?s=wa-shop");
  assert.equal(shop.text.split("\n")[1], shop.link);
  // On Auto the customer's empty locale reads as English.
  const cust = buildMessage(fixtures[1], {
    ...AUTO,
    "slug.customer": "Flyer Two!",
    "template.customer.en": "Hello {name}",
  });
  assert.equal(cust.language, "en");
  assert.equal(cust.templateKey, "template.customer.en");
  assert.equal(cust.link, "https://kaata.af/download?s=flyer-two");
  assert.equal(cust.text, `Hello Wali Wholesale\n${cust.link}`);
  // A person's Dari wins over Auto's English locale.
  const both = buildMessage(speaking(fixtures[2], "fa"), {
    ...AUTO,
    "template.shopkeeper.en": "   ",
  });
  assert.equal(both.templateKey, "template.shopkeeper.fa");
  assert.equal(both.audience, "shopkeeper");
  assert.equal(buildMessage(fixtures[2], AUTO).text.startsWith("Salaam Zahra Noori."), true);
  // A blank saved template falls back to the default.
  assert.equal(
    buildMessage(fixtures[2], { ...AUTO, "template.shopkeeper.en": "   " }).text.startsWith(
      "Salaam Zahra Noori. This is the Kaata team.",
    ),
    true,
  );
});

test("message language: the person's choice, then the session's (Dari by default), then Auto's locale", () => {
  assert.equal(SESSION_LANGUAGE_KEY, "pref.message_lang");
  assert.deepEqual(
    SESSION_LANGUAGE_OPTIONS.map(([value]) => value),
    ["fa", "en", "auto"],
  );
  assert.deepEqual(LANGUAGE_NAMES, { fa: "Dari", en: "English" });
  // The session choice: Dari unless the server holds en or auto.
  assert.equal(sessionLanguage({}), "fa");
  assert.equal(sessionLanguage({ "pref.message_lang": "fa" }), "fa");
  assert.equal(sessionLanguage({ "pref.message_lang": "en" }), "en");
  assert.equal(sessionLanguage(AUTO), "auto");
  for (const junk of ["", "ps", "EN", " en", "Auto", "prs"])
    assert.equal(sessionLanguage({ "pref.message_lang": junk }), "fa", junk);
  // Zahra's app runs in English, Ahmad's in Dari.
  const zahra = fixtures[2];
  const ahmad = fixtures[0];
  const session = (value?: string): Record<string, string> =>
    value === undefined ? {} : { "pref.message_lang": value };
  assert.equal(messageLanguage(zahra, session()), "fa", "Dari by default, whatever the locale");
  assert.equal(messageLanguage(zahra, session("fa")), "fa");
  assert.equal(messageLanguage(ahmad, session("en")), "en");
  assert.equal(messageLanguage(zahra, session("auto")), "en");
  assert.equal(messageLanguage(ahmad, session("auto")), "fa");
  // A person's choice wins over every session choice; "" follows the session.
  for (const value of [undefined, "fa", "en", "auto"]) {
    assert.equal(messageLanguage(speaking(zahra, "fa"), session(value)), "fa", String(value));
    assert.equal(messageLanguage(speaking(ahmad, "en"), session(value)), "en", String(value));
    assert.equal(
      messageLanguage(speaking(ahmad, ""), session(value)),
      messageLanguage(ahmad, session(value)),
    );
  }
  // A state that skipped withStateDefaults (no lang at all) follows the session.
  const raw = speaking(zahra, undefined as unknown as OutreachLang);
  assert.equal(messageLanguage(raw, session("en")), "en");
  assert.equal(messageLanguage(raw, session()), "fa");
  // buildMessage records the resolved language's template key.
  assert.equal(buildMessage(fixtures[1], {}).templateKey, "template.customer.fa");
  assert.equal(buildMessage(fixtures[1], session("en")).templateKey, "template.customer.en");
  assert.equal(buildMessage(speaking(fixtures[1], "en"), {}).templateKey, "template.customer.en");
  assert.equal(buildMessage(speaking(fixtures[1], "fa"), session("en")).language, "fa");
  // What "Use session choice (…)" names for one number.
  assert.equal(sessionChoiceLabel("fa", "en"), "Dari");
  assert.equal(sessionChoiceLabel("en", "fa"), "English");
  assert.equal(sessionChoiceLabel("auto", "prs-AF"), "Auto: Dari");
  assert.equal(sessionChoiceLabel("auto", ""), "Auto: English");
  // Only the three stored values are a per-number language.
  for (const value of ["", "en", "fa"]) assert.equal(isOutreachLang(value), true, value);
  for (const value of ["ps", "auto", "EN", undefined, null, 1])
    assert.equal(isOutreachLang(value), false, String(value));
});

test("waLink strips the plus and encodes newlines and Persian text", () => {
  const url = waLink("+93700000001", "سلام.\nhttps://kaata.af/download?s=wa-shop");
  assert.equal(url.startsWith("https://wa.me/93700000001?text="), true);
  assert.equal(url.includes("+"), false);
  assert.equal(url.includes("%0A"), true);
  assert.equal(url.includes("%D8%B3%D9%84%D8%A7%D9%85"), true);
  assert.equal(
    decodeURIComponent(url.split("?text=")[1]),
    "سلام.\nhttps://kaata.af/download?s=wa-shop",
  );
});

test("csv escapes quotes and newlines, keeps Persian, guards formula prefixes and starts with a BOM", () => {
  assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvCell("+93700000001"), "'+93700000001");
  assert.equal(csvCell("-300.00"), "'-300.00");
  assert.equal(csvCell("@handle"), "'@handle");
  assert.equal(csvCell("سلام"), "سلام");
  assert.equal(csvCell(true), "true");
  assert.equal(csvCell(null), "");
  const csv = outreachCsv([fixtures[1], queue[1]]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const [header, row, pendingRow] = csv.slice(1).split("\r\n");
  assert.equal(
    header.startsWith(
      "phone,kind,name,shop_name,locale,country,carrier,number_valid,number_type,region,status",
    ),
    true,
    header,
  );
  assert.equal(
    header.includes(",replied_at,opened_at,pending_since,skipped_at,open_count,note,"),
    true,
    header,
  );
  // The stored per-number language, "" when the number follows the session.
  assert.equal(header.includes(",note,lang,converted,"), true, header);
  assert.equal(row.includes(",0,,,false,true,"), true, `no note, no lang: ${row}`);
  // mention_count counts distinct books, so its column is headed `books`
  // (2026-09-30); the value is unchanged (two books list +93720000002).
  assert.equal(header.includes(",kaatas,books,first_added_at,"), true, header);
  assert.equal(header.includes("mention_count"), false, header);
  assert.equal(row.includes(`,,2,${iso(15)},`), true, `no kaatas, 2 books: ${row}`);
  const noted = { ...queue[0], outreach: { ...queue[0].outreach, note: "call" } };
  const langRow = outreachCsv([speaking(noted, "fa")])
    .slice(1)
    .split("\r\n")[1];
  assert.equal(langRow.includes(",0,call,fa,false,false,"), true, langRow);
  assert.equal(
    row.startsWith(
      "'+93720000002,customer,Wali Wholesale,,,Afghanistan,Roshan,true,mobile,AF,sent",
    ),
    true,
    row,
  );
  assert.equal(row.includes("Sabz Grocery (Ahmad Karimi) · Mandawi Rice (Zahra Noori)"), true);
  assert.equal(row.includes("owes 300.00 AFN / owed 450.00 AFN"), true);
  assert.equal(pendingRow.includes(`,${iso(0.5)},${iso(0.5)},,1,`), true, pendingRow);
  assert.equal(
    listingsSummary(fixtures[1].customer),
    "Sabz Grocery (Ahmad Karimi) · Mandawi Rice (Zahra Noori)",
  );
});

test("pills come only from server flags and fields, never from a client re-derivation", () => {
  const labels = (c: OutreachContact) => contactPills(c, NOW).map((p) => p.label);
  // Sent 3 days ago with no reply, but the server said follow_up_due=false.
  const stale = contact("+93700000020", {
    outreach: state({ status: "sent", contacted_at: iso(3), contact_count: 1 }),
    follow_up_due: false,
  });
  assert.deepEqual(labels(stale), ["Shopkeeper"]);
  // Installed after contact by the dates, but converted=false from the server.
  const later = contact("+93700000021", {
    shopkeeper: shopkeeper({ installed_at: iso(1) }),
    outreach: state({ status: "sent", contacted_at: iso(3), contact_count: 1 }),
    converted: false,
  });
  assert.deepEqual(labels(later), ["Shopkeeper"]);
  assert.deepEqual(labels(fixtures[1]), ["Customer", "Wholesaler", "Follow-up due"]);
  assert.deepEqual(labels(fixtures[2]), ["Both", "Already a user", "Converted"]);
  assert.deepEqual(labels(fixtures[4]), ["Shopkeeper", "Do not contact"]);
  assert.deepEqual(labels(queue[1]), ["Customer", "Awaiting outcome"]);
  assert.deepEqual(labels(queue[2]), ["Customer", "Skipped today"]);
  assert.deepEqual(labels(queue[3]), ["Customer"], "yesterday's skip shows nothing");
  assert.deepEqual(labels(queue[6]), ["Customer", "Not on WhatsApp"]);
  assert.deepEqual(labels(queue[7]), ["Customer", "Marked invalid"]);
  // The numbering plan's verdict carries its region/type as the caption.
  const invalid = contactPills(queue[4], NOW);
  assert.deepEqual(
    invalid.map((p) => p.label),
    ["Customer", "Invalid number"],
  );
  assert.equal(invalid[1].tone, "red");
  assert.equal(invalid[1].caption, "AF");
  const unknown = contactPills(
    { ...queue[4], number: { ...DEFAULT_OUTREACH_NUMBER, valid: false } },
    NOW,
  );
  assert.equal(unknown[1].caption, undefined);
});

test("applyMarkLocally mirrors the mark rules, clears follow-ups and recounts", () => {
  const base = result(fixtures);
  const at = new Date(NOW).toISOString();
  const sent = applyMarkLocally(
    base,
    { phones: ["+93700000001"], contacted: true, template_key: "template.shopkeeper.fa" },
    at,
  );
  const row = sent.contacts[0].outreach;
  assert.equal(row.status, "sent");
  assert.equal(row.contact_count, 1);
  assert.equal(row.contacted_at, at);
  assert.equal(row.first_contacted_at, at);
  assert.equal(row.version, 1, "every write bumps the version, as the server does");
  assert.deepEqual(row.touches[0], { kind: "sent", detail: "template.shopkeeper.fa", at });
  assert.equal(sent.counts.to_contact, base.counts.to_contact - 1);
  assert.equal(sent.counts.sent, base.counts.sent + 1);
  assert.equal(sent.counts.sent_today, 1);
  assert.equal(sent.counts.total, base.counts.total, "source-derived counts stay the server's");
  // Untouched rows keep their identity.
  assert.equal(sent.contacts[1], base.contacts[1]);
  // A second bulk send on a row that is already Sent is skipped, exactly as
  // the server skips it: no count, no touch, no version bump.
  const again = applyMarkLocally(sent, { phones: ["+93700000001"], contacted: true }, iso(-1));
  assert.equal(again.contacts[0], sent.contacts[0], "left exactly as it was");
  assert.equal(again.contacts[0].outreach.contact_count, 1);
  assert.equal(again.contacts[0].outreach.version, 1);
  assert.equal(again.counts.sent_today, 1, "nothing counted twice");
  // A skipped row takes none of the mark's other fields either; a sendable
  // row in the same call is counted and noted.
  const mixed = applyMarkLocally(
    base,
    { phones: ["+93720000002", "+93700000001"], contacted: true, note: "batch" },
    at,
  );
  assert.equal(mixed.contacts[1], base.contacts[1], "already sent: untouched, note included");
  assert.equal(mixed.contacts[0].outreach.contact_count, 1);
  assert.equal(mixed.contacts[0].outreach.note, "batch");
  assert.equal(mixed.counts.sent_today, 1);
  // Stopped rows are never counted by a bulk send.
  const stopped = applyMarkLocally(
    base,
    { phones: ["+61400000004", "+93760000005"], contacted: true },
    at,
  );
  assert.equal(stopped.contacts[3], base.contacts[3], "declined");
  assert.equal(stopped.contacts[4], base.contacts[4], "do not contact");
  assert.equal(stopped.counts.sent_today, 0);

  const replied = applyMarkLocally(base, { phones: ["+93720000002"], replied: true }, at);
  assert.equal(replied.contacts[1].outreach.status, "replied");
  assert.equal(replied.contacts[1].outreach.replied_at, at);
  assert.equal(replied.contacts[1].follow_up_due, false, "a reply cancels the follow-up");
  assert.equal(replied.counts.follow_ups_due, 0);
  assert.equal(replied.counts.replied_today, 1);

  const explicit = applyMarkLocally(
    base,
    { phones: ["+93720000002", "+93730000003"], status: "declined" },
    at,
  );
  assert.equal(explicit.contacts[1].outreach.status, "declined");
  assert.equal(explicit.contacts[2].outreach.status, "declined");
  assert.equal(explicit.contacts[1].follow_up_due, false);
  assert.equal(explicit.counts.declined, base.counts.declined + 2);
  assert.deepEqual(explicit.contacts[1].outreach.touches[0], {
    kind: "status",
    detail: "declined",
    at,
  });

  const noted = applyMarkLocally(base, { phones: ["+93700000001"], note: "x".repeat(2500) }, at);
  assert.equal(Array.from(noted.contacts[0].outreach.note).length, 2000);
  assert.equal(noted.contacts[0].outreach.touches[0].kind, "note");
  assert.equal(noted.contacts[0].outreach.touches[0].detail.length, 200);
  assert.equal(noted.contacts[0].outreach.status, "new", "a note alone changes no status");

  // A status together with contacted is refused whole by the server (400,
  // 2026-09-30), so the mirror changes nothing; it used to let the status win.
  const both = applyMarkLocally(
    base,
    { phones: ["+93700000001"], contacted: true, status: "interested" },
    at,
  );
  assert.equal(both, base);

  // Contacted ends a pending or skipped state, as the server does; the new
  // unreachable statuses count apart from declined.
  const queued = result(all);
  const pendingSent = applyMarkLocally(queued, { phones: ["+93700000102"], contacted: true }, at);
  const pendingRow = pendingSent.contacts.find((c) => c.phone === "+93700000102")!.outreach;
  assert.equal(pendingRow.pending_since, "");
  assert.equal(pendingRow.skipped_at, "");
  assert.equal(pendingRow.version, 3);
  assert.equal(pendingSent.counts.pending, queued.counts.pending - 1);
  const skippedSent = applyMarkLocally(queued, { phones: ["+93700000103"], contacted: true }, at);
  assert.equal(
    skippedSent.contacts.find((c) => c.phone === "+93700000103")!.outreach.skipped_at,
    "",
  );
  const unreachable = applyMarkLocally(
    queued,
    { phones: ["+93700000101"], status: "no_whatsapp" },
    at,
  );
  assert.equal(unreachable.counts.unreachable, queued.counts.unreachable + 1);
  assert.equal(unreachable.counts.declined, queued.counts.declined);
  assert.equal(unreachable.counts.to_contact, queued.counts.to_contact - 1);
  // A send reaches a number written off as unreachable: promoted to Sent.
  const find = (r: OutreachResult, phone: string) =>
    r.contacts.find((c) => c.phone === phone)!.outreach;
  const reached = applyMarkLocally(
    queued,
    { phones: ["+93700000107", "+93700000108"], contacted: true },
    at,
  );
  assert.equal(find(reached, "+93700000107").status, "sent", "not on WhatsApp → sent");
  assert.equal(find(reached, "+93700000107").contact_count, 1);
  assert.equal(find(reached, "+93700000107").version, 4);
  assert.equal(find(reached, "+93700000108").status, "sent", "invalid → sent");
  assert.equal(reached.counts.unreachable, queued.counts.unreachable - 2);
  // Any explicit status other than New ends the wait; New keeps it.
  const pendingPhone = "+93700000102";
  const stoppedPending = applyMarkLocally(
    queued,
    { phones: [pendingPhone], status: "do_not_contact" },
    at,
  );
  assert.equal(find(stoppedPending, pendingPhone).pending_since, "");
  assert.equal(find(stoppedPending, pendingPhone).skipped_at, "");
  assert.equal(stoppedPending.counts.pending, queued.counts.pending - 1);
  const resetPending = applyMarkLocally(queued, { phones: [pendingPhone], status: "new" }, at);
  assert.equal(find(resetPending, pendingPhone).pending_since, iso(0.5), "New keeps the wait");
  assert.equal(resetPending.counts.pending, queued.counts.pending);
  const resetSkipped = applyMarkLocally(queued, { phones: ["+93700000103"], status: "new" }, at);
  assert.equal(find(resetSkipped, "+93700000103").skipped_at, KABUL_MIDNIGHT);
  const repliedPending = applyMarkLocally(queued, { phones: [pendingPhone], replied: true }, at);
  assert.equal(find(repliedPending, pendingPhone).pending_since, "");
  assert.equal(find(repliedPending, pendingPhone).status, "replied");
  assert.equal(repliedPending.counts.pending, queued.counts.pending - 1);
  const notedPending = applyMarkLocally(queued, { phones: [pendingPhone], note: "later" }, at);
  assert.equal(find(notedPending, pendingPhone).pending_since, iso(0.5), "a note keeps the wait");
});

test("applyMarkLocally: Mark sent records first messages only, and stops lift one row at a time", () => {
  const at = new Date(NOW).toISOString();
  const find = (r: OutreachResult, phone: string) => r.contacts.find((c) => c.phone === phone)!;
  const queued = result([...all, ...resolved]);
  // A New row with a recorded send is skipped whole, like a Sent row; first
  // contacts in the same call are counted and stop being first contacts.
  const first = applyMarkLocally(
    queued,
    { phones: ["+93700000112", "+93700000101", "+93700000114"], contacted: true },
    at,
  );
  assert.equal(find(first, "+93700000112"), find(queued, "+93700000112"), "messaged: untouched");
  for (const phone of ["+93700000101", "+93700000114"]) {
    assert.equal(find(first, phone).outreach.contact_count, 1, phone);
    assert.equal(find(first, phone).outreach.status, "sent", phone);
    assert.equal(find(first, phone).outreach.never_messaged, false, phone);
  }
  assert.equal(first.counts.sent_today, 2);
  // An unreachable row with an earlier send is no first message either.
  const written = result([
    prospect(
      "+93700000117",
      {},
      { status: "no_whatsapp", contact_count: 1, contacted_at: iso(6), version: 4 },
    ),
  ]);
  const again = applyMarkLocally(written, { phones: ["+93700000117"], contacted: true }, at);
  assert.equal(again.contacts[0], written.contacts[0]);
  assert.equal(again.counts.sent_today, 0);

  // A status mark never lifts a stop by itself: Karim is Do not contact,
  // Sara Declined, Ahmad New; only Ahmad moves, whatever the status.
  const base = result(fixtures);
  for (const status of ["new", "interested", "installed"] as const) {
    const marked = applyMarkLocally(
      base,
      { phones: ["+93760000005", "+61400000004", "+93700000001"], status },
      at,
    );
    assert.equal(marked.contacts[4], base.contacts[4], `${status}: do not contact untouched`);
    assert.equal(marked.contacts[3], base.contacts[3], `${status}: declined untouched`);
    assert.equal(marked.contacts[0].outreach.status, status);
    assert.equal(marked.contacts[0].outreach.version, 1);
    assert.equal(marked.counts.declined, base.counts.declined);
  }
  // lift_stop lifts it — what a row's own status menu sends.
  const lifted = applyMarkLocally(
    base,
    { phones: ["+93760000005"], status: "new", lift_stop: true },
    at,
  );
  assert.equal(lifted.contacts[4].outreach.status, "new");
  assert.equal(lifted.contacts[4].outreach.version, 1);
  assert.deepEqual(lifted.contacts[4].outreach.touches[0], { kind: "status", detail: "new", at });
  assert.equal(lifted.counts.declined, base.counts.declined - 1);
  assert.equal(lifted.counts.to_contact, base.counts.to_contact + 1);
  // Setting or re-setting a stop always applies, without the flag.
  const stopped = applyMarkLocally(
    base,
    { phones: ["+61400000004", "+93760000005", "+93700000001"], status: "do_not_contact" },
    at,
  );
  assert.equal(stopped.contacts[3].outreach.status, "do_not_contact", "declined → do not contact");
  assert.equal(stopped.contacts[4].outreach.version, 1, "re-set: still a write");
  assert.equal(stopped.contacts[0].outreach.status, "do_not_contact");
  // A reply or a note on a stopped row applies and keeps the stop.
  const replied = applyMarkLocally(base, { phones: ["+93760000005"], replied: true }, at);
  assert.equal(replied.contacts[4].outreach.status, "do_not_contact");
  assert.equal(replied.contacts[4].outreach.replied_at, at);
  const noted = applyMarkLocally(base, { phones: ["+61400000004"], note: "asked us to stop" }, at);
  assert.equal(noted.contacts[3].outreach.status, "declined");
  assert.equal(noted.contacts[3].outreach.note, "asked us to stop");
  // A status together with contacted or replied is refused whole.
  assert.equal(
    applyMarkLocally(base, { phones: ["+93700000001"], contacted: true, status: "interested" }, at),
    base,
  );
  assert.equal(
    applyMarkLocally(base, { phones: ["+93720000002"], replied: true, status: "installed" }, at),
    base,
  );
  // A Not-on-WhatsApp or Invalid status resolves an opened chat as nothing
  // sent; any other status leaves the flag alone; a recorded send stays one.
  const flag = (body: Omit<OutreachMarkBody, "phones">, phone: string) =>
    find(applyMarkLocally(queued, { ...body, phones: [phone] }, at), phone).outreach.never_messaged;
  assert.equal(flag({ status: "invalid" }, "+93700000113"), true);
  assert.equal(flag({ status: "no_whatsapp" }, "+93700000113"), true);
  assert.equal(flag({ status: "interested" }, "+93700000113"), false);
  assert.equal(flag({ status: "invalid" }, "+93700000112"), false);
});

test("applyMarkResponse replaces the outreach block from the server and keeps the follow-up rule", () => {
  const base = result(fixtures);
  const at = new Date(NOW).toISOString();
  const body = { phones: ["+93720000002"], replied: true };
  const optimistic = applyMarkLocally(base, body, at);
  // The server answers with its own timestamps and touch order.
  const server = state({
    phone: "+93720000002",
    status: "replied",
    contacted_at: iso(3),
    first_contacted_at: iso(3),
    replied_at: "2026-09-29T08:00:01Z",
    contact_count: 1,
    updated_at: "2026-09-29T08:00:01Z",
    version: 4,
    touches: [
      { kind: "replied", detail: "", at: "2026-09-29T08:00:01Z" },
      { kind: "sent", detail: "template.customer.en", at: iso(3) },
    ],
  });
  const applied = applyMarkResponse(optimistic, [server], body);
  assert.deepEqual(applied.contacts[1].outreach, server, "the server block is taken as-is");
  assert.equal(applied.contacts[1].follow_up_due, false, "a reply cancels the follow-up");
  assert.equal(applied.contacts[0], optimistic.contacts[0], "untouched rows keep identity");
  assert.equal(applied.counts.replied, base.counts.replied + 1);
  assert.equal(applied.counts.sent, base.counts.sent - 1);
  assert.equal(applied.counts.follow_ups_due, 0);
  assert.equal(applied.counts.replied_today, 1, "today's tallies are not re-bumped");
  // A note alone leaves a still-sent row's follow-up flag as it was.
  const noted = applyMarkResponse(
    base,
    [state({ ...fixtures[1].outreach, note: "call back", updated_at: at })],
    { phones: ["+93720000002"], note: "call back" },
  );
  assert.equal(noted.contacts[1].follow_up_due, true);
  assert.equal(noted.contacts[1].outreach.note, "call back");
  // A send the server counted (not in `skipped`) clears it even though the
  // status is still sent.
  const resent = applyMarkResponse(
    base,
    [state({ ...fixtures[1].outreach, contacted_at: at, contact_count: 2 })],
    { phones: ["+93720000002"], contacted: true },
  );
  assert.equal(resent.contacts[1].follow_up_due, false);
  // A row the server skipped (already sent) keeps its state and follow-up
  // flag; `updated` still carries its current state.
  const skippedRow = applyMarkResponse(
    base,
    [fixtures[1].outreach, state({ ...fixtures[0].outreach, status: "sent", contact_count: 1 })],
    { phones: ["+93720000002", "+93700000001"], contacted: true },
    ["+93720000002"],
  );
  assert.equal(skippedRow.contacts[1].follow_up_due, true);
  assert.equal(skippedRow.contacts[1].outreach.contact_count, 1);
  assert.equal(skippedRow.contacts[0].outreach.status, "sent");
  // A pre-045 state is normalized on the way in: nothing reads undefined.
  const { pending_since: _p, open_count: _c, version: _v, ...legacy } = fixtures[1].outreach;
  const normalized = applyMarkResponse(base, [legacy as OutreachState], {
    phones: ["+93720000002"],
    note: "x",
  });
  assert.equal(normalized.contacts[1].outreach.pending_since, "");
  assert.equal(normalized.contacts[1].outreach.open_count, 0);
  assert.equal(normalized.contacts[1].outreach.version, 0);
  // Phones the response names but the cache lacks are ignored; the input is untouched.
  const stranger = applyMarkResponse(base, [state({ phone: "+93700000099", status: "sent" })], {
    phones: ["+93700000099"],
    contacted: true,
  });
  assert.deepEqual(ids(stranger.contacts), ids(base.contacts));
  assert.equal(base.contacts[1].outreach.note, "");
  assert.equal(base.contacts[1].follow_up_due, true);
});

test("applyStateLocally takes an outcome's state as-is, never optimistically, and recounts", () => {
  const base = result(all);
  const at = new Date(NOW).toISOString();
  const opened = state({
    phone: "+93700000101",
    opened_at: at,
    pending_since: at,
    open_count: 1,
    version: 1,
    updated_at: at,
    touches: [{ kind: "opened", detail: "template.customer.fa", at }],
  });
  const afterOpen = applyStateLocally(base, opened);
  const openedRow = afterOpen.contacts.find((c) => c.phone === "+93700000101")!;
  assert.deepEqual(openedRow.outreach, opened, "the server block is taken as-is");
  assert.equal(openedRow.outreach.status, "new", "opening never marks sent");
  assert.equal(afterOpen.contacts[0], base.contacts[0], "other rows keep identity");
  assert.equal(afterOpen.counts.pending, base.counts.pending + 1);
  assert.equal(afterOpen.counts.to_contact, base.counts.to_contact);
  assert.equal(afterOpen.counts.total, base.counts.total, "source-derived counts stay");
  assert.equal(isPending(openedRow), true);
  assert.equal(canOpen(openedRow, NOW), false, "a pending row is not offered again");
  // Sent: pending ends, status moves, counts follow.
  const sent = state({
    phone: "+93700000102",
    status: "sent",
    contacted_at: at,
    first_contacted_at: at,
    contact_count: 1,
    opened_at: iso(0.5),
    open_count: 1,
    version: 3,
    updated_at: at,
  });
  const afterSent = applyStateLocally(afterOpen, sent);
  assert.equal(afterSent.counts.pending, base.counts.pending);
  assert.equal(afterSent.counts.sent, base.counts.sent + 1);
  assert.equal(afterSent.counts.to_contact, base.counts.to_contact - 1);
  // Retry: an unreachable row returns to New.
  const retried = applyStateLocally(
    afterSent,
    state({ phone: "+93700000107", status: "new", version: 4, updated_at: at }),
  );
  assert.equal(retried.counts.unreachable, base.counts.unreachable - 1);
  assert.equal(retried.counts.to_contact, base.counts.to_contact);
  // Skip: status unchanged, skipped today, out of the queue.
  const skipped = applyStateLocally(
    retried,
    state({ phone: "+93700000104", skipped_at: at, version: 2, updated_at: at }),
  );
  const skippedRow = skipped.contacts.find((c) => c.phone === "+93700000104")!;
  assert.equal(skippedRow.outreach.status, "new");
  assert.equal(isSkippedToday(skippedRow, NOW), true);
  assert.equal(canOpen(skippedRow, NOW), false);
  // follow_up_due: kept while the row is still the same send; cleared by a
  // fresh send or by any status other than sent. Never set here.
  const dueBase = result(fixtures);
  const same = applyStateLocally(
    dueBase,
    state({ ...fixtures[1].outreach, note: "later", version: 1 }),
  );
  assert.equal(same.contacts[1].follow_up_due, true);
  const resent = applyStateLocally(
    dueBase,
    state({ ...fixtures[1].outreach, contacted_at: at, contact_count: 2, version: 1 }),
  );
  assert.equal(resent.contacts[1].follow_up_due, false);
  assert.equal(resent.counts.follow_ups_due, 0);
  const declined = applyStateLocally(
    dueBase,
    state({ ...fixtures[1].outreach, status: "declined", version: 1 }),
  );
  assert.equal(declined.contacts[1].follow_up_due, false);
  const never = applyStateLocally(
    dueBase,
    state({ ...fixtures[0].outreach, status: "sent", contacted_at: iso(9), version: 1 }),
  );
  assert.equal(never.contacts[0].follow_up_due, false, "nothing sets the flag client-side");
  // A phone the cache lacks changes nothing at all.
  assert.equal(applyStateLocally(base, state({ phone: "+93700000999", version: 1 })), base);
  // A state missing batch-2 fields is normalized before it enters the cache.
  const { pending_since: _p, skipped_at: _s, touches: _t, ...partial } = opened;
  const filled = applyStateLocally(base, partial as OutreachState);
  const filledRow = filled.contacts.find((c) => c.phone === "+93700000101")!;
  assert.equal(filledRow.outreach.pending_since, "");
  assert.equal(filledRow.outreach.skipped_at, "");
  assert.deepEqual(filledRow.outreach.touches, []);
  assert.equal(isPending(filledRow), false);
  assert.equal(base.contacts.find((c) => c.phone === "+93700000101")!.outreach.open_count, 0);
});

test("applyExclusionsLocally replaces the list and leaves the contacts to the refetch", () => {
  const base = result(fixtures);
  const exclusions: OutreachExclusion[] = [
    {
      kind: "vault",
      id: "vault-1",
      label: "Sabz Grocery · Ahmad Karimi",
      reason: "test data",
      created_at: iso(0),
    },
  ];
  const applied = applyExclusionsLocally(base, exclusions);
  assert.equal(applied.exclusions, exclusions);
  assert.equal(applied.contacts, base.contacts);
  assert.deepEqual(base.exclusions, []);
  assert.deepEqual(applyExclusionsLocally(applied, []).exclusions, []);
});

test("recountOutreach keeps declined apart from unreachable and counts pending rows", () => {
  const counts = recountOutreach(all, result(all).counts);
  assert.equal(counts.declined, 2);
  assert.equal(counts.unreachable, 2);
  assert.equal(counts.pending, 2);
  assert.equal(counts.to_contact, 12);
  assert.equal(counts.invalid, 1, "number-derived counts are the server's");
});

test("withOutreachDefaults tolerates the 2026-09-29 backend and passes a current payload through", () => {
  const { number: _number, ...legacyContact } = fixtures[0];
  const { install_ids: _ids, ...legacyShopkeeper } = fixtures[0].shopkeeper!;
  const {
    opened_at: _o,
    pending_since: _p,
    skipped_at: _s,
    open_count: _c,
    version: _v,
    never_messaged: _n,
    ...legacyState
  } = fixtures[0].outreach;
  const legacy = withOutreachDefaults({
    contacts: [{ ...legacyContact, shopkeeper: legacyShopkeeper, outreach: legacyState }],
    settings: { "slug.customer": "flyer" },
    counts: { total: 1, to_contact: 1 },
    generated_at: "2026-09-29T08:00:00Z",
  });
  assert.equal(legacy.contacts.length, 1);
  assert.deepEqual(legacy.contacts[0].number, DEFAULT_OUTREACH_NUMBER);
  assert.equal(legacy.contacts[0].number.valid, true, "nothing is hidden by accident");
  assert.deepEqual(legacy.contacts[0].shopkeeper?.install_ids, []);
  assert.equal(legacy.contacts[0].outreach.pending_since, "");
  assert.equal(legacy.contacts[0].outreach.skipped_at, "");
  assert.equal(legacy.contacts[0].outreach.opened_at, "");
  assert.equal(legacy.contacts[0].outreach.open_count, 0);
  assert.equal(legacy.contacts[0].outreach.version, 0);
  assert.equal(legacy.contacts[0].outreach.status, "new");
  assert.equal(legacy.contacts[0].outreach.never_messaged, true, "no send, no open: derived");
  assert.deepEqual(legacy.contacts[0].outreach.touches, []);
  assert.equal(legacy.contacts[0].outreach.lang, "", "no lang: follows the session");
  assert.deepEqual(legacy.exclusions, []);
  assert.deepEqual(legacy.books, [], "no books before batch 3");
  assert.equal(legacy.counts.total, 1);
  assert.equal(legacy.counts.pending, 0);
  assert.equal(legacy.counts.opened_today, 0);
  assert.deepEqual(legacy.settings, { "slug.customer": "flyer" });
  assert.equal(legacy.generated_at, "2026-09-29T08:00:00Z");
  // The defaulted state keeps a customer in the queue; the defaulted number
  // has no type, and Prospects is mobile numbers only (2026-09-30), so it
  // takes a real mobile verdict to be one.
  const legacyCustomer = { ...legacy.contacts[0], kind: "customer" as const, shopkeeper: null };
  assert.equal(isProspect(legacyCustomer, NOW), false, "no number type: not a mobile");
  assert.equal(isProspect({ ...legacyCustomer, number: number() }, NOW), true);
  // A current payload keeps every field, including a partial number block.
  const exclusions: OutreachExclusion[] = [
    {
      kind: "install",
      id: "install-9",
      label: "Test phone",
      reason: "test data",
      created_at: iso(1),
    },
  ];
  const current = withOutreachDefaults(
    result([speaking(queue[1], "en"), queue[4]], {}, exclusions, books),
  );
  assert.deepEqual(current.contacts[0].number, queue[1].number);
  assert.equal(current.contacts[0].outreach.version, 2);
  assert.equal(current.contacts[0].outreach.pending_since, queue[1].outreach.pending_since);
  assert.equal(current.contacts[0].outreach.lang, "en");
  assert.equal(current.contacts[1].number.valid, false, "a real false is kept");
  assert.equal(current.exclusions, exclusions);
  assert.equal(current.books, books);
  const partial = withOutreachDefaults({ contacts: [{ ...queue[0], number: { valid: false } }] });
  assert.deepEqual(partial.contacts[0].number, { ...DEFAULT_OUTREACH_NUMBER, valid: false });
  // Garbage never crashes a render.
  for (const raw of [
    null,
    undefined,
    "nope",
    42,
    { contacts: "nope", exclusions: {}, books: "nope" },
  ]) {
    const r = withOutreachDefaults(raw);
    assert.deepEqual(r.contacts, []);
    assert.deepEqual(r.exclusions, []);
    assert.deepEqual(r.books, []);
    assert.deepEqual(r.settings, {});
    assert.equal(r.counts.total, 0);
    assert.equal(r.generated_at, "");
  }
});

test("withStateDefaults fills a pre-045 state and never leaves a field undefined", () => {
  const pre045 = {
    phone: "+93700000001",
    status: "sent",
    contacted_at: iso(3),
    first_contacted_at: iso(3),
    replied_at: "",
    contact_count: 1,
    note: "called",
    updated_at: iso(3),
    touches: [{ kind: "sent", detail: "template.shopkeeper.fa", at: iso(3) }],
  };
  assert.deepEqual(withStateDefaults(pre045), {
    ...pre045,
    never_messaged: false,
    opened_at: "",
    pending_since: "",
    skipped_at: "",
    open_count: 0,
    version: 0,
    lang: "",
  });
  // lang (migration 046): only "", "en" and "fa" are kept; anything else is "".
  assert.equal(withStateDefaults({ lang: "fa" }).lang, "fa");
  assert.equal(withStateDefaults({ lang: "en" }).lang, "en");
  for (const junk of ["ps", "auto", "EN", 1, null])
    assert.equal(withStateDefaults({ lang: junk }).lang, "", String(junk));
  // Nothing at all, or the wrong types, read as a New row with no history.
  assert.deepEqual(withStateDefaults(undefined), state());
  assert.deepEqual(withStateDefaults({ touches: null, contact_count: "3", version: NaN }), state());
  // A complete state passes through unchanged, as a fresh object.
  assert.deepEqual(withStateDefaults(queue[1].outreach), queue[1].outreach);
  assert.notEqual(withStateDefaults(queue[1].outreach), queue[1].outreach);
  // isPending reads a missing pending_since as not pending.
  const missing = {
    ...queue[1],
    outreach: { ...queue[1].outreach, pending_since: undefined as unknown as string },
  };
  assert.equal(isPending(missing), false);
  assert.equal(isPending(queue[1]), true);
});

test("withStateDefaults derives never_messaged conservatively when an older backend omits it", () => {
  const derived = (raw: Record<string, unknown>) => withStateDefaults(raw).never_messaged;
  assert.equal(derived({}), true, "no row: never messaged");
  assert.equal(derived({ contact_count: 0, open_count: 0, pending_since: "" }), true);
  assert.equal(derived({ contact_count: 1 }), false, "a recorded send");
  assert.equal(derived({ open_count: 1 }), false, "opened once: a message may have gone out");
  assert.equal(
    derived({ open_count: 1, skipped_at: iso(1) }),
    false,
    "skipped later: without the touch log the page cannot tell, so it assumes messaged",
  );
  assert.equal(derived({ pending_since: iso(0.5) }), false, "awaiting an outcome");
  // The server's verdict wins in both directions, and only a boolean is one.
  assert.equal(derived({ never_messaged: true, open_count: 3, skipped_at: iso(1) }), true);
  assert.equal(derived({ never_messaged: false }), false);
  assert.equal(derived({ never_messaged: "true", open_count: 1 }), false);
  assert.equal(derived({ never_messaged: "false" }), true);
  // A derived false keeps the number out of the queue until the backend says otherwise.
  const skippedOnOldBackend = prospect("+93700000118", {
    outreach: withStateDefaults({
      phone: "+93700000118",
      open_count: 1,
      opened_at: iso(2),
      skipped_at: "2026-09-28T19:29:59Z",
    }),
  });
  assert.equal(canOpen(skippedOnOldBackend, NOW), false);
  assert.equal(isProspect(skippedOnOldBackend, NOW), false);
});

test("applySettingLocally stores a value and deletes on blank", () => {
  const base = result([], { "template.customer.en": "old" });
  const saved = applySettingLocally(base, "slug.customer", "flyer");
  assert.deepEqual(saved.settings, { "template.customer.en": "old", "slug.customer": "flyer" });
  assert.deepEqual(applySettingLocally(saved, "template.customer.en", "  ").settings, {
    "slug.customer": "flyer",
  });
  assert.deepEqual(base.settings, { "template.customer.en": "old" }, "input untouched");
});

test("preferences restore only enum and number fields, never search, phones, notes or selection", () => {
  const restored = parseOutreachPreferences({
    filters: {
      kind: "customer",
      status: "declined_any",
      country: "+93",
      carrier: "Roshan",
      platform: "ios",
      language: "fa-AF",
      source: "market-qr",
      lastSeen: "bogus",
      archived: "only",
      validity: "invalid",
      numberType: "fixed",
      pending: "yes",
      skipped: "only",
      contacted: "ever",
      contactedFrom: "2026-02-30",
      contactedTo: "2026-09-14",
      minMentions: 2,
      minTallies: -1,
      minReceivable: "500",
      search: "+93700000001",
      note: "private",
      phones: ["+93700000001"],
    },
    search: "private name",
    selected: { "+93700000001": true },
    sortKey: "receivable",
    sortDesc: false,
    pageSize: 100,
  });
  assert.equal(restored.filters.kind, "customer");
  assert.equal(restored.filters.status, "declined_any");
  assert.equal(restored.filters.country, "+93");
  assert.equal(restored.filters.carrier, "Roshan");
  assert.equal(restored.filters.platform, "ios");
  assert.equal(restored.filters.language, "fa-AF");
  assert.equal(restored.filters.lastSeen, "all");
  assert.equal(restored.filters.archived, "only");
  assert.equal(restored.filters.validity, "invalid");
  assert.equal(restored.filters.numberType, "fixed");
  assert.equal(restored.filters.pending, "yes");
  assert.equal(restored.filters.skipped, "only");
  assert.equal(restored.filters.contacted, "ever");
  assert.equal(restored.filters.contactedFrom, "");
  assert.equal(restored.filters.contactedTo, "2026-09-14");
  assert.equal(restored.filters.minMentions, 2);
  assert.equal(restored.filters.minTallies, 0);
  assert.equal(restored.filters.minReceivable, 500);
  assert.equal(restored.sortKey, "receivable");
  assert.equal(restored.sortDesc, false);
  assert.equal(restored.pageSize, 100);
  const json = JSON.stringify(restored);
  assert.equal(json.includes("+93700000001"), false);
  assert.equal(json.includes("private"), false);
  assert.equal(json.includes("selected"), false);
  assert.equal(
    parseOutreachPreferences({ filters: { country: "+93700000001" } }).filters.country,
    "",
  );
  assert.equal(parseOutreachPreferences({ filters: { source: "a b" } }).filters.source, "");
  const bogus = parseOutreachPreferences({
    filters: {
      status: "unreachable",
      validity: "maybe",
      numberType: "voip",
      pending: 1,
      skipped: "yes",
      contacted: "sometimes",
    },
  });
  assert.equal(bogus.filters.status, "unreachable");
  assert.equal(bogus.filters.validity, "all");
  assert.equal(bogus.filters.numberType, "all");
  assert.equal(bogus.filters.pending, "all");
  assert.equal(bogus.filters.skipped, "all");
  assert.equal(bogus.filters.contacted, "all");
  assert.equal(parseOutreachPreferences(null).pageSize, 25);
  assert.deepEqual(parseOutreachPreferences(null).filters, DEFAULT_OUTREACH_FILTERS);
});

// ---- batch 3 (2026-09-30): language, order, books ----

test("applyMarkLocally sets a per-number language: a write without a touch, skipped with its row", () => {
  const base = result(fixtures);
  const at = new Date(NOW).toISOString();
  const find = (r: OutreachResult, phone: string) => r.contacts.find((c) => c.phone === phone)!;
  const dari = applyMarkLocally(base, { phones: ["+93700000001"], lang: "fa" }, at);
  const row = find(dari, "+93700000001").outreach;
  assert.equal(row.lang, "fa");
  assert.equal(row.version, 1, "every write bumps the version");
  assert.equal(row.updated_at, at);
  assert.deepEqual(row.touches, [], "a preference, not an outreach event");
  assert.equal(row.status, "new");
  assert.equal(row.contact_count, 0);
  assert.equal(row.never_messaged, true);
  assert.equal(dari.counts.to_contact, base.counts.to_contact);
  assert.equal(dari.counts.sent_today, 0);
  assert.equal(find(dari, "+93720000002"), find(base, "+93720000002"), "other rows keep identity");
  // "" clears it; still a write.
  const cleared = applyMarkLocally(dari, { phones: ["+93700000001"], lang: "" }, at);
  assert.equal(find(cleared, "+93700000001").outreach.lang, "");
  assert.equal(find(cleared, "+93700000001").outreach.version, 2);
  // A stopped row takes a language and stays stopped: nothing is lifted.
  const stopped = applyMarkLocally(base, { phones: ["+93760000005"], lang: "en" }, at);
  assert.equal(find(stopped, "+93760000005").outreach.status, "do_not_contact");
  assert.equal(find(stopped, "+93760000005").outreach.lang, "en");
  assert.equal(find(stopped, "+93760000005").outreach.version, 1);
  assert.equal(stopped.counts.declined, base.counts.declined);
  // A contacted mark that skips a row skips its lang too; a counted row takes it.
  const mixed = applyMarkLocally(
    base,
    { phones: ["+93720000002", "+93700000001"], contacted: true, lang: "en" },
    at,
  );
  assert.equal(find(mixed, "+93720000002"), find(base, "+93720000002"), "already sent: untouched");
  assert.equal(find(mixed, "+93720000002").outreach.lang, "");
  assert.equal(find(mixed, "+93700000001").outreach.lang, "en");
  assert.equal(find(mixed, "+93700000001").outreach.contact_count, 1);
  // A language never ends a wait nor cancels a follow-up.
  const queued = result(all);
  const waiting = applyMarkLocally(queued, { phones: ["+93700000102"], lang: "fa" }, at);
  assert.equal(find(waiting, "+93700000102").outreach.pending_since, iso(0.5));
  assert.equal(waiting.counts.pending, queued.counts.pending);
  const due = applyMarkLocally(base, { phones: ["+93720000002"], lang: "fa" }, at);
  assert.equal(find(due, "+93720000002").follow_up_due, true);
  assert.equal(find(due, "+93720000002").outreach.status, "sent");
  // The server's answer carries the lang; a backend before 046 answers without one.
  const body: OutreachMarkBody = { phones: ["+93700000001"], lang: "fa" };
  const answered = applyMarkResponse(
    base,
    [state({ ...fixtures[0].outreach, lang: "fa", version: 1, updated_at: at })],
    body,
  );
  assert.equal(answered.contacts[0].outreach.lang, "fa");
  const { lang: _lang, ...withoutLang } = answered.contacts[0].outreach;
  const older = applyMarkResponse(answered, [withoutLang as OutreachState], body);
  assert.equal(older.contacts[0].outreach.lang, "");
  // An outcome's state carries it too.
  const opened = applyStateLocally(
    base,
    state({ ...fixtures[0].outreach, lang: "en", opened_at: at, pending_since: at, version: 1 }),
  );
  assert.equal(opened.contacts[0].outreach.lang, "en");
});

test("last tally sorts newest first; ties go to the number more books list, then the phone; no tally last", () => {
  const tallied = (phone: string, lastTally: string, mentions: number) =>
    prospect(phone, {
      customer: customer({
        listings: Array.from({ length: mentions }, (_, index) =>
          listing({ vault_id: `vault-${index + 1}`, last_tally_at: lastTally }),
        ),
        last_tally_at: lastTally,
      }),
    });
  const rows = [
    tallied("+93700000301", iso(1), 1),
    tallied("+93700000302", iso(1), 3),
    tallied("+93700000300", iso(1), 3),
    tallied("+93700000303", iso(5), 1),
    tallied("+93700000304", "", 2),
    tallied("+93700000299", "", 1),
    // A shopkeeper with no tally and no customer side: no books at all.
    contact("+93700000298", { shopkeeper: shopkeeper({ last_tally_at: "" }) }),
  ];
  assert.deepEqual(ids(sortOutreach(rows, "last_tally", true)), [
    "+93700000300",
    "+93700000302",
    "+93700000301",
    "+93700000303",
    "+93700000304",
    "+93700000299",
    "+93700000298",
  ]);
  // Ascending flips the dates only: ties still put more books first, and no
  // tally stays last.
  assert.deepEqual(ids(sortOutreach(rows, "last_tally", false)), [
    "+93700000303",
    "+93700000300",
    "+93700000302",
    "+93700000301",
    "+93700000304",
    "+93700000299",
    "+93700000298",
  ]);
  // Every other key still breaks ties on the phone alone: the customers have
  // no last seen, so they follow by phone whatever their books.
  assert.deepEqual(ids(sortOutreach(rows, "last_seen", true)), [
    "+93700000298",
    "+93700000299",
    "+93700000300",
    "+93700000301",
    "+93700000302",
    "+93700000303",
    "+93700000304",
  ]);
  assert.equal(ids(rows)[0], "+93700000301", "sorting must not mutate the input");
});

test("a preset brings its own sort; a later sort holds, and the tab still matches on filters", () => {
  assert.deepEqual(DEFAULT_OUTREACH_SORT, { sortKey: "last_seen", sortDesc: true });
  const byTally = ["prospects", "customers", "wholesalers"];
  for (const { id } of OUTREACH_PRESETS)
    assert.deepEqual(
      presetSort(id),
      byTally.includes(id) ? { sortKey: "last_tally", sortDesc: true } : DEFAULT_OUTREACH_SORT,
      id,
    );
  // The default view (nothing stored) keeps last seen.
  const defaults = parseOutreachPreferences(null);
  assert.equal(defaults.sortKey, "last_seen");
  assert.equal(defaults.sortDesc, true);
  // Applying a preset sets its filters AND its sort, and keeps the page size.
  const start = { ...defaults, pageSize: 50 };
  const prospects = withPreset(start, "prospects");
  assert.deepEqual(prospects.filters, presetFilters("prospects"));
  assert.equal(prospects.sortKey, "last_tally");
  assert.equal(prospects.sortDesc, true);
  assert.equal(prospects.pageSize, 50);
  assert.equal(start.sortKey, "last_seen", "input untouched");
  // A sort picked afterwards keeps the tab: activePreset reads filters only.
  const resorted = { ...prospects, sortKey: "name" as const, sortDesc: false };
  assert.equal(activePreset(resorted.filters), "prospects");
  // The next preset brings its own sort back.
  const every = withPreset(resorted, "all");
  assert.equal(every.sortKey, "last_seen");
  assert.equal(every.sortDesc, true);
  assert.equal(withPreset(every, "wholesalers").sortKey, "last_tally");
  assert.equal(withPreset(every, "follow_ups").sortKey, "last_seen");
  // A stored sort is restored as-is.
  assert.equal(parseOutreachPreferences(resorted).sortKey, "name");
  assert.equal(parseOutreachPreferences(resorted).sortDesc, false);
});

test("books: owner label, search by name, owner, email and phone, and the five orders", () => {
  assert.equal(bookOwnerLabel(books[0]), "Ahmad Karimi");
  assert.equal(bookOwnerLabel(books[2]), "nazir@example.test", "no name: the email");
  assert.equal(
    bookOwnerLabel(book({ owner_name: "", owner_email: "", owner_phone: "+93700000009" })),
    "+93700000009",
  );
  assert.equal(
    bookOwnerLabel(
      book({ owner_name: "", owner_email: "", owner_phone: "", owner_account_id: "a" }),
    ),
    "a",
  );
  const s = (search: string) => vaultIds(books.filter((b) => matchesBookSearch(b, search)));
  assert.deepEqual(s(""), vaultIds(books));
  assert.deepEqual(s("   "), vaultIds(books));
  assert.deepEqual(s("sabz"), ["vault-1"]);
  assert.deepEqual(s("zahra"), ["vault-2"]);
  assert.deepEqual(s("NAZIR@example"), ["vault-7"]);
  assert.deepEqual(s("ahmad"), ["vault-1", "vault-9"]);
  assert.deepEqual(s("ahmad grocery"), ["vault-1"], "every word, across fields");
  assert.deepEqual(s("0790 000 007"), ["vault-2"], "national form");
  assert.deepEqual(s("+۹۳ ۷۹۰"), ["vault-2"], "Persian digits");
  assert.deepEqual(s("700000001"), ["vault-1", "vault-9"]);
  assert.deepEqual(s("nobody"), []);
  // The phone matching the directory uses, shared.
  assert.equal(phoneQueryMatches("+93700000001", "0700 000 001"), true);
  assert.equal(phoneQueryMatches("+93700000001", "0093 700 000 001"), true);
  assert.equal(phoneQueryMatches("+93700000001", "0093 700"), false, "as in the directory");
  assert.equal(phoneQueryMatches("+93700000001", "+۹۳ ۷۰۰"), true);
  assert.equal(phoneQueryMatches("+93700000001", "ahmad"), false);
  assert.equal(phoneQueryMatches("", "0700"), false, "no phone, no match");
  // Numbers is the server's order as received (the fixture list is in it);
  // the other four keep it for ties.
  assert.deepEqual(
    BOOK_SORT_OPTIONS.map(([key]) => key),
    ["numbers", "last_activity", "created", "owner", "name"],
  );
  const order = (key: Parameters<typeof sortBooks>[1]) => vaultIds(sortBooks(books, key));
  assert.deepEqual(order("numbers"), ["vault-1", "vault-2", "vault-7", "vault-9"]);
  assert.deepEqual(order("last_activity"), ["vault-2", "vault-1", "vault-7", "vault-9"]);
  assert.deepEqual(order("created"), ["vault-9", "vault-7", "vault-1", "vault-2"]);
  assert.deepEqual(order("owner"), ["vault-1", "vault-9", "vault-7", "vault-2"]);
  assert.deepEqual(order("name"), ["vault-2", "vault-7", "vault-1", "vault-9"]);
  // A missing name or date sorts last.
  const gaps = [
    book({ vault_id: "a", name: "", created_at: "" }),
    book({ vault_id: "b", name: "Zed", created_at: iso(100) }),
  ];
  assert.deepEqual(vaultIds(sortBooks(gaps, "name")), ["b", "a"]);
  assert.deepEqual(vaultIds(sortBooks(gaps, "created")), ["b", "a"]);
  assert.deepEqual(
    vaultIds(books),
    ["vault-1", "vault-2", "vault-7", "vault-9"],
    "input untouched",
  );
});

test("books count each number once across the books shown, as the directory does", () => {
  const byId = (...wanted: string[]) => books.filter((b) => wanted.includes(b.vault_id));
  // vault-1 lists 002, 003, 004 (archived) and 006: its own `numbers`.
  assert.equal(numbersInBooks(fixtures, byId("vault-1")), books[0].numbers);
  assert.equal(numbersInBooks(fixtures, byId("vault-2")), 1);
  // 002 is in both books: counted once, where the per-book sum says 5.
  assert.equal(numbersInBooks(fixtures, byId("vault-1", "vault-2")), 4);
  assert.equal(numbersInBooks(fixtures, byId("vault-2", "vault-7")), 2);
  assert.equal(numbersInBooks(fixtures, books), 5);
  assert.equal(numbersInBooks(fixtures, []), 0);
  assert.equal(numbersInBooks([], books), 0);
});

test("applyExclusionsLocally drops excluded books at once, an owner's with it; Undo waits for the refetch", () => {
  const withBooks = result(fixtures, {}, [], books);
  const excluded = (kind: OutreachExclusion["kind"], id: string): OutreachExclusion => ({
    kind,
    id,
    label: id,
    reason: "test data",
    created_at: iso(0),
  });
  const oneBook = applyExclusionsLocally(withBooks, [excluded("vault", "vault-2")]);
  assert.deepEqual(vaultIds(oneBook.books), ["vault-1", "vault-7", "vault-9"]);
  assert.equal(oneBook.contacts, withBooks.contacts, "contacts wait for the refetch");
  // An account takes every book it owns (vault-1 and vault-9 are Ahmad's).
  const owner = applyExclusionsLocally(withBooks, [excluded("account", "acct-1")]);
  assert.deepEqual(vaultIds(owner.books), ["vault-2", "vault-7"]);
  // An install owns no book.
  const install = applyExclusionsLocally(withBooks, [excluded("install", "install-1")]);
  assert.deepEqual(vaultIds(install.books), vaultIds(books));
  // Undo shortens the list; the book comes back with the refetch, not here.
  const undone = applyExclusionsLocally(oneBook, []);
  assert.deepEqual(undone.exclusions, []);
  assert.deepEqual(vaultIds(undone.books), ["vault-1", "vault-7", "vault-9"]);
  assert.deepEqual(vaultIds(withBooks.books), vaultIds(books), "input untouched");
});

// ---- review fixes (2026-09-30) ----

test("an open chat keeps the language it was opened in: the newest opened touch names its template", () => {
  const at = iso(0.5);
  const opened = (detail: string, daysAgo = 0.5) => ({
    kind: "opened" as const,
    detail,
    at: iso(daysAgo),
  });
  const pendingWith = (touches: OutreachState["touches"]) =>
    prospect(
      "+93700000401",
      {},
      { opened_at: at, pending_since: at, open_count: 2, version: 3, touches },
    );
  // Opened while the session was Dari. The session says English now, and the
  // number's own language may change as well: Sent still records Dari.
  const dari = pendingWith([opened("template.customer.fa")]);
  assert.equal(isPending(dari), true);
  assert.equal(openedTemplateKey(dari), "template.customer.fa");
  assert.equal(
    buildMessage(dari, { "pref.message_lang": "en" }).templateKey,
    "template.customer.en",
    "the current resolution has moved on",
  );
  assert.equal(openedTemplateKey(speaking(dari, "en")), "template.customer.fa");
  // Not pending: no chat is open, so nothing is kept, whatever the log holds.
  const closed = { ...dari, outreach: { ...dari.outreach, pending_since: "" } };
  assert.equal(openedTemplateKey(closed), undefined);
  assert.equal(openedTemplateKey(fixtures[1]), undefined, "sent, nothing open");
  // A detail that is not a template key reads as undefined.
  for (const detail of [
    "",
    "nothing sent",
    "template.customer.ps",
    "template.supplier.fa",
    "Template.customer.fa",
    "template.customer.fa ",
    "xtemplate.customer.fa",
    "template.customer",
  ])
    assert.equal(openedTemplateKey(pendingWith([opened(detail)])), undefined, detail);
  // The newest opened touch wins (touches arrive newest first); touches of
  // other kinds in front of it are passed over.
  const reopened = pendingWith([
    { kind: "note", detail: "call back", at: iso(0.1) },
    opened("template.shopkeeper.en", 0.2),
    opened("template.customer.fa"),
  ]);
  assert.equal(openedTemplateKey(reopened), "template.shopkeeper.en");
  // Only the newest open names the chat: junk there never falls back to an
  // older open's key.
  assert.equal(
    openedTemplateKey(pendingWith([opened("", 0.2), opened("template.customer.fa")])),
    undefined,
  );
  // Pending, but no opened touch among the 20 kept.
  assert.equal(openedTemplateKey(pendingWith([])), undefined);
  // templateLanguage reads exactly the keys openedTemplateKey accepts.
  assert.equal(templateLanguage("template.shopkeeper.en"), "en");
  assert.equal(templateLanguage("template.customer.fa"), "fa");
  for (const key of ["", "fa", "template.customer.ps", "template.customer.fa.x"])
    assert.equal(templateLanguage(key), undefined, key);
});

test("a preset's description states its order only while that order is on screen", () => {
  assert.deepEqual(
    OUTREACH_PRESETS.filter((preset) => "order" in preset).map((preset) => preset.id),
    ["prospects", "customers", "wholesalers"],
  );
  const byName = { sortKey: "name", sortDesc: false } as const;
  const prospects = presetDescription("prospects", presetSort("prospects"));
  assert.equal(prospects.endsWith("(change the country filter). Newest tally first."), true);
  // Re-sorted: the sentence goes, the rest stays.
  assert.equal(
    presetDescription("prospects", byName),
    prospects.replace(" Newest tally first.", ""),
  );
  assert.equal(
    presetDescription("customers", { sortKey: "last_tally", sortDesc: false }),
    "Numbers that appear only inside synced books, never as an install.",
    "ascending is another order",
  );
  assert.equal(
    presetDescription("wholesalers", DEFAULT_OUTREACH_SORT).includes("Newest tally first."),
    false,
  );
  // A preset without an order sentence reads the same under any sort.
  for (const id of ["all", "follow_ups", "unreachable"] as const)
    assert.equal(presetDescription(id, byName), presetDescription(id, presetSort(id)), id);
  assert.equal(
    presetDescription("all", byName),
    "Every number the server knows, except customers archived in every book.",
  );
});

test("books keep the server's order: Numbers as received, and every other sort breaks ties by its index", () => {
  const order = (rows: OutreachBook[], key: Parameters<typeof sortBooks>[1]) =>
    vaultIds(sortBooks(rows, key));
  // Go compares names byte-wise, so at equal numbers and last tally "Zebra"
  // comes before "apple"; localeCompare would swap them.
  const server = [
    book({ vault_id: "vault-z", name: "Zebra", numbers: 2, last_tally_at: iso(1) }),
    book({ vault_id: "vault-a", name: "apple", numbers: 2, last_tally_at: iso(1) }),
  ];
  assert.deepEqual(order(server, "numbers"), ["vault-z", "vault-a"]);
  assert.deepEqual(order(server, "last_activity"), ["vault-z", "vault-a"], "same last tally");
  assert.deepEqual(order(server, "created"), ["vault-z", "vault-a"], "same creation");
  assert.deepEqual(order(server, "owner"), ["vault-z", "vault-a"], "same owner");
  // Name is the operator's A to Z, which is not the server's byte order.
  assert.deepEqual(order(server, "name"), ["vault-a", "vault-z"]);
  // Numbers never re-sorts: the order that arrives is the order shown, copied.
  const unsorted = [book({ vault_id: "few", numbers: 1 }), book({ vault_id: "many", numbers: 9 })];
  assert.deepEqual(order(unsorted, "numbers"), ["few", "many"]);
  assert.notEqual(sortBooks(unsorted, "numbers"), unsorted);
  // A tie between rows that are not neighbours keeps the server's index, not
  // the names.
  const owners = [
    book({ vault_id: "b1", name: "Zebra", owner_name: "Bashir" }),
    book({ vault_id: "b2", name: "Mid", owner_name: "Amina" }),
    book({ vault_id: "b3", name: "apple", owner_name: "Bashir" }),
  ];
  assert.deepEqual(order(owners, "owner"), ["b2", "b1", "b3"]);
  assert.deepEqual(vaultIds(owners), ["b1", "b2", "b3"], "input untouched");
});
