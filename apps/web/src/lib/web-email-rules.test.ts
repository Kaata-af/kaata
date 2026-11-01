import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newWebPasswordProblem,
  normalizeWebEmailAddress,
  normalizeWebEmailCode,
  normalizeWebEmailIdentifier,
} from "./web-email-rules";

test("new passwords use the mobile 8–128 character boundaries", () => {
  assert.equal(newWebPasswordProblem("Q7!mR9x"), "too_short");
  assert.equal(newWebPasswordProblem("Q7!mR9x@"), null);
  const longest = "Q7!mR9x@".repeat(16);
  assert.equal(newWebPasswordProblem(longest), null);
  assert.equal(newWebPasswordProblem(longest + "Z"), "too_long");
});

test("password length counts normalized Unicode characters, not UTF-16 units", () => {
  assert.equal(newWebPasswordProblem("😀🙂🙃😉😊😇🥰"), "too_short");
  assert.equal(newWebPasswordProblem("😀🙂🙃😉😊😇🥰😍"), null);
  assert.equal(newWebPasswordProblem("ﬃaX!9"), "too_short"); // NFKC expands ﬃ to ffi: 7.
  assert.equal(newWebPasswordProblem("ﬃaX!9q"), null); // Eight canonical characters.
});

test("joiners and bidi controls do not make a short password long enough", () => {
  assert.equal(
    newWebPasswordProblem("Q7!mR9x\u200c\u200d\u200e\u200f\u061c\u202e\u2066"),
    "too_short",
  );
  assert.equal(newWebPasswordProblem("Q7!m\u200cR9x@\u2069"), null);
});

test("Arabic letter variants and compatibility characters share mobile pattern checks", () => {
  assert.equal(newWebPasswordProblem("يىیيىیX9"), "pattern");
  assert.equal(newWebPasswordProblem("كکكکكکX9"), "pattern");
  assert.equal(newWebPasswordProblem("ａｂｃｄｅｆX9"), "pattern");
  assert.equal(newWebPasswordProblem("پاییز!۹ش"), null);
});

test("new passwords reject outer Unicode whitespace while allowing internal spaces", () => {
  assert.equal(newWebPasswordProblem(" Q7!mR9x@"), "whitespace");
  assert.equal(newWebPasswordProblem("Q7!mR9x@\u00a0"), "whitespace");
  assert.equal(newWebPasswordProblem("Q7!m R9x@"), null);
});

test("digit-only passwords require twelve digits after localized normalization", () => {
  assert.equal(newWebPasswordProblem("۹۰۷۳۱۵۸۲"), "pattern");
  assert.equal(newWebPasswordProblem("٩٠٧٣١٥٨٢٤٦٢٨"), null);
  assert.equal(newWebPasswordProblem("９０７３１５８２４６２８"), null);
});

test("six repeated or sequential characters are refused case-insensitively", () => {
  for (const password of ["aAaAaAX9", "123456!q", "fedcba!9", "9!AAAAAA"])
    assert.equal(newWebPasswordProblem(password), "pattern", password);
  assert.equal(newWebPasswordProblem("Q7!aaaaa"), null);
  assert.equal(newWebPasswordProblem("123456789012"), "pattern");
});

test("common passwords and personal details remain the server's decision", () => {
  assert.equal(newWebPasswordProblem("password"), null);
  assert.equal(newWebPasswordProblem("shop.owner@example.com"), null);
});

test("email codes fold both localized digit sets and tolerate pasted separators", () => {
  assert.equal(normalizeWebEmailCode("۱۲۳-٤٥٦"), "123456");
  assert.equal(normalizeWebEmailCode("\u2066 ٠ ۱\u200c٢-۳ ٤ ۵\u2069"), "012345");
  assert.equal(normalizeWebEmailCode("code: 1234567"), "123456");
  assert.equal(normalizeWebEmailCode("ab12"), "12");
});

test("addresses and usernames normalize only the mobile-approved input changes", () => {
  assert.equal(normalizeWebEmailAddress("  Shop.۱۲+tag@Example.COM  "), "Shop.12+tag@Example.COM");
  assert.equal(normalizeWebEmailIdentifier("  @Ali_۱۲  "), "Ali_12");
  assert.equal(normalizeWebEmailIdentifier("@  Ali_١٢ "), "Ali_12");
  assert.equal(normalizeWebEmailIdentifier("  Shop.۱۲@Example.COM  "), "Shop.12@Example.COM");
  assert.equal(normalizeWebEmailIdentifier("@someone@example.com"), "@someone@example.com");
});
