import assert from "node:assert/strict";
import { compileUI } from "./ui-fixture";

const qr = compileUI("../mesh/pair-qr", { "expo-crypto": {} }) as typeof import("../mesh/pair-qr");
const payload: import("../mesh/pair-qr").PairQrPayload = {
  v: qr.PAIR_QR_VERSION,
  vault_id: "vault",
  vault_name: "Original dollar book",
  currency: "USD",
  legacy_currency: "USD",
  default_entry_currency: "EUR",
  issuer_account_id: "account",
  issuer_install_id: "install",
  issued_at_ms: Date.now(),
  expires_at_ms: Date.now() + 60000,
  shop_mode_token: "nonce",
  role: "editor",
  issuer_device_pubkey: "device-key",
  issuer_display_name: "Owner",
};
const decoded = qr.decodePairQr(qr.encodePairQr(payload));
assert.ok(decoded.ok);
assert.deepEqual(
  decoded.payload,
  payload,
  "pairing preserves the original and future-entry denominations independently",
);
for (const key of ["currency", "legacy_currency", "default_entry_currency"]) {
  const missing = { ...payload };
  delete missing[key as keyof typeof missing];
  assert.deepEqual(qr.decodePairQr(JSON.stringify(missing)), {
    ok: false,
    reason: "missing_field",
  });
  assert.deepEqual(qr.decodePairQr(JSON.stringify({ ...payload, [key]: "usd" })), {
    ok: false,
    reason: "missing_field",
  });
}
assert.deepEqual(qr.decodePairQr(JSON.stringify({ ...payload, v: 5 })), {
  ok: false,
  reason: "unsupported_version",
});
console.log(
  "PASS: offline pair QR preserves legacy and default currency; incomplete denominations fail closed",
);
