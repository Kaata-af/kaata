import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileUI } from "./ui-fixture";
import { formatCalendarDate } from "../jalali";
import { compareCustomerNames } from "../customer-list";
import { filterTallies, noteSearchTerms } from "../tally-search";
import { formatMoneyAmount, parseAmountInput } from "../money";
import type { LocaleCode } from "../i18n";

// Execute the real locale-sensitive utilities with synthetic native/storage
// boundaries. No customer data, persisted preferences or network are used.
let locale: LocaleCode = "fa";
const listeners = new Set<() => void>();
let repaintCount = 0;
const i18n = {
  getLocale: () => locale,
  subscribeLocale: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  t: (key: string, vars?: Record<string, unknown>) =>
    key === "format.am" ? "غ.م" : key === "format.pm" ? "غ.و" : JSON.stringify({ key, ...vars }),
};
const direction = compileUI("../direction", {
  "./i18n": i18n,
  "./bidi": require("../bidi"),
  react: {
    useState: (initial: unknown) => {
      let state = typeof initial === "function" ? initial() : initial;
      return [
        state,
        (value: any) => {
          const next = typeof value === "function" ? value(state) : value;
          if (!Object.is(state, next)) repaintCount++;
          state = next;
        },
      ];
    },
    useEffect: (effect: () => unknown) => effect(),
  },
});
assert.equal(direction.useIsRTL(), true);
locale = "ps";
for (const listener of listeners) listener();
assert.equal(repaintCount, 1, "Dari → Pashto must repaint even though both use RTL");
assert.equal(direction.getDirection(), "rtl");
locale = "en";
assert.equal(direction.getDirection(), "ltr");

const phone = compileUI("../phone", {
  "./db": {},
  "./digits": require("../digits"),
});
assert.equal(phone.getCountryName("DE", "ps"), "جرمني");
assert.equal(phone.getCountryName("DE", "fa"), "آلمان");
assert.equal(phone.getCountryName("DE", "en"), "Germany");
assert.equal(phone.normalizePhone("۰۷۰۰۱۲۳۴۵۶", "AF"), "+93700123456");

const currency = compileUI("../currency", {
  react: {},
  "./currency-scope": require("../currency-scope"),
  "./currency-settings": require("../currency-settings"),
  "./db": {},
  "./db-tx": {},
  "./i18n": i18n,
});
locale = "ps";
assert.equal(currency.getCurrencyName("AFN"), "افغانۍ");
assert.equal(currency.getCurrencyName("USD"), "امریکایي ډالر");
assert.equal(currency.getCurrencySymbol("AFN"), "؋");

const instant = new Date(2026, 2, 21, 15, 5).getTime();
assert.equal(formatCalendarDate(instant, "ps", "jalali"), "۱ وری ۱۴۰۵");
assert.equal(formatCalendarDate(instant, "ps", "gregorian"), "۲۱ مارچ ۲۰۲۶");
assert.equal(
  formatCalendarDate(new Date(2026, 7, 5, 12).getTime(), "ps", "qamari", 0),
  "۲۰ صفر ۱۴۴۸",
);
assert.equal(formatCalendarDate(instant, "fa", "jalali"), "۱ حمل ۱۴۰۵");
assert.equal(formatCalendarDate(instant, "en", "jalali"), "1 Hamal 1405");
assert.equal(formatCalendarDate(NaN, "ps", "jalali"), "");

const format = compileUI("../format", {
  "./calendar": { getEffectiveCalendar: () => "jalali" },
  "./currency": currency,
  "./i18n": i18n,
  "./jalali": require("../jalali"),
  "./money": require("../money"),
});
assert.equal(format.formatTimestamp(instant), "⁨۱ وری ۱۴۰۵⁩، ⁨۳:۰۵ غ.و⁩");
const reminder = compileUI("../reminder-format", {
  "./i18n": i18n,
  "./format": format,
  "./jalali": require("../jalali"),
});
assert.equal(reminder.reminderWeekday(0), "يونۍ", "Pashto ICU weekday, independently of Dari");
assert.equal(reminder.reminderClock(15, 5), "۳:۰۵ غ.و");
assert.equal(reminder.reminderMonthlyDate(instant), "۲۱ مارچ");
assert.ok(reminder.reminderMonthCount(2).includes("۲"));

assert.equal(formatMoneyAmount(1234.5), "1,234.50", "financial amounts retain ASCII digits");
assert.equal(
  parseAmountInput("۱۲۳۴٫۵"),
  1234.5,
  "localized input still normalizes before arithmetic",
);
assert.ok(compareCustomerNames("رحمت ۲", "رحمت ۱۰", "ps") < 0);
assert.ok(compareCustomerNames("رحمت 2", "رحمت ۱۰", "ps") < 0);
const tally = { note: "غنم", amount_afn: 500, created_at: instant };
assert.deepEqual(
  filterTallies([tally], noteSearchTerms("۵۰۰ افغانۍ"), { locale: "ps", calendar: "jalali" }),
  [tally],
);
assert.deepEqual(filterTallies([tally], noteSearchTerms("غنم")), [tally]);

const config = JSON.parse(readFileSync(resolve(__dirname, "../../app.json"), "utf8")).expo;
for (const lang of ["en", "fa", "ps"]) {
  const strings = JSON.parse(
    readFileSync(resolve(__dirname, "../..", config.locales[lang]), "utf8"),
  );
  assert.ok(strings.ios.NSContactsUsageDescription.length > 30);
  assert.ok(strings.ios.NSCameraUsageDescription.length > 30);
}
assert.deepEqual(
  config.plugins.find(
    (plugin: any) => Array.isArray(plugin) && plugin[0] === "expo-localization",
  )[1].supportedLocales,
  ["en", "fa", "ps"],
);
async function verifyExport() {
  const language = compileUI("../i18n", {
    "expo-localization": { getLocales: () => [{ languageCode: "ps" }] },
    "./db": { getAppMeta: async () => null },
  });
  const extra = compileUI("../mobile-copy", { "./i18n": language });
  const note = compileUI("../export/note", { "../i18n": language });
  const evidence = compileUI("../export/evidence", { "../i18n": language });
  let html = "";
  let moved = false;
  class PrintFile {
    constructor(public uri: string) {}
    async move(target: PrintFile) {
      await Promise.resolve();
      moved = true;
      this.uri = target.uri;
    }
  }
  const pdf = compileUI("../export/pdf", {
    "expo-asset": {
      Asset: {
        fromModule: () => {
          throw new Error("synthetic unavailable font asset");
        },
      },
    },
    "expo-file-system": { File: PrintFile },
    "expo-print": {
      printToFileAsync: async (args: { html: string }) => {
        html = args.html;
        return { uri: "synthetic-printed.pdf" };
      },
    },
    "@expo-google-fonts/vazirmatn": { Vazirmatn_400Regular: 1, Vazirmatn_700Bold: 2 },
    "../colors": require("../colors"),
    "../format": format,
    "../i18n": language,
    "../mobile-copy": extra,
    "./note": note,
    "./evidence": evidence,
    "../jalali": require("../jalali"),
    "../money": require("../money"),
    "./data": { exportFileTarget: () => new PrintFile("synthetic-target.pdf") },
    "./shared-record": require("../export/shared-record"),
  });
  const file = await pdf.renderPersonStatementPdf(
    {
      locale: "ps",
      calendar: "jalali",
      currencyCode: "AFN",
      currencySymbol: "؋",
      self: { name: "احمد", shop_name: "زما دوکان" },
      person: { name: "رحمت", phone: "+93700123456" },
      rows: [
        {
          kind: "entry",
          entry: {
            id: "entry-1",
            type: "debt",
            amount_afn: 1234.5,
            note: "غنم",
            created_at: instant,
          },
          balanceAfter: 1234.5,
        },
      ],
      balance: 1234.5,
      generatedAtMs: instant,
    },
    "synthetic-statement.pdf",
  );
  assert.equal(moved, true, "Expo async file move completes before sharing the PDF");
  assert.equal(file.uri, "synthetic-target.pdf");
  assert.match(html, /<html dir="rtl" lang="ps">/);
  assert.ok(html.includes(language.tIn("ps", "export.doc.statementTitle")));
  assert.ok(html.includes("۱ وری ۱۴۰۵"));
  assert.ok(html.includes("1,234.50"), "amount cells keep ASCII digits in an RTL export");
  assert.ok(html.includes("د کاټه په مرسته — kaata.af"));
  assert.ok(!html.includes("undefined"));
  console.log(
    "PASS: Pashto direction and Dari→Pashto repaint, month/date/clock/weekday/currency/country labels, input/search/sort, ASCII amounts, native permission config and real RTL PDF HTML export",
  );
}
void verifyExport().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
