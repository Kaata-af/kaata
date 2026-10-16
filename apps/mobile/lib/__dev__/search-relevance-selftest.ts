import assert from "node:assert/strict";
import { normalize, searchContacts, searchCustomerMatches } from "../search";

const names = [
  { id: "fuzzy-first", name: "احتمادی", phone: null },
  { id: "literal-late", name: "حاجی احمد فرزند محمد", phone: null },
  { id: "literal-prefix", name: "احمد خان", phone: null },
  { id: "exact", name: "احمد", phone: null },
  { id: "unrelated", name: "کریم", phone: null },
];
const query = (first: string, phoneDigits = "", last = "") => ({ first, last, phoneDigits });
const ranked = <T extends { id: string; name: string; phone?: string | null }>(
  first: string,
  people: T[],
) => {
  const result = searchCustomerMatches(query(first), people);
  return result.people
    .slice()
    .sort((a, b) => (result.relevanceById.get(b.id) ?? 0) - (result.relevanceById.get(a.id) ?? 0));
};

const ahmad = searchCustomerMatches(query("احمد"), names);
assert.deepEqual(
  ahmad.people.map((person) => person.id),
  ["fuzzy-first", "literal-late", "literal-prefix", "exact"],
  "matching preserves original rows/order for the caller's chosen display sort",
);
assert.deepEqual(
  [...ahmad.relevanceById],
  [
    ["fuzzy-first", 1],
    ["literal-late", 2],
    ["literal-prefix", 2],
    ["exact", 3],
  ],
);
assert.deepEqual(
  ranked("احمد", names).map((person) => person.id),
  ["exact", "literal-late", "literal-prefix", "fuzzy-first"],
  "literal احمد inside a later token outranks scattered-character matches",
);
assert.equal(ahmad.people[1], names[1], "results retain the original customer objects");
assert.equal(names[0].name, "احتمادی", "search must never rewrite a stored name");

const latin = [
  { id: "fuzzy-first", name: "Ahamad Khan" },
  { id: "literal-late", name: "Zarif Ahmad" },
  { id: "literal-prefix", name: "Ahmadzada" },
  { id: "exact", name: "ÁHMAD" },
];
assert.deepEqual(
  ranked("ahmad", latin).map((person) => person.id),
  ["exact", "literal-late", "literal-prefix", "fuzzy-first"],
  "whole-name search has no first-name-field or shorter-name bonus",
);
assert.equal(
  searchCustomerMatches(query("Zarif", "", "Ahmad"), latin).relevanceById.get("literal-late"),
  3,
  "parsed name fields are one whole-name phrase for customer search",
);
assert.deepEqual(
  searchCustomerMatches(query(".*"), latin).people,
  [],
  "query punctuation stays literal rather than becoming a regular expression",
);

assert.equal(normalize("  Áhmad\tKHAN  "), "ahmad khan");
assert.equal(normalize("كريم يحيى"), normalize("کریم یحیی"), "Arabic/Persian Yeh and Kaf agree");
assert.equal(normalize("أَحْمَـد"), "احمد", "Arabic vowels, Alef accents and tatweel are optional");
assert.equal(normalize("غلام‌احمد"), normalize("غلام احمد"), "ZWNJ is a word boundary");
assert.equal(
  normalize("\u061c\u200fاحمد\u202a\u2066"),
  "احمد",
  "bidi controls do not affect matching",
);
assert.equal(normalize("أحمد ۱۲٣"), "احمد ۱۲٣", "normalization preserves name digits");
assert.equal(normalize("نعمة"), "نعمة", "unrelated Arabic letters are not transliterated");
assert.equal(
  normalize("و\u06e5ی\u06e6"),
  "و\u06e5ی\u06e6",
  "small Arabic letter forms are not stripped",
);
assert.equal(
  searchCustomerMatches(query("کریم یحیی"), [
    { id: "arabic", name: "كريم يحيى" },
  ]).relevanceById.get("arabic"),
  3,
);
assert.equal(
  searchCustomerMatches(query("غلام احمد"), [
    { id: "joined", name: "غلام‌احمد" },
  ]).relevanceById.get("joined"),
  3,
);
assert.equal(
  searchCustomerMatches(query("احمد"), [{ id: "vowels", name: "أَحْمَـد" }]).relevanceById.get(
    "vowels",
  ),
  3,
);

const phones = [
  { id: "e164", name: "Zahra", phone: "+93700123456" },
  { id: "local", name: "Ahmad", phone: "0700123456" },
  { id: "local-digits", name: "Karim", phone: "۰۷۰۰۱۲۳۴۵۶" },
  { id: "different", name: "Marwa", phone: "+93711123456" },
  { id: "no-phone", name: "Safi", phone: null },
];
for (const typed of ["0700123456", "۰۷۰۰۱۲۳۴۵۶", "٠٧٠٠١٢٣٤٥٦", "700123456"]) {
  const result = searchCustomerMatches(query("", typed), phones);
  assert.deepEqual(
    result.people.map((person) => person.id).sort(),
    ["e164", "local", "local-digits"],
    `phone query preserves digit/transliteration and trunk-zero matching: ${typed}`,
  );
  assert.equal(
    result.relevanceById.size,
    0,
    "phone-only matches leave display ordering to the caller",
  );
}
assert.deepEqual(
  searchCustomerMatches(query("", "070"), phones)
    .people.map((person) => person.id)
    .sort(),
  ["local", "local-digits"],
  "a three-digit query must not strip its trunk zero into a broad two-digit fallback",
);
assert.deepEqual(
  searchCustomerMatches(query("Ahmad", "۰۷۰۰"), phones).people.map((person) => person.id),
  ["local"],
  "when both are supplied the name and phone filters still combine",
);
const empty = searchCustomerMatches(query("  "), phones);
assert.equal(empty.people, phones, "an empty query leaves the original list intact");
assert.equal(empty.relevanceById.size, 0);
assert.deepEqual(searchCustomerMatches(query("nothing"), phones).people, []);

const fieldAware = [{ name: "Safi Ullah Rahimi" }, { name: "Omar Safi" }, { name: "Marwa Safi" }];
assert.deepEqual(
  searchContacts("", "Safi", "", fieldAware).map((person) => person.name),
  ["Marwa Safi", "Omar Safi", "Safi Ullah Rahimi"],
  "Add Customer's separate last-name field keeps its field-aware ranking",
);
assert.equal(
  searchContacts("Safi", "", "", fieldAware)[0],
  fieldAware[0],
  "Add Customer's first-name field still favors a first-name match",
);

console.log("Customer search relevance, name normalization and phone regressions passed.");
