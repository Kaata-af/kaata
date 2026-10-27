// Synthetic native contacts only: no device book, permissions, or database.
import assert from "node:assert/strict";
import { compileUI } from "./ui-fixture";
import { PhoneMatchIndex, samePhoneNumber } from "../phone-match";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
let cards: any[] = [];
let writes: any[] = [];
let added: any[] = [];
const native = {
  getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  getContactsAsync: async () => ({ data: cards }),
  getContactByIdAsync: async (id: string) => cards.find((card) => card.id === id),
  updateContactAsync: async (patch: any) => {
    writes.push(patch);
  },
  addContactAsync: async (contact: any) => {
    added.push(contact);
    return "added";
  },
  Fields: {},
  SortTypes: {},
  ContactTypes: { Person: "person" },
};
const contacts = compileUI("../contacts-sync", {
  "expo-contacts/legacy": native,
  "./phone-match": require("../phone-match"),
}) as typeof import("../contacts-sync");
const merge = require("../contacts-merge") as typeof import("../contacts-merge");
let checks = 0;
function same(actual: unknown, expected: unknown, label: string) {
  assert.deepEqual(actual, expected, label);
  checks++;
}
function card(id: string, number: string, name = id, countryCode?: string) {
  return {
    id,
    name,
    firstName: name,
    phoneNumbers: [{ id: id + "-mobile", number, countryCode, label: "mobile", isPrimary: true }],
  };
}
function reset(...data: any[]) {
  cards = data;
  writes = [];
  added = [];
}

async function main() {
  for (const [a, b, expected] of [
    ["+93712345678", "+61412345678", false],
    ["0093 712345678", "+61412345678", false],
    ["+93700123456", "0093 700 123456", true],
    ["+93700123456", "+۹۳۷۰۰۱۲۳۴۵۶", true],
    ["+93700123456", "0700 123456", true],
    ["+61412345678", "0412 345678", true],
    ["+93712345678", "12345678", false],
    ["+2471234", "1234", true],
    ["+24762889", "62889", true],
    ["+390236601832", "0236601832", true],
    ["+390236601832", "236601832", false],
    ["0236601832", "236601832", false],
    ["0700123456", "700123456", false],
  ] as [string, string, boolean][]) {
    same(samePhoneNumber(a, b), expected, `${a} vs ${b}`);
    same(samePhoneNumber(b, a), expected, `symmetric: ${b} vs ${a}`);
  }
  same(
    samePhoneNumber("0700123456", "+44700123456", "af"),
    false,
    "known AF card is not rehomed to UK",
  );
  same(
    samePhoneNumber("1234", "+2471234", "AF"),
    false,
    "failed known AF parse cannot retry as AC",
  );
  same(
    samePhoneNumber("+2471234", "1234", undefined, "AF"),
    false,
    "known-country failure is symmetric",
  );
  same(
    samePhoneNumber("0700123456", "+44700123456", "gb"),
    true,
    "known UK national card matches UK",
  );
  same(
    samePhoneNumber("0700123456", "0700123456", "AF", "GB"),
    false,
    "known different plans differ",
  );

  const index = new PhoneMatchIndex<string>();
  index.add("+93712345678", "AF");
  index.add("+61412345678", "AU");
  same(index.find("+93712345678"), "AF", "indexed AF exact match");
  same(index.find("0061412345678"), "AU", "indexed AU exact match despite shared suffix");
  same(index.find("12345678"), undefined, "index never proves identity by suffix");

  reset(
    card("AF", "+93712345678"),
    card("AU", "+61412345678"),
    card("AF duplicate", "0093 712345678"),
  );
  same(
    (await contacts.readDeviceContacts()).contacts.map((item) => item.id),
    ["AF", "AU"],
    "read keeps different countries and removes true duplicate",
  );
  reset(card("national", "0700123456"), card("AF", "+93700123456"), card("GB", "+44700123456"));
  const upgraded = (await contacts.readDeviceContacts()).contacts;
  same(
    upgraded.map((item) => item.id),
    ["national", "GB"],
    "national upgrade leaves no stale alias to swallow UK",
  );
  same(upgraded[0].phone, "+93700123456", "explicit duplicate supplies country context for import");
  reset(card("AF", "0700123456", "AF", "af"), card("GB", "0700123456", "GB", "gb"));
  same(
    (await contacts.readDeviceContacts()).contacts.length,
    2,
    "native country hints keep distinct national cards",
  );
  reset(
    card("CA", "4165551234", "Canadian", "ca"),
    card("IT", "0236601832", "Italian", "it"),
    card("unknown", "0412345678"),
  );
  same(
    (await contacts.readDeviceContacts()).contacts.map((item) => item.phone),
    ["+14165551234", "+390236601832", "0412345678"],
    "read carries native country into E164 while preserving Italian0 and unknown national input",
  );

  const result = merge.mergeContactSections({
    people: [{ id: "p", name: "AF", phone: "+93712345678" }],
    deviceContacts: [{ id: "d", name: "AU", phone: "+61412345678" }],
    first: "",
    last: "",
    phoneDigits: "",
  });
  same(
    result.sections.find((section) => section.key === "device")?.data.length,
    1,
    "foreign same-suffix contact remains available to add",
  );
  const short = merge.mergeContactSections({
    people: [{ id: "p", name: "AC", phone: "+2471234" }],
    deviceContacts: [{ id: "d", name: "AC", phone: "1234" }],
    first: "",
    last: "",
    phoneDigits: "",
  });
  same(
    short.sections.some((section) => section.key === "device"),
    false,
    "short national contact matches actual calling plan",
  );
  reset(card("invalid AF", "1234", "Short AF", "af"));
  const knownInvalid = (await contacts.readDeviceContacts()).contacts;
  const wrongPlan = merge.mergeContactSections({
    people: [{ id: "p", name: "AC", phone: "+2471234" }],
    deviceContacts: knownInvalid,
    first: "",
    last: "",
    phoneDigits: "",
  });
  same(
    wrongPlan.sections.some((section) => section.key === "device"),
    true,
    "failed native AF parse retains hint through merge and cannot become AC",
  );

  reset(card("AU", "+61412345678", "Cousin"));
  await contacts.upsertPersonInPhoneBook("Afghan", "Customer", "+93712345678");
  same(writes.length, 0, "different-country suffix cannot overwrite existing card");
  same(added.length, 1, "different-country customer gets their own native contact");

  const own = card("own", "+93700123456", "Old Name");
  own.phoneNumbers.push({
    id: "foreign",
    number: "+44700123456",
    label: "work",
    isPrimary: false,
  } as any);
  own.phoneNumbers.push({
    id: "home",
    number: "+93201234567",
    label: "home",
    isPrimary: false,
  } as any);
  reset(own);
  await contacts.upsertPersonInPhoneBook("New", "Name", "+44700123456", {
    previousPhoneE164: "+93700123456",
    expectedExistingName: "Old Name",
  });
  same(added.length, 0, "country-only edit updates the original native card");
  same(writes.length, 1, "country-only edit is not skipped when suffix agrees");
  same(
    writes[0].phoneNumbers,
    [{ ...own.phoneNumbers[0], number: "+44700123456" }, own.phoneNumbers[1], own.phoneNumbers[2]],
    "only old full number changes; ids, labels, primary flags and other numbers survive",
  );
  same(writes[0].name, "New Name", "name may change when prior name still matches");

  reset(card("renamed", "+93700123456", "User's Chosen Name"));
  await contacts.upsertPersonInPhoneBook("New", "Name", "+93700987654", {
    previousPhoneE164: "+93700123456",
    expectedExistingName: "Old Name",
  });
  same(writes[0].name, undefined, "user's renamed card is preserved");
  same(writes[0].phoneNumbers[0].number, "+93700987654", "owned old number still repaired");

  reset(card("known AF", "0700123456", "Afghan", "af"));
  await contacts.upsertPersonInPhoneBook("UK", "Customer", "+44700123456");
  same(writes.length, 0, "native AF country hint prevents updating a UK lookalike");
  same(added.length, 1, "known foreign national card does not block creating UK card");
  reset(card("short", "1234", "Short AC", "ac"));
  await contacts.upsertPersonInPhoneBook("Short", "AC", "+2471234");
  same(added.length, 0, "short AC national number does not create duplicate");
  same(writes.length, 0, "create path never renames an existing card");
  console.log(`PASS ${checks} country-safe native contact checks`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
