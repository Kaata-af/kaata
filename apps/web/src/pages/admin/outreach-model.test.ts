import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  OutreachContact,
  OutreachCustomer,
  OutreachListing,
  OutreachResult,
  OutreachShopkeeper,
  OutreachState,
} from "./api";
import {
  CONVERTED_FILTERS,
  DEFAULT_OUTREACH_FILTERS,
  DEFAULT_TEMPLATES,
  OUTREACH_PRESETS,
  activePreset,
  afghanCarrier,
  applyMarkLocally,
  applyMarkResponse,
  applySettingLocally,
  balanceSummary,
  buildMessage,
  contactPills,
  csvCell,
  dialCode,
  fillTemplate,
  filterOutreach,
  formatMoney,
  internationalDigits,
  listingsSummary,
  messageLanguage,
  nextToContact,
  normalizeDigits,
  outreachCsv,
  parseMoney,
  parseOutreachPreferences,
  presetCounts,
  presetFilters,
  sortOutreach,
  waLink,
} from "./outreach-model.ts";

// 2026-09-29 12:30 in Kabul.
const NOW = Date.parse("2026-09-29T08:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function state(overrides: Partial<OutreachState> = {}): OutreachState {
  return {
    phone: "",
    status: "new",
    contacted_at: "",
    first_contacted_at: "",
    replied_at: "",
    contact_count: 0,
    note: "",
    updated_at: "",
    touches: [],
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
function customer(overrides: Partial<OutreachCustomer> = {}): OutreachCustomer {
  const listings = overrides.listings ?? [listing()];
  return {
    listings,
    mention_count: listings.length,
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
  };
  return { contacts, settings, counts, generated_at: new Date(NOW).toISOString() };
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
  assert.deepEqual(
    ids(filterOutreach(fixtures, { ...presetFilters("declined"), archived: "hide" }, "", NOW)),
    ["+93760000005"],
  );
  for (const preset of ["all", "shopkeepers", "customers", "wholesalers", "to_contact"] as const)
    assert.equal(presetFilters(preset).archived, "hide", preset);
  for (const preset of [
    "sent",
    "replied",
    "interested",
    "installed",
    "declined",
    "follow_ups",
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
  assert.equal(activePreset({ ...presetFilters("follow_ups"), country: "+93" }), undefined);
  assert.equal(activePreset({ ...presetFilters("sent"), archived: "hide" }), undefined);
});

test("presetCounts equals the length of the list each card or tab opens", () => {
  const counts = presetCounts(fixtures, NOW);
  for (const preset of OUTREACH_PRESETS)
    assert.equal(
      counts[preset.id],
      filterOutreach(fixtures, presetFilters(preset.id), "", NOW).length,
      preset.id,
    );
  assert.equal(counts.all, 7);
  assert.equal(counts.to_contact, 2);
  assert.equal(counts.declined, 2);
  assert.equal(counts.converted, filterOutreach(fixtures, CONVERTED_FILTERS, "", NOW).length);
  assert.equal(counts.converted, 1);
  // The server's total counts the archived customer the "all" view hides.
  assert.equal(result(fixtures).counts.total, 8);
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

test("message language follows the locale unless overridden; templates and slugs come from settings", () => {
  assert.equal(messageLanguage("fa"), "fa");
  assert.equal(messageLanguage("prs-AF"), "fa");
  assert.equal(messageLanguage("fa-AF"), "fa");
  assert.equal(messageLanguage("en"), "en");
  assert.equal(messageLanguage(""), "en");
  assert.equal(messageLanguage("fa", "en"), "en");
  const shop = buildMessage(fixtures[0], {});
  assert.equal(shop.templateKey, "template.shopkeeper.fa");
  assert.equal(shop.link, "https://kaata.af/download?s=wa-shop");
  assert.equal(shop.text.split("\n")[1], shop.link);
  const cust = buildMessage(fixtures[1], {
    "slug.customer": "Flyer Two!",
    "template.customer.en": "Hello {name}",
  });
  assert.equal(cust.templateKey, "template.customer.en");
  assert.equal(cust.link, "https://kaata.af/download?s=flyer-two");
  assert.equal(cust.text, `Hello Wali Wholesale\n${cust.link}`);
  const both = buildMessage(fixtures[2], { "template.shopkeeper.en": "   " }, "fa");
  assert.equal(both.templateKey, "template.shopkeeper.fa");
  assert.equal(both.audience, "shopkeeper");
  assert.equal(buildMessage(fixtures[2], {}).text.startsWith("Salaam Zahra Noori."), true);
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

test("nextToContact skips non-new, do-not-contact and converted rows in view order", () => {
  const rows = [
    contact("+93700000010", { outreach: state({ status: "sent" }) }),
    contact("+93700000011", { outreach: state({ status: "do_not_contact" }) }),
    contact("+93700000012", { converted: true }),
    contact("+93700000013"),
    contact("+93700000014"),
  ];
  assert.equal(nextToContact(rows)?.phone, "+93700000013");
  assert.equal(nextToContact(rows.slice(0, 3)), undefined);
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
  const csv = outreachCsv([fixtures[1]]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const [header, row] = csv.slice(1).split("\r\n");
  assert.equal(header.startsWith("phone,kind,name,shop_name,locale,country,carrier,status"), true);
  assert.equal(
    row.startsWith("'+93720000002,customer,Wali Wholesale,,,Afghanistan,Roshan,sent"),
    true,
  );
  assert.equal(row.includes("Sabz Grocery (Ahmad Karimi) · Mandawi Rice (Zahra Noori)"), true);
  assert.equal(row.includes("owes 300.00 AFN / owed 450.00 AFN"), true);
  assert.equal(
    listingsSummary(fixtures[1].customer),
    "Sabz Grocery (Ahmad Karimi) · Mandawi Rice (Zahra Noori)",
  );
});

test("pills come only from server flags, never from a client re-derivation", () => {
  const labels = (c: OutreachContact) => contactPills(c).map((p) => p.label);
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
  assert.deepEqual(row.touches[0], { kind: "sent", detail: "template.shopkeeper.fa", at });
  assert.equal(sent.counts.to_contact, base.counts.to_contact - 1);
  assert.equal(sent.counts.sent, base.counts.sent + 1);
  assert.equal(sent.counts.sent_today, 1);
  assert.equal(sent.counts.total, base.counts.total, "source-derived counts stay the server's");
  // Untouched rows keep their identity.
  assert.equal(sent.contacts[1], base.contacts[1]);
  const again = applyMarkLocally(sent, { phones: ["+93700000001"], contacted: true }, iso(-1));
  assert.equal(again.contacts[0].outreach.contact_count, 2);
  assert.equal(again.contacts[0].outreach.first_contacted_at, at, "first send never moves");
  assert.equal(again.contacts[0].outreach.contacted_at, iso(-1));

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

  // A status of sent with contacted also present: explicit status wins, count bumps.
  const both = applyMarkLocally(
    base,
    { phones: ["+93700000001"], contacted: true, status: "interested" },
    at,
  );
  assert.equal(both.contacts[0].outreach.status, "interested");
  assert.equal(both.contacts[0].outreach.contact_count, 1);
  assert.equal(both.contacts[0].outreach.touches.map((t) => t.kind).join(","), "status,sent");
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
    touches: [
      { kind: "replied", detail: "", at: "2026-09-29T08:00:01Z" },
      { kind: "sent", detail: "template.customer.en", at: iso(3) },
    ],
  });
  const applied = applyMarkResponse(optimistic, [server], body);
  assert.equal(applied.contacts[1].outreach, server, "the server block is taken as-is");
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
  // A fresh send clears it even though the status is still sent.
  const resent = applyMarkResponse(
    base,
    [state({ ...fixtures[1].outreach, contacted_at: at, contact_count: 2 })],
    { phones: ["+93720000002"], contacted: true },
  );
  assert.equal(resent.contacts[1].follow_up_due, false);
  // Phones the response names but the cache lacks are ignored; the input is untouched.
  const stranger = applyMarkResponse(base, [state({ phone: "+93700000099", status: "sent" })], {
    phones: ["+93700000099"],
    contacted: true,
  });
  assert.deepEqual(ids(stranger.contacts), ids(base.contacts));
  assert.equal(base.contacts[1].outreach.note, "");
  assert.equal(base.contacts[1].follow_up_due, true);
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
  assert.equal(parseOutreachPreferences(null).pageSize, 25);
});
