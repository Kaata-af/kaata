import assert from "node:assert/strict";
import { decodePeopleQr, encodePeopleQr } from "../people-qr";

let checks = 0;
function equal(actual: unknown, expected: unknown, label: string) {
  assert.equal(actual, expected, label);
  checks++;
}

const accountId = "12345678-abcd-4abc-8def-1234567890ab";
const code = `kaata-person:1:${accountId}`;
for (const id of [
  accountId,
  "019a63e2-1234-7abc-9def-0123456789ab",
  "00000000-0000-0000-0000-000000000001",
]) {
  equal(encodePeopleQr(id), `kaata-person:1:${id}`, "exact versioned payload");
  equal(decodePeopleQr(encodePeopleQr(id)!), id, "account identity survives roundtrip");
}

for (const id of [
  "",
  "00000000-0000-0000-0000-000000000000",
  accountId.toUpperCase(),
  accountId.replaceAll("-", ""),
  `{${accountId}}`,
  ` ${accountId}`,
  `${accountId} `,
  `${accountId}\n`,
  `${accountId}\r\n`,
  `${accountId}\0`,
  accountId.slice(1),
  accountId.replace("a", "g"),
  accountId.replace("-", "–"),
  "local:anonymous-device",
]) {
  equal(encodePeopleQr(id), null, "invalid identity cannot be displayed");
  equal(decodePeopleQr(`kaata-person:1:${id}`), null, "invalid identity cannot be scanned");
}

for (const data of [
  "",
  accountId,
  `kaata-person:0:${accountId}`,
  `kaata-person:2:${accountId}`,
  `kaata-person:01:${accountId}`,
  `KAATA-PERSON:1:${accountId}`,
  `kaata-person:1:${accountId}?action=add`,
  `kaata-person:1:${accountId}#accept`,
  `kaata-person:1:${accountId}:owner`,
  ` ${code}`,
  `${code}\n`,
  `\uFEFF${code}`,
  `kaata-person:1:${accountId.replaceAll("-", "%2D")}`,
  `kaata://people/${accountId}`,
  `https://kaata.af/people/${accountId}`,
  "kaata://invite/secret",
  "https://kaata.af/t/secret",
  `v_${accountId}`,
  JSON.stringify({ v: 4, vault_id: accountId, shop_mode_token: "pair-token" }),
  JSON.stringify({ type: "kaata-person", version: 1, account_id: accountId }),
  "javascript:alert(1)",
  "x".repeat(10000),
]) {
  equal(decodePeopleQr(data), null, "foreign or extended payload is rejected");
}

for (const value of [null, undefined, 42, {}, [code]]) {
  equal(decodePeopleQr(value as unknown as string), null, "untyped scan input is rejected");
  equal(encodePeopleQr(value as unknown as string), null, "untyped identity is rejected");
}

console.log(`PASS: ${checks} people QR codec checks`);
