import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalWebEvent,
  canonicalWebJSON,
  nextWebHLC,
  normalizeWebPhone,
  parseWebEntryAmount,
  webAmountMinor,
} from "./web-ledger-protocol.ts";

test("web signing bytes match the backend's pinned witnessed-event fixture", () => {
  const account = "a1b2c3d4-0000-4000-8000-000000000001";
  const device = "a1b2c3d4-0000-4000-8000-000000000002";
  const vault = "a1b2c3d4-0000-4000-8000-000000000003";
  const event = "a1b2c3d4-0000-4000-8000-000000000005";
  const pubkey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  const encoded = canonicalWebEvent({
    event_id: event,
    event_type: "vault_device_added",
    vault_id: vault,
    target_id: account,
    relationship_id: null,
    hlc: { pms: 1750000000000, l: 0, did: device },
    device_id: device,
    actor_account_id: null,
    payload_schema: 1,
    payload: {
      account_id: account,
      device_id: device,
      device_pubkey: pubkey,
      witness: { sig_b64: "c2ln", server_key_id: "primary", issued_at_ms: 1750000000000 },
    },
  });
  // Literal copied from internal/canonical/canonical_test.go, not computed
  // with a second copy of the implementation under test.
  const expected =
    '{"actor_account_id":null,"device_id":"a1b2c3d4-0000-4000-8000-000000000002","event_id":"a1b2c3d4-0000-4000-8000-000000000005","event_type":"vault_device_added","hlc":{"did":"a1b2c3d4-0000-4000-8000-000000000002","l":0,"pms":1750000000000},"payload":{"account_id":"a1b2c3d4-0000-4000-8000-000000000001","device_id":"a1b2c3d4-0000-4000-8000-000000000002","device_pubkey":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=","witness":{"issued_at_ms":1750000000000,"server_key_id":"primary","sig_b64":"c2ln"}},"payload_schema":1,"relationship_id":null,"target_id":"a1b2c3d4-0000-4000-8000-000000000001","vault_id":"a1b2c3d4-0000-4000-8000-000000000003"}';
  assert.equal(new TextDecoder().decode(encoded), expected);
  assert.equal(
    canonicalWebJSON({ note: "دکان <&>\n", amount: 12.5 }),
    '{"amount":12.5,"note":"دکان <&>\\n"}',
  );
  assert.throws(() => canonicalWebJSON({ amount: Infinity }));
});

test("entry input preserves major units and rejects rounding, grouping and nonfinite amounts", () => {
  assert.equal(parseWebEntryAmount("۱۲٫۵۰"), 12.5);
  assert.equal(parseWebEntryAmount("٠٫٢٩"), 0.29);
  assert.equal(parseWebEntryAmount("12,50"), 12.5);
  assert.equal(parseWebEntryAmount(".50"), 0.5);
  assert.equal(parseWebEntryAmount("100"), 100);
  assert.equal(webAmountMinor("0.29"), 29);
  assert.equal(webAmountMinor("9999999999.99"), 999999999999);
  for (const value of ["1.001", "1e3", "1,000", "0", "-1", "NaN", "Infinity", "10000000000"]) {
    assert.throws(() => parseWebEntryAmount(value), value);
  }
  assert.throws(() => webAmountMinor("9223372036854775807"));
});

test("HLC advances after the server frontier even when the computer clock is behind", () => {
  assert.deepEqual(nextWebHLC({ pms: 300, l: 8, did: "phone" }, "browser", 100), {
    pms: 300,
    l: 9,
    did: "browser",
  });
  assert.deepEqual(nextWebHLC({ pms: 300, l: 8, did: "phone" }, "browser", 301), {
    pms: 301,
    l: 0,
    did: "browser",
  });
  assert.throws(() => nextWebHLC({ pms: NaN, l: 0, did: "phone" }, "browser", 301));
});

test("phone input requires an explicit country and accepts Dari keyboard digits", () => {
  assert.equal(normalizeWebPhone(" +۹۳ ۷۰ ۱۲۳ ۴۵۶۷ "), "+93701234567");
  assert.equal(normalizeWebPhone("0044 20 1234 5678"), "+442012345678");
  assert.equal(normalizeWebPhone(""), null);
  for (const value of ["0701234567", "+93abc701234567", "+0", "++93701234567"])
    assert.throws(() => normalizeWebPhone(value));
});
