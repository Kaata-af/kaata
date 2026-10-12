import assert from "node:assert/strict";

// Load the real preference module without native database/localization code.
// Only synthetic app_meta values are used; no device settings are written.
const saved = new Map<string, NodeJS.Module | undefined>();
function stub(name: string, exports: object) {
  const filename = require.resolve(name);
  saved.set(filename, require.cache[filename]);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
}
let locale = "en";
let stored: string | null = null;
let storedOffset: string | null = null;
let readFails = false;
stub("../db", {
  getAppMeta: async (key: string) => {
    assert.ok(key === "calendar_pref" || key === "qamari_offset", key);
    if (readFails) throw new Error("synthetic metadata read failure");
    return key === "calendar_pref" ? stored : storedOffset;
  },
});
stub("../i18n", { getLocale: () => locale, subscribeLocale: () => () => {} });

async function main() {
  const cal = require("../calendar") as typeof import("../calendar");
  for (const value of ["auto", "gregorian", "jalali", "qamari"] as const) {
    assert.equal(cal.parseCalendarPref(value), value);
  }
  for (const value of [null, undefined, "", "islamic", "Qamari", "nonsense"]) {
    assert.equal(cal.parseCalendarPref(value), "auto");
  }
  assert.equal(cal.getEffectiveCalendar(), "gregorian");
  locale = "fa";
  assert.equal(cal.getEffectiveCalendar(), "jalali", "Auto retains the existing Dari default");

  let repaintCount = 0;
  const unsubscribe = cal.subscribeCalendar(() => repaintCount++);
  stored = "qamari";
  await cal.initCalendarFromPref();
  assert.equal(cal.getCalendarPref(), "qamari");
  assert.equal(cal.getEffectiveCalendar(), "qamari", "saved choice applies before initial render");
  assert.equal(repaintCount, 1);
  locale = "en";
  assert.equal(cal.getEffectiveCalendar(), "qamari", "language never replaces an explicit choice");
  cal.setCalendarPref("qamari");
  assert.equal(repaintCount, 1, "same preference has no redundant notification");
  cal.setCalendarPref("gregorian");
  assert.equal(repaintCount, 2, "mounted dates repaint when calendar changes");
  // The Qamari adjustment (audit #15) loads with the calendar and repaints
  // mounted dates; only whole days within ±2 are kept.
  storedOffset = "-1";
  await cal.initCalendarFromPref();
  assert.equal(cal.getQamariOffset(), -1, "the saved adjustment applies before first render");
  assert.equal(repaintCount, 3);
  cal.setQamariOffset(-1);
  assert.equal(repaintCount, 3, "same adjustment, no redundant notification");
  cal.setQamariOffset(2);
  assert.equal(cal.getQamariOffset(), 2);
  assert.equal(repaintCount, 4, "mounted Qamari dates repaint");
  cal.setQamariOffset(9);
  assert.equal(cal.getQamariOffset(), 0, "out of range is no adjustment");
  storedOffset = "garbage";
  await cal.initCalendarFromPref();
  assert.equal(cal.getQamariOffset(), 0);
  storedOffset = null;
  unsubscribe();
  stored = "qamari";
  await cal.initCalendarFromPref();
  assert.equal(cal.getCalendarPref(), "qamari", "reloading persisted preference restores Qamari");
  stored = "unknown";
  await cal.initCalendarFromPref();
  assert.equal(cal.getCalendarPref(), "auto");
  readFails = true;
  await cal.initCalendarFromPref();
  assert.equal(cal.getEffectiveCalendar(), "gregorian", "unreadable metadata does not crash boot");
  console.log(
    "PASS: Qamari preference, persistence reload, independent language, legacy Auto and repaint notifications",
  );
}
main()
  .finally(() => {
    for (const [filename, previous] of saved) {
      if (previous) require.cache[filename] = previous;
      else delete require.cache[filename];
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
