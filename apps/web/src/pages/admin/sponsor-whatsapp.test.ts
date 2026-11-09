import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSponsorWhatsAppLink, parseSponsorWhatsAppLink } from "./sponsor-whatsapp";

test("builds a WhatsApp link from an international number and preserves the message", () => {
  const message = " سلام!\nMore info? 50% off & free delivery + 😀 ";
  const result = buildSponsorWhatsAppLink("۰۰۹۳ (۷۰) ۱۲۳-۴۵۶۷", message);
  assert.ok("url" in result);
  assert.equal(result.url, `https://wa.me/93701234567?text=${encodeURIComponent(message)}`);
  assert.deepEqual(parseSponsorWhatsAppLink(result.url), { phone: "+93701234567", message });
});

test("rejects invalid recipients, empty messages, and links beyond the backend byte limit", () => {
  assert.ok("error" in buildSponsorWhatsAppLink("0701234567", "Hello"));
  assert.ok("error" in buildSponsorWhatsAppLink("+93701234567?text=Hi", "Hello"));
  assert.ok("error" in buildSponsorWhatsAppLink("+93701234567", " \n "));
  assert.ok("error" in buildSponsorWhatsAppLink("+93701234567", "\ud800"));
  assert.ok("error" in buildSponsorWhatsAppLink("+93701234567", "😀".repeat(171)));

  const phone = "+93701234567";
  const prefixLength = "https://wa.me/93701234567?text=".length;
  const largest = "x".repeat(2048 - prefixLength);
  const accepted = buildSponsorWhatsAppLink(phone, largest);
  assert.ok("url" in accepted);
  assert.equal(Buffer.byteLength(accepted.url), 2048);
  assert.ok("error" in buildSponsorWhatsAppLink(phone, largest + "x"));
});

test("preserves unrelated or custom destinations as website links", () => {
  for (const url of [
    "https://example.org/path",
    "https://wa.me/93701234567",
    "https://wa.me/93701234567?text=Hi+there",
    "https://wa.me/93701234567?text=Hi&tracking=1",
    "https://wa.me/93701234567?text=%GG",
    "https://wa.me.evil.test/93701234567?text=Hi",
  ]) {
    assert.equal(parseSponsorWhatsAppLink(url), null);
  }
});
