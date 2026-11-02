// Snapshot of provider documentation and the product owner's competitor
// assessment. Keep owner-supplied checks distinct from provider citations;
// missing documentation alone never establishes that a feature is absent.
export const COMPARISON_REVIEWED_AT = "2026-11-02";

export const COMPARISON_BRANDS = [
  { id: "kaata", name: "Kaata", url: "https://kaata.af/" },
  { id: "zoodhesab", name: "ZoodHesab", url: "https://zoodhesab.com/" },
  { id: "khatabook", name: "Khatabook", url: "https://khatabook.com/en/" },
  { id: "digikhata", name: "DigiKhata", url: "https://digikhata.pk/" },
  { id: "baxak", name: "Baxak", url: "https://baxak.pamircode.com/" },
] as const;

export type ComparisonBrandId = (typeof COMPARISON_BRANDS)[number]["id"];

export const COMPARISON_SOURCES = {
  kaataSite: { brand: "kaata", kind: "website", url: "https://kaata.af/" },
  kaataAndroid: {
    brand: "kaata",
    kind: "googlePlay",
    url: "https://play.google.com/store/apps/details?id=af.kaata.app",
  },
  kaataIos: {
    brand: "kaata",
    kind: "appStore",
    url: "https://apps.apple.com/us/app/kaata/id6789651127",
  },
  zoodSite: { brand: "zoodhesab", kind: "website", url: "https://zoodhesab.com/" },
  zoodPrivacy: { brand: "zoodhesab", kind: "privacy", url: "https://zoodhesab.com/privacy" },
  zoodAndroid: {
    brand: "zoodhesab",
    kind: "googlePlay",
    url: "https://play.google.com/store/apps/details?id=com.nawidhemmati.ZoodHesab",
  },
  zoodIos: {
    brand: "zoodhesab",
    kind: "appStore",
    url: "https://apps.apple.com/us/app/zoodhesab-%D8%B2%D9%88%D8%AF%D8%AD%D8%B3%D8%A7%D8%A8/id6810098554",
  },
  khataSite: { brand: "khatabook", kind: "website", url: "https://khatabook.com/en/" },
  khataAndroid: {
    brand: "khatabook",
    kind: "googlePlay",
    url: "https://play.google.com/store/apps/details?id=com.vaibhavkalpe.android.khatabook&hl=en",
  },
  khataIos: {
    brand: "khatabook",
    kind: "appStore",
    url: "https://apps.apple.com/in/app/khatabook-vyapar-app/id1488204139",
  },
  khataReports: {
    brand: "khatabook",
    kind: "help",
    url: "https://khatabook.com/help/en-us/category/X1Uq1BAAAGYIXK0-/",
  },
  khataOffline: {
    brand: "khatabook",
    kind: "featureGuide",
    url: "https://khatabook.com/blog/mr/5-Tools-to-use-in-2025/",
  },
  khataSetup: {
    brand: "khatabook",
    kind: "featureGuide",
    url: "https://khatabook.com/blog/khatabook-app-features/",
  },
  digiSite: { brand: "digikhata", kind: "website", url: "https://digikhata.pk/" },
  digiFeatures: { brand: "digikhata", kind: "features", url: "https://digikhata.pk/features" },
  digiTerms: { brand: "digikhata", kind: "terms", url: "https://digikhata.pk/terms-of-services" },
  digiAndroid: {
    brand: "digikhata",
    kind: "googlePlay",
    url: "https://play.google.com/store/apps/details?id=com.androidapp.digikhata&hl=en&gl=PK",
  },
  digiIos: {
    brand: "digikhata",
    kind: "appStore",
    url: "https://apps.apple.com/gb/app/digikhata-business-accounting/id1571599845",
  },
  baxakSite: { brand: "baxak", kind: "website", url: "https://baxak.pamircode.com/" },
  baxakCopy: {
    brand: "baxak",
    kind: "publishedCopy",
    url: "https://baxak.pamircode.com/assets/locales/en.json",
  },
  baxakAndroid: {
    brand: "baxak",
    kind: "googlePlay",
    url: "https://play.google.com/store/apps/details?id=com.walizada.baxak",
  },
  baxakIos: {
    brand: "baxak",
    kind: "appStore",
    url: "https://apps.apple.com/us/app/baxak/id6759287628",
  },
} as const;

export type ComparisonSourceId = keyof typeof COMPARISON_SOURCES;
export type ComparisonStatus = "yes" | "no" | "unknown";
export type ComparisonCell = {
  status: ComparisonStatus;
  sources: readonly ComparisonSourceId[];
  note?: "android" | "iphone" | "googleDrive" | "paid" | "freemium" | "iphoneFreemium";
  assessment?: "kaata";
};

const cell = (
  status: ComparisonStatus,
  sources: ComparisonSourceId | readonly ComparisonSourceId[],
  note?: ComparisonCell["note"],
): ComparisonCell => ({
  status,
  sources: typeof sources === "string" ? [sources] : sources,
  ...(note ? { note } : {}),
});

// Confirmed competitor checks supplied by Kaata's product owner. These use
// their own visible assessment marker, rather than implying that an official
// page explicitly documents the absence of a feature.
const assessedCell = (status: ComparisonStatus, note?: ComparisonCell["note"]): ComparisonCell => ({
  status,
  sources: [],
  assessment: "kaata",
  ...(note ? { note } : {}),
});

export const COMPARISON_ROWS = [
  {
    id: "staff",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: assessedCell("no"),
      khatabook: assessedCell("yes"),
      digikhata: cell("yes", "digiSite"),
      baxak: assessedCell("no"),
    },
  },
  {
    id: "shared",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: assessedCell("no"),
      khatabook: assessedCell("no"),
      digikhata: assessedCell("no"),
      baxak: assessedCell("no"),
    },
  },
  {
    id: "withoutAccount",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: assessedCell("no"),
      khatabook: assessedCell("no"),
      digikhata: cell("no", "digiTerms"),
      baxak: assessedCell("no"),
    },
  },
  {
    id: "freeNoTrial",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: assessedCell("no", "paid"),
      khatabook: assessedCell("no", "freemium"),
      // The iPhone app lists recurring subscription purchases.
      digikhata: cell("no", "digiIos", "iphoneFreemium"),
      // Published pricing caps the free plan and offers paid Premium features.
      baxak: cell("no", "baxakCopy", "freemium"),
    },
  },
  {
    id: "csv",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: assessedCell("no"),
      khatabook: assessedCell("no"),
      digikhata: assessedCell("no"),
      baxak: assessedCell("no"),
    },
  },
] as const satisfies readonly { id: string; cells: Record<ComparisonBrandId, ComparisonCell> }[];
