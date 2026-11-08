import { getLocale, type LocaleCode } from "./i18n";

const en = {
  format: "File format",
  pdf: "PDF",
  csv: "Spreadsheet (CSV)",
  pdfHint: "A clear statement to share or print.",
  csvHint: "Rows you can open and work with in a spreadsheet.",
  period: "Period",
  all: "All time",
  month: "This month",
  lastMonth: "Last month",
  custom: "Choose dates",
  from: "From",
  through: "Through",
  more: "More options",
  detailed: "Detailed record",
  detailedHint: "Include shared-tally receipts and earlier account history.",
  detailedReportHint: "Include the transaction journal and shared-tally receipts.",
  includeNotes: "Include internal notes",
  notesHint:
    "Customer descriptions and internal notes will be visible to the recipient. They never change balances.",
  beforeSharedOpening:
    "These dates start before a current shared period. Choose later dates, or use “{all}” with “{detailed}” to include earlier history.",
  selectedOptions: "{count} selected",
  invalidDates: "The end date must be on or after the start date.",
  allCurrencies:
    "Each currency is kept separate. Screen search and filters do not limit this export.",
  reportScope:
    "Balances are shown at the end of the selected period, with each currency kept separate.",
  openingBalance: "Opening balance",
  closingBalance: "Closing balance",
  noteNumber: "Note number (not money)",
  recordType: "Record type",
  internalNote: "Internal note",
  customerDetails: "Customer description",
  statementScope: "Statement period",
  periodGave: "Given in period",
  periodReceived: "Received in period",
  opening: "Opening",
  tally: "Tally",
  note: "Note",
  settlement: "Settlement",
  status: "Status",
} as const;

type CopyKey = keyof typeof en;
const COPY: Record<LocaleCode, Record<CopyKey, string>> = {
  en,
  fa: {
    format: "نوع فایل",
    pdf: "PDF",
    csv: "جدول (CSV)",
    pdfHint: "صورت‌حساب خوانا برای فرستادن یا چاپ.",
    csvHint: "ردیف‌هایی که می‌توانید در برنامهٔ جدول باز و بررسی کنید.",
    period: "دوره",
    all: "همهٔ زمان‌ها",
    month: "این ماه",
    lastMonth: "ماه گذشته",
    custom: "انتخاب تاریخ",
    from: "از",
    through: "تا",
    more: "گزینه‌های بیشتر",
    detailed: "سابقهٔ مفصل",
    detailedHint: "رسیدهای ثبت مشترک و سابقهٔ قبلی حساب را هم شامل کن.",
    detailedReportHint: "دفتر ثبت معاملات و رسیدهای ثبت مشترک را هم شامل کن.",
    includeNotes: "شامل کردن یادداشت‌های داخلی",
    notesHint:
      "توضیحات مشتری و یادداشت‌های داخلی برای گیرنده قابل دیدن می‌شوند. آن‌ها بیلانس را تغییر نمی‌دهند.",
    beforeSharedOpening:
      "این تاریخ‌ها پیش از دورهٔ مشترک فعلی آغاز می‌شوند. تاریخ‌های بعدی را انتخاب کنید، یا برای سابقهٔ قبلی «{all}» و «{detailed}» را انتخاب کنید.",
    selectedOptions: "{count} انتخاب شده",
    invalidDates: "تاریخ پایان باید همان روز آغاز یا پس از آن باشد.",
    allCurrencies: "هر واحد پول جدا می‌ماند. جستجو و فیلترهای صفحه این خروجی را محدود نمی‌کنند.",
    reportScope: "بیلانس‌ها در پایان دورهٔ انتخاب‌شده نشان داده می‌شوند و هر واحد پول جدا می‌ماند.",
    openingBalance: "بیلانس آغاز",
    closingBalance: "بیلانس پایان",
    noteNumber: "عدد یادداشت (غیرپولی)",
    recordType: "نوع ثبت",
    internalNote: "یادداشت داخلی",
    customerDetails: "توضیحات مشتری",
    statementScope: "دورهٔ صورت‌حساب",
    periodGave: "داده‌شده در این دوره",
    periodReceived: "گرفته‌شده در این دوره",
    opening: "آغاز",
    tally: "ثبت",
    note: "یادداشت",
    settlement: "تصفیه",
    status: "وضعیت",
  },
  ps: {
    format: "د فایل بڼه",
    pdf: "PDF",
    csv: "جدول (CSV)",
    pdfHint: "د لېږلو یا چاپ لپاره روښانه حساب‌پاڼه.",
    csvHint: "هغه کتارونه چې د جدول په پروګرام کې یې پرانیستل او کتلای شئ.",
    period: "موده",
    all: "ټول وخت",
    month: "دا میاشت",
    lastMonth: "تېره میاشت",
    custom: "نېټې وټاکئ",
    from: "له",
    through: "تر",
    more: "نور غوراوي",
    detailed: "بشپړ ریکارډ",
    detailedHint: "د ګډو ثبتونو رسیدونه او د حساب پخوانی تاریخ هم شامل کړئ.",
    detailedReportHint: "د راکړې ورکړې بشپړ لړلیک او د ګډو ثبتونو رسیدونه هم شامل کړئ.",
    includeNotes: "داخلي یادښتونه شامل کړئ",
    notesHint:
      "د پېرودونکي توضیحات او داخلي یادښتونه به ترلاسه کوونکي ته ښکاره شي. دا بیلانس نه بدلوي.",
    beforeSharedOpening:
      "دا نېټې له اوسنۍ ګډې دورې مخکې پیلېږي. وروسته نېټې وټاکئ، یا د پخواني تاریخ لپاره «{all}» او «{detailed}» غوره کړئ.",
    selectedOptions: "{count} ټاکل شوي",
    invalidDates: "د پای نېټه باید د پیل په ورځ یا تر هغې وروسته وي.",
    allCurrencies: "هر ډول اسعار جلا ساتل کېږي. د پاڼې لټون او فلټرونه دا فایل نه محدودوي.",
    reportScope: "بیلانسونه د ټاکل شوې مودې په پای کې ښودل کېږي او هر ډول اسعار جلا ساتل کېږي.",
    openingBalance: "د پیل بیلانس",
    closingBalance: "د پای بیلانس",
    noteNumber: "د یادښت شمېره (پیسې نه دي)",
    recordType: "د ثبت ډول",
    internalNote: "داخلي یادښت",
    customerDetails: "د پېرودونکي توضیحات",
    statementScope: "د حساب‌پاڼې موده",
    periodGave: "په موده کې ورکړل شوي",
    periodReceived: "په موده کې ترلاسه شوي",
    opening: "پیل",
    tally: "ثبت",
    note: "یادښت",
    settlement: "تصفیه",
    status: "حالت",
  },
};

export type ExportCopyKey = CopyKey;
export function tExportIn(
  locale: LocaleCode,
  key: CopyKey,
  vars?: Record<string, string | number>,
): string {
  let text = COPY[locale][key];
  for (const [name, value] of Object.entries(vars ?? {}))
    text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

export function tExport(key: CopyKey, vars?: Record<string, string | number>): string {
  return tExportIn(getLocale(), key, vars);
}
