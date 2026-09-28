// Run with: npm run selftest:tab-join
// Synthetic fixtures only: never opens kaata.db, a device, or a user backup.
//
// Pins the shared-account join screen's pure decisions (lib/tabs/join-plan.ts)
// and the contact-list merge both pickers share (lib/contacts-merge.ts):
//   - planCurrency's decision table: a matching kaata / one empty switchable
//     kaata → primary 'switch' / tallies or a closed tab → relabel + 'create' /
//     locked by an open tab / locked by role / several switchable.
//   - suggestJoinContact's ranking (kaata contact > phone book > invitation),
//     phone-format tolerance ("0700123456" ≡ "+93700123456" ≡
//     "0093 700 123 456"), a linked contact blocking, no phone → label only,
//     nothing → null, and country inference from the dial code.
//   - mergeContactSections parity with app/person/new.tsx: the memo pair that
//     screen ran BEFORE the helper existed is copied below verbatim as the
//     oracle, and both are driven through the same inputs.
//   - splitSearchQuery, the join screen's ONE search box: a number lands on
//     person/new's phone axis and a name on its first-name axis, never both
//     (the merge ANDs them, and a number fed to both matched nobody).
// The real lib/contacts-sync, lib/search, lib/digits and lib/phone are loaded;
// only their native / SQLite edges (expo-contacts, lib/db) are stubbed.
import assert from "node:assert/strict";

// App code guards dev logging with the bundler-provided __DEV__; Node has none.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

function stub(name: string, exports: unknown): void {
  const filename = require.resolve(name);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: { __esModule: true, ...(exports as object) },
  } as NodeJS.Module;
}
// lib/contacts-sync imports the native contacts module at load; lib/phone
// imports lib/db (SQLite) for the default-country pref. Neither edge is
// reached by the helpers under test.
stub("expo-contacts/legacy", {});
stub("../db", { getAppMeta: async () => null, setAppMeta: async () => undefined });

const { phoneKey } = require("../contacts-sync") as typeof import("../contacts-sync");
const { toAsciiDigits } = require("../digits") as typeof import("../digits");
const { PHONE_SEARCH_MIN_DIGITS, searchContacts } =
  require("../search") as typeof import("../search");
const { planCurrency, suggestJoinContact } =
  require("../tabs/join-plan") as typeof import("../tabs/join-plan");
const { DEVICE_LIST_CAP, mergeContactSections, splitSearchQuery } =
  require("../contacts-merge") as typeof import("../contacts-merge");
type VaultFacts = import("../tabs/join-plan").VaultFacts;

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// 1. planCurrency

function vault(over: Partial<VaultFacts> & { id: string }): VaultFacts {
  return {
    name: over.id,
    currency: "AFN",
    liveEntries: 0,
    hasAnyTab: false,
    hasOpenTab: false,
    canChangeCurrency: true,
    ...over,
  };
}

console.log("1. planCurrency");

check("a kaata already in the tab's currency matches; the default stays create", () => {
  const plan = planCurrency([vault({ id: "usd", currency: "USD" }), vault({ id: "afn" })], "USD");
  assert.deepEqual(
    plan.matching.map((v) => v.id),
    ["usd"],
  );
  assert.deepEqual(
    plan.switchable.map((s) => s.vault.id),
    ["afn"],
  );
  assert.deepEqual(plan.locked, []);
  assert.equal(plan.primary, "create");
});

check("one empty kaata and nothing else → primary switch, nothing to relabel", () => {
  const plan = planCurrency([vault({ id: "afn" })], "USD");
  assert.deepEqual(plan.matching, []);
  assert.equal(plan.switchable.length, 1);
  assert.equal(plan.switchable[0].vault.id, "afn");
  assert.equal(plan.switchable[0].relabels, false);
  assert.deepEqual(plan.locked, []);
  assert.equal(plan.primary, "switch");
});

check("live tallies → the switch relabels and create is primary", () => {
  const plan = planCurrency([vault({ id: "afn", liveEntries: 3 })], "USD");
  assert.equal(plan.switchable[0].relabels, true);
  assert.equal(plan.primary, "create");
});

check("a closed tab with zero live tallies still relabels", () => {
  const plan = planCurrency([vault({ id: "afn", hasAnyTab: true })], "USD");
  assert.equal(plan.switchable[0].relabels, true);
  assert.equal(plan.primary, "create");
});

check("an open tab locks with reason open_tab, ahead of the role", () => {
  const plan = planCurrency(
    [vault({ id: "afn", hasAnyTab: true, hasOpenTab: true, canChangeCurrency: false })],
    "USD",
  );
  assert.deepEqual(plan.switchable, []);
  assert.equal(plan.locked.length, 1);
  assert.equal(plan.locked[0].vault.id, "afn");
  assert.equal(plan.locked[0].reason, "open_tab");
  assert.equal(plan.primary, "create");
});

check("a role that cannot change settings locks with reason role", () => {
  const plan = planCurrency([vault({ id: "afn", canChangeCurrency: false })], "USD");
  assert.deepEqual(plan.switchable, []);
  assert.equal(plan.locked[0].reason, "role");
  assert.equal(plan.primary, "create");
});

check("several empty switchable kaatas → create (no one-tap guess)", () => {
  const plan = planCurrency([vault({ id: "a" }), vault({ id: "b" })], "USD");
  assert.equal(plan.switchable.length, 2);
  assert.equal(plan.primary, "create");
});

check("one empty switchable kaata plus a locked one → create", () => {
  const plan = planCurrency([vault({ id: "a" }), vault({ id: "b", hasOpenTab: true })], "USD");
  assert.equal(plan.switchable.length, 1);
  assert.equal(plan.locked.length, 1);
  assert.equal(plan.primary, "create");
});

check("a matching kaata beside an empty switchable one → create", () => {
  const plan = planCurrency([vault({ id: "usd", currency: "USD" }), vault({ id: "a" })], "USD");
  assert.equal(plan.matching.length, 1);
  assert.equal(plan.switchable.length, 1);
  assert.equal(plan.primary, "create");
});

check("no kaatas → every bucket empty, create", () => {
  assert.deepEqual(planCurrency([], "USD"), {
    matching: [],
    switchable: [],
    locked: [],
    primary: "create",
  });
});

check("input order is preserved within each bucket", () => {
  const plan = planCurrency(
    [
      vault({ id: "s2", liveEntries: 1 }),
      vault({ id: "l1", hasOpenTab: true }),
      vault({ id: "s1" }),
      vault({ id: "m1", currency: "USD" }),
      vault({ id: "l2", canChangeCurrency: false }),
    ],
    "USD",
  );
  assert.deepEqual(
    plan.switchable.map((s) => s.vault.id),
    ["s2", "s1"],
  );
  assert.deepEqual(
    plan.locked.map((l) => l.vault.id),
    ["l1", "l2"],
  );
  assert.deepEqual(
    plan.matching.map((v) => v.id),
    ["m1"],
  );
});

// ---------------------------------------------------------------------------
// 2. suggestJoinContact

type Candidate = { id: string; name: string; phone: string | null; linked: number };
type Device = {
  id: string;
  firstName: string;
  lastName: string | null;
  name: string;
  phone: string | null;
};

function cand(id: string, name: string, phone: string | null, linked = 0): Candidate {
  return { id, name, phone, linked };
}
function dev(id: string, firstName: string, lastName: string | null, phone: string | null): Device {
  return { id, firstName, lastName, name: [firstName, lastName].filter(Boolean).join(" "), phone };
}

console.log("2. suggestJoinContact");

const FORMATS = ["0700123456", "+93700123456", "0093 700 123 456", "+93 70 012 3456"];

check("every format of one number shares a phoneKey", () => {
  const keys = new Set(FORMATS.map((f) => phoneKey(f)));
  assert.equal(keys.size, 1);
  assert.equal([...keys][0], "00123456");
});

check("a kaata contact with the invitation's number wins, whatever the formats", () => {
  for (const other of FORMATS) {
    for (const stored of FORMATS) {
      const s = suggestJoinContact({
        otherPhone: other,
        otherLabel: "Ahmad Khan",
        candidates: [cand("p9", "Someone Else", "+93799999999"), cand("p1", "Ahmad K.", stored)],
        deviceContacts: [dev("d1", "Ahmad", "Khan", stored)],
      });
      assert.deepEqual(s, { source: "kaata", personId: "p1", name: "Ahmad K.", phone: stored });
    }
  }
});

check("a LINKED kaata contact with that number blocks the suggestion", () => {
  const s = suggestJoinContact({
    otherPhone: "+93700123456",
    otherLabel: "Ahmad Khan",
    candidates: [cand("p1", "Ahmad K.", "0700123456", 1)],
    deviceContacts: [dev("d1", "Ahmad", "Khan", "0700123456")],
  });
  assert.equal(s, null);
});

check("a linked contact blocks even beside an unlinked one on the same number", () => {
  const s = suggestJoinContact({
    otherPhone: "+93700123456",
    otherLabel: "Ahmad Khan",
    candidates: [cand("p1", "Ahmad", "0700123456", 0), cand("p2", "Ahmad old", "0700123456", 1)],
    deviceContacts: [],
  });
  assert.equal(s, null);
});

check("no kaata contact → the phone-book NAME with the invitation's E.164 number", () => {
  // The book holds the number in national format; the invitation's E.164 is
  // authoritative for the same number, so the person is created with it and
  // its country rather than the book's "0700…" normalized against whatever
  // the install default is.
  const s = suggestJoinContact({
    otherPhone: "+93700123456",
    otherLabel: "Ahmad Khan",
    candidates: [cand("p9", "Someone Else", "+93799999999")],
    deviceContacts: [
      dev("d0", "Other", null, "0799999999"),
      dev("d1", "Ahmad", "Khan", "0700123456"),
    ],
  });
  assert.deepEqual(s, {
    source: "phone",
    firstName: "Ahmad",
    lastName: "Khan",
    name: "Ahmad Khan",
    phone: "+93700123456",
    countryCode: "AF",
  });
});

check("a cousin abroad stored nationally in the book takes the invitation's +61 number", () => {
  const s = suggestJoinContact({
    otherPhone: "+61412000004",
    otherLabel: "Cousin",
    candidates: [],
    deviceContacts: [dev("d1", "Safi", "Ullah", "0412 000 004")],
  });
  assert.deepEqual(s, {
    source: "phone",
    firstName: "Safi",
    lastName: "Ullah",
    name: "Safi Ullah",
    phone: "+61412000004",
    countryCode: "AU",
  });
});

check("both national format → the book's number stays, no country", () => {
  const s = suggestJoinContact({
    otherPhone: "0700123456",
    otherLabel: "Ahmad",
    candidates: [],
    deviceContacts: [dev("d1", "Ahmad", "Khan", "070 012 3456")],
  });
  assert.equal(s?.source, "phone");
  assert.equal(s && "phone" in s ? s.phone : null, "070 012 3456");
  assert.equal(s && "countryCode" in s ? s.countryCode : undefined, null);
});

check("two E.164 numbers sharing their last 8 digits are two people", () => {
  // +61412345678 (Australia) vs +93712345678 (Afghanistan): phoneKey agrees,
  // the numbers do not. Neither the kaata contact nor the phone-book entry
  // may be offered — on the preview stage a match is one tap from binding.
  const s = suggestJoinContact({
    otherPhone: "+93712345678",
    otherLabel: "Ahmad",
    candidates: [cand("p1", "Cousin AU", "+61412345678")],
    deviceContacts: [dev("d1", "Cousin", "AU", "+61 412 345 678")],
  });
  assert.equal(s?.source, "invitation");
  assert.equal(s && "phone" in s ? s.phone : null, "+93712345678");
  // A LINKED collision does not block either: it is not the same number.
  const linked = suggestJoinContact({
    otherPhone: "+93712345678",
    otherLabel: "Ahmad",
    candidates: [cand("p1", "Cousin AU", "+61412345678", 1)],
    deviceContacts: [],
  });
  assert.equal(linked?.source, "invitation");
  // The same digits in E.164 on both sides still match exactly.
  const exact = suggestJoinContact({
    otherPhone: "+93712345678",
    otherLabel: "Ahmad",
    candidates: [cand("p1", "Ahmad K.", "+93 71 234 5678")],
    deviceContacts: [],
  });
  assert.deepEqual(exact, {
    source: "kaata",
    personId: "p1",
    name: "Ahmad K.",
    phone: "+93 71 234 5678",
  });
});

check("phone-book entry with its own dial code → country inferred", () => {
  const af = suggestJoinContact({
    otherPhone: "0700123456",
    otherLabel: "",
    candidates: [],
    deviceContacts: [dev("d1", "Ahmad", null, "+93 70 012 3456")],
  });
  assert.equal(af?.source, "phone");
  assert.equal(af && "countryCode" in af ? af.countryCode : null, "AF");
  const au = suggestJoinContact({
    otherPhone: "+61412345678",
    otherLabel: "",
    candidates: [],
    deviceContacts: [dev("d1", "Cousin", null, "+61 412 345 678")],
  });
  assert.equal(au?.source, "phone");
  assert.equal(au && "countryCode" in au ? au.countryCode : null, "AU");
  // phoneKey is ASCII-only (lib/contacts-sync digitsOf) — the same rule the
  // person/new dedup applies — so a Persian-digit phone-book number never
  // keys, cannot match, and the invitation's own number is suggested instead.
  const fa = suggestJoinContact({
    otherPhone: "+93700123456",
    otherLabel: "",
    candidates: [],
    deviceContacts: [dev("d1", "احمد", null, "+۹۳۷۰۰۱۲۳۴۵۶")],
  });
  assert.equal(fa?.source, "invitation");
  assert.equal(fa && "phone" in fa ? fa.phone : null, "+93700123456");
});

check("nothing on the device knows the number → the invitation's label and number", () => {
  const s = suggestJoinContact({
    otherPhone: "+93700123456",
    otherLabel: "  Ahmad   Khan Durrani ",
    candidates: [cand("p9", "Someone Else", "+93799999999")],
    deviceContacts: [dev("d0", "Other", null, "0799999999")],
  });
  assert.deepEqual(s, {
    source: "invitation",
    firstName: "Ahmad",
    lastName: "Khan Durrani",
    name: "Ahmad Khan Durrani",
    phone: "+93700123456",
    countryCode: "AF",
  });
});

check("invitation number's country follows its dial code; national format → null", () => {
  const au = suggestJoinContact({
    otherPhone: "+61412345678",
    otherLabel: "Cousin",
    candidates: [],
    deviceContacts: [],
  });
  assert.equal(au && "countryCode" in au ? au.countryCode : undefined, "AU");
  const national = suggestJoinContact({
    otherPhone: "0700123456",
    otherLabel: "Cousin",
    candidates: [],
    deviceContacts: [],
  });
  assert.deepEqual(national, {
    source: "invitation",
    firstName: "Cousin",
    lastName: null,
    name: "Cousin",
    phone: "0700123456",
    countryCode: null,
  });
});

check("a number with no label still suggests the invitation (name to be typed)", () => {
  const s = suggestJoinContact({
    otherPhone: "+93700123456",
    otherLabel: "   ",
    candidates: [],
    deviceContacts: [],
  });
  assert.deepEqual(s, {
    source: "invitation",
    firstName: "",
    lastName: null,
    name: "",
    phone: "+93700123456",
    countryCode: "AF",
  });
});

check("no phone → the label alone, split first/last, no number, no country", () => {
  for (const otherPhone of [null, undefined, "", "   ", "+"]) {
    const s = suggestJoinContact({
      otherPhone,
      otherLabel: "Ahmad Khan",
      candidates: [cand("p1", "Ahmad Khan", "0700123456")],
      deviceContacts: [dev("d1", "Ahmad", "Khan", "0700123456")],
    });
    assert.deepEqual(s, {
      source: "invitation",
      firstName: "Ahmad",
      lastName: "Khan",
      name: "Ahmad Khan",
      phone: null,
      countryCode: null,
    });
  }
  const single = suggestJoinContact({
    otherPhone: "",
    otherLabel: "Ahmad",
    candidates: [],
    deviceContacts: [],
  });
  assert.deepEqual(single, {
    source: "invitation",
    firstName: "Ahmad",
    lastName: null,
    name: "Ahmad",
    phone: null,
    countryCode: null,
  });
});

check("no phone and no label → nothing to suggest", () => {
  for (const otherPhone of [null, undefined, "", "+"]) {
    for (const otherLabel of ["", "   "]) {
      assert.equal(
        suggestJoinContact({
          otherPhone,
          otherLabel,
          candidates: [cand("p1", "Ahmad Khan", "0700123456")],
          deviceContacts: [dev("d1", "Ahmad", "Khan", "0700123456")],
        }),
        null,
      );
    }
  }
});

check("candidates and device contacts without a phone never match a number", () => {
  const s = suggestJoinContact({
    otherPhone: "+93700123456",
    otherLabel: "Ahmad",
    candidates: [cand("p1", "No Phone", null)],
    deviceContacts: [dev("d1", "No", "Phone", null), dev("d2", "Blank", null, "")],
  });
  assert.equal(s?.source, "invitation");
});

// ---------------------------------------------------------------------------
// 3. mergeContactSections parity with app/person/new.tsx

// ORACLE — the list logic of app/person/new.tsx as it stood before
// mergeContactSections existed: the phoneDigits/phoneFilter lines, the
// deferred-value trims, the appPhoneKeys + dedupedDevice memos and the
// sections memo, copied verbatim (t() returns its key so titles compare by
// key; React's useMemo/useDeferredValue are identity here).
type OraclePerson = { id: string; name: string; phone: string | null };
type OracleDevice = Device;
type Row = { kind: "app"; person: OraclePerson } | { kind: "device"; contact: OracleDevice };
type Section = { key: string; title: string; data: Row[] };
const ORACLE_DEVICE_LIST_CAP = 80;
const t = (key: string) => key;

function oracle(
  people: OraclePerson[] | null,
  deviceContacts: OracleDevice[],
  firstName: string,
  lastName: string,
  phone: string,
): { sections: Section[]; deviceTruncated: boolean } {
  const phoneDigits = toAsciiDigits(phone).replace(/\D/g, "");
  const phoneFilter = phoneDigits.length >= PHONE_SEARCH_MIN_DIGITS ? phoneDigits : "";

  const dFirst = firstName.trim();
  const dLast = lastName.trim();
  const dPhone = phoneFilter;
  const dQuerying = dFirst.length > 0 || dLast.length > 0 || dPhone.length > 0;

  const appPhoneKeys = (() => {
    const s = new Set<string>();
    for (const p of people ?? []) {
      const k = phoneKey(p.phone);
      if (k) s.add(k);
    }
    return s;
  })();

  const dedupedDevice = deviceContacts.filter((c) => {
    const k = phoneKey(c.phone);
    return !k || !appPhoneKeys.has(k);
  });

  const out: Section[] = [];
  const appList = people ?? [];
  const appMatches = dQuerying ? searchContacts(dFirst, dLast, dPhone, appList) : appList;
  if (appMatches.length > 0) {
    out.push({
      key: "app",
      title: dQuerying ? t("personAdd.section.matches") : t("personAdd.section.recent"),
      data: appMatches.map((person) => ({ kind: "app", person })),
    });
  }
  const deviceFull = dQuerying
    ? searchContacts(dFirst, dLast, dPhone, dedupedDevice)
    : dedupedDevice;
  const deviceShown = deviceFull.slice(0, ORACLE_DEVICE_LIST_CAP);
  if (deviceShown.length > 0) {
    out.push({
      key: "device",
      title: dQuerying ? t("personAdd.section.fromPhone") : t("personAdd.section.allContacts"),
      data: deviceShown.map((contact) => ({ kind: "device", contact })),
    });
  }
  return { sections: out, deviceTruncated: deviceFull.length > deviceShown.length };
}
// END ORACLE

const PEOPLE: OraclePerson[] = [
  { id: "p1", name: "Ahmad Khan", phone: "+93700000001" },
  { id: "p2", name: "Marwa Safi", phone: "0700000002" },
  { id: "p3", name: "Omar Safi", phone: null },
  { id: "p4", name: "Safi Ullah Rahimi", phone: "+61412000004" },
  { id: "p5", name: "Zahra Ahmadi", phone: "+93 70 000 0005" },
];
const DEVICES: OracleDevice[] = [
  dev("d1", "Ahmad", "Khan", "0700000001"), // p1 in national format → deduped
  dev("d2", "Marwa", "Safi", "+93700000002"), // p2 in E.164 → deduped
  dev("d3", "Karim", "Nabi", null), // phone-less → always passes
  dev("d4", "Ahmad", "Zia", "+93701234567"),
  dev("d5", "Rahim", "Safi", "0093 700 000 005"), // p5 with 00 prefix → deduped
  dev("d6", "Omar", null, "0799000006"),
];
for (let i = 0; i < 120; i++) {
  DEVICES.push(dev(`g${i}`, `Contact${i}`, i % 3 ? `Group${i % 7}` : null, `+937${2000000 + i}`));
}

/** The helper's sections with `titleKey` renamed to the oracle's `title`. */
function normalizeActual(r: {
  sections: Array<{ key: string; titleKey: string; data: unknown[] }>;
  deviceTruncated: boolean;
}) {
  return {
    sections: r.sections.map((s) => ({ key: s.key, title: s.titleKey, data: s.data })),
    deviceTruncated: r.deviceTruncated,
  };
}

function parity(
  label: string,
  people: OraclePerson[],
  devices: OracleDevice[],
  first: string,
  last: string,
  phone: string,
): ReturnType<typeof oracle> {
  const expected = oracle(people, devices, first, last, phone);
  check(label, () => {
    // What person/new hands over: trimmed names, digit-only phone query
    // floored at PHONE_SEARCH_MIN_DIGITS.
    const digits = toAsciiDigits(phone).replace(/\D/g, "");
    const screen = mergeContactSections({
      people,
      deviceContacts: devices,
      first: first.trim(),
      last: last.trim(),
      phoneDigits: digits.length >= PHONE_SEARCH_MIN_DIGITS ? digits : "",
    });
    assert.deepEqual(normalizeActual(screen), expected);
    // Raw input lands on the same rules (the helper trims and floors itself).
    const raw = mergeContactSections({
      people,
      deviceContacts: devices,
      first,
      last,
      phoneDigits: phone,
    });
    assert.deepEqual(normalizeActual(raw), expected);
  });
  return expected;
}

console.log("3. mergeContactSections parity with person/new");

const rest = parity(
  "no query: Recent + All contacts, deduped, capped",
  PEOPLE,
  DEVICES,
  "",
  "",
  "",
);
check("no-query shape is what the screen showed", () => {
  assert.deepEqual(
    rest.sections.map((s) => s.title),
    ["personAdd.section.recent", "personAdd.section.allContacts"],
  );
  assert.deepEqual(
    rest.sections[0].data.map((r) => (r.kind === "app" ? r.person.id : "")),
    ["p1", "p2", "p3", "p4", "p5"],
  );
  const deviceIds = rest.sections[1].data.map((r) => (r.kind === "device" ? r.contact.id : ""));
  assert.equal(deviceIds.length, DEVICE_LIST_CAP);
  assert.equal(rest.deviceTruncated, true);
  for (const deduped of ["d1", "d2", "d5"]) assert.ok(!deviceIds.includes(deduped), deduped);
  assert.ok(deviceIds.includes("d3"), "phone-less contact passes through");
  assert.ok(deviceIds.includes("d4"));
});

parity("first-name query", PEOPLE, DEVICES, "Ahmad", "", "");
parity("last-name query", PEOPLE, DEVICES, "", "Safi", "");
parity("first + last query", PEOPLE, DEVICES, "Ahmad", "Zia", "");
parity("untrimmed name query", PEOPLE, DEVICES, "  ahmad ", " ", "");
parity("whitespace-only query is no query", PEOPLE, DEVICES, "   ", "  ", "  ");
parity("phone query with the trunk zero", PEOPLE, DEVICES, "", "", "0701");
parity("phone query in E.164 shape", PEOPLE, DEVICES, "", "", "+93 70 1");
parity("phone query below the digit floor is no filter", PEOPLE, DEVICES, "", "", "07");
parity("phone query in Persian digits", PEOPLE, DEVICES, "", "", "۰۷۰۱");
parity("name AND phone query", PEOPLE, DEVICES, "Contact", "", "9372000");
parity("query that matches nothing", PEOPLE, DEVICES, "Xyzzy", "", "");
parity("empty phone book", PEOPLE, [], "", "", "");
parity("empty phone book with a query", PEOPLE, [], "Safi", "", "");
parity("no people (fresh kaata): the phone book is not deduped", [], DEVICES, "", "", "");
parity("no people with a query", [], DEVICES, "", "Group1", "");
parity("both empty", [], [], "", "", "");
parity("both empty with a query", [], [], "Ahmad", "", "0700");

check("a narrowing query lifts the truncation", () => {
  const r = mergeContactSections({
    people: PEOPLE,
    deviceContacts: DEVICES,
    first: "Contact1",
    last: "",
    phoneDigits: "",
  });
  assert.equal(r.deviceTruncated, false);
  assert.ok(r.sections.every((s) => s.data.length <= DEVICE_LIST_CAP));
});

check("DEVICE_LIST_CAP is the screen's 80 and `cap` overrides it", () => {
  assert.equal(DEVICE_LIST_CAP, 80);
  const r = mergeContactSections({
    people: [],
    deviceContacts: DEVICES,
    first: "",
    last: "",
    phoneDigits: "",
    cap: 5,
  });
  assert.equal(r.sections.length, 1);
  assert.equal(r.sections[0].key, "device");
  assert.equal(r.sections[0].data.length, 5);
  assert.equal(r.deviceTruncated, true);
});

check("the app section carries the caller's row type through unchanged", () => {
  const people = [{ id: "x", name: "Ahmad", phone: null, balance: 12, extra: true }];
  const r = mergeContactSections({
    people,
    deviceContacts: [],
    first: "",
    last: "",
    phoneDigits: "",
  });
  const row = r.sections[0].data[0];
  assert.equal(row.kind, "app");
  if (row.kind === "app") assert.equal(row.person.balance, 12);
});

// ---------------------------------------------------------------------------
// 4. splitSearchQuery — the join screen's single box

console.log("4. splitSearchQuery (join screen single box)");

/** The join screen's wiring: one box through the router into the merge. */
function joinScreen(query: string) {
  return normalizeActual(
    mergeContactSections({ people: PEOPLE, deviceContacts: DEVICES, ...splitSearchQuery(query) }),
  );
}
function ids(r: ReturnType<typeof joinScreen>, key: string): string[] {
  const s = r.sections.find((x) => x.key === key);
  return s
    ? (s.data as Row[]).map((row) => (row.kind === "app" ? row.person.id : row.contact.id))
    : [];
}

check("a number routes to the phone axis only", () => {
  for (const q of ["0700", " 0700 ", "+93 70", "+93700000001", "070-000", "(070) 000", "۰۷۰۰"]) {
    const split = splitSearchQuery(q);
    assert.equal(split.first, "", q);
    assert.equal(split.last, "", q);
    assert.ok(split.phoneDigits.length >= PHONE_SEARCH_MIN_DIGITS, q);
    assert.match(split.phoneDigits, /^\d+$/, q);
  }
});

check("a name routes to the first-name axis only, trimmed", () => {
  for (const [q, first] of [
    ["Ahmad", "Ahmad"],
    ["  ahmad ", "ahmad"],
    ["Ahmad Khan", "Ahmad Khan"],
    ["احمد", "احمد"],
    ["Contact1", "Contact1"],
    ["a1", "a1"],
  ]) {
    assert.deepEqual(splitSearchQuery(q), { first, last: "", phoneDigits: "" }, q);
  }
});

check("a number below the digit floor is no filter, like person/new's phone field", () => {
  for (const q of ["07", "+9", "0", "+", "", "   "]) {
    assert.deepEqual(splitSearchQuery(q), { first: "", last: "", phoneDigits: "" }, q);
  }
  assert.deepEqual(joinScreen("07"), oracle(PEOPLE, DEVICES, "", "", ""));
});

check("typing the sender's number finds the contact in the kaata AND the phone book", () => {
  // The kaata half: p1 (+93700000001), p2 (0700000002) and p5
  // (+93 70 000 0005) all carry 700 (the trunk-zero fallback), by name order.
  const kaata = joinScreen("0700");
  assert.deepEqual(ids(kaata, "app"), ["p1", "p2", "p5"]);
  // The phone-book half: d4 (+93701234567) by its middle digits, d6
  // (0799000006) by its trunk-zero form.
  assert.deepEqual(ids(joinScreen("701234"), "device"), ["d4"]);
  assert.deepEqual(ids(joinScreen("0799"), "device"), ["d6"]);
  assert.deepEqual(ids(joinScreen("+93 70 000 0001"), "app"), ["p1"]);
  assert.deepEqual(ids(joinScreen("۰۷۰۰"), "app"), ["p1", "p2", "p5"]);
  // None of these is "no match" — the regression this pins.
  for (const q of ["0700", "0799", "+93700000001", "701234"]) {
    assert.ok(joinScreen(q).sections.length > 0, `${q} matched nothing`);
  }
});

check("the single box gives person/new's answer for its matching field", () => {
  for (const q of ["0700", "700123", "0799", "+93700000001", "+93 70 1", "۰۷۰۱", "07"]) {
    assert.deepEqual(joinScreen(q), oracle(PEOPLE, DEVICES, "", "", q), q);
  }
  for (const q of ["Ahmad", "Marwa", "Safi", "  ahmad ", "Contact1", "Xyzzy", "احمد"]) {
    assert.deepEqual(joinScreen(q), oracle(PEOPLE, DEVICES, q, "", ""), q);
  }
});

check("a name query still finds names", () => {
  // p1 by its first name; p5 "Zahra Ahmadi" through the loose whole-name
  // fallback, ranked below the field match — person/new's own order.
  assert.deepEqual(ids(joinScreen("Ahmad"), "app"), ["p1", "p5"]);
  assert.deepEqual(ids(joinScreen("Ahmad"), "device"), ["d4"]);
  assert.deepEqual(ids(joinScreen("Marwa"), "app"), ["p2"]);
  assert.equal(joinScreen("Xyzzy").sections.length, 0);
});

console.log(`tab-join selftest: ${passed} checks passed`);
