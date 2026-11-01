import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWebProfile } from "./web-profile";

test("profile completeness comes from the server, not a provider name or a cached login", () => {
  const partial = {
    name: "Provider name",
    phone: "",
    shop_name: "",
    needs_setup: true,
    has_onboarded: false,
  };
  assert.deepEqual(parseWebProfile(partial), partial);
  const existing = {
    name: "احمد",
    phone: "+93700123456",
    shop_name: "My kaata",
    needs_setup: false,
    has_onboarded: true,
  };
  assert.deepEqual(parseWebProfile(existing), existing);
});

test("missing or malformed profile flags cannot silently complete setup", () => {
  const profile = {
    name: "Owner",
    phone: "+93700123456",
    shop_name: "",
    needs_setup: false,
    has_onboarded: false,
  };
  for (const invalid of [
    null,
    [],
    {},
    { ...profile, phone: null },
    { ...profile, needs_setup: "false" },
    { ...profile, has_onboarded: undefined },
  ]) {
    assert.throws(() => parseWebProfile(invalid), /Profile could not be loaded/);
  }
});
