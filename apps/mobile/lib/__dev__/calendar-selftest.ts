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
let readFails = false;
stub("../db", {
  getAppMeta: async (key: string) => {
    assert.equal(key, "calendar_pref");
    if (readFails) throw new Error("synthetic metadata read failure");
    return stored;
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
