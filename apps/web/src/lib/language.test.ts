import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLanguage, isRtlLanguage, languageForLocale } from "./language.ts";

test("Pashto, Dari and English locale tags normalize consistently", () => {
  for (const tag of ["ps", "ps-AF", "PS_af", " ps-AF "]) assert.equal(languageForLocale(tag), "ps");
  for (const tag of ["fa", "fa-AF", "prs", "prs-AF"]) assert.equal(languageForLocale(tag), "fa");
  assert.equal(languageForLocale("en-US"), "en");
  for (const tag of ["pseudolocale", "farsi", "de", ""])
    assert.equal(languageForLocale(tag), undefined);
  assert.equal(isRtlLanguage("ps"), true);
  assert.equal(isRtlLanguage("fa"), true);
  assert.equal(isRtlLanguage("en"), false);
});

test("persisted choices win and browser preference order chooses the first supported language", () => {
  assert.equal(detectLanguage("ps", ["en-US", "fa-AF"]), "ps");
  assert.equal(detectLanguage("en", ["ps-AF"]), "en");
  assert.equal(detectLanguage("fa", ["ps-AF"]), "fa");
  assert.equal(detectLanguage(null, ["de-DE", "ps-AF", "fa"]), "ps");
  assert.equal(detectLanguage("unknown", ["prs-AF", "ps"]), "fa");
  assert.equal(detectLanguage(null, ["en-US", "ps"]), "en");
  assert.equal(detectLanguage(null, []), "en");
});
