// Snapshot of primary product documentation reviewed on this date. A missing
// claim stays unknown; only an explicit restriction earns a "no" cell.
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
  note?: "android" | "iphone" | "googleDrive";
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

export const COMPARISON_ROWS = [
  {
    id: "offline",
    cells: {
      kaata: cell("yes", "kaataSite"),
      // ZoodHesab FAQ explicitly permits offline viewing, but not adding/editing.
      zoodhesab: cell("no", "zoodSite"),
      khatabook: cell("yes", "khataOffline"),
      // Offline PDF generation does not establish offline entry creation.
      digikhata: cell("unknown", "digiFeatures"),
      baxak: cell("yes", "baxakCopy"),
    },
  },
  {
    id: "withoutAccount",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: cell("unknown", "zoodPrivacy"),
      khatabook: cell("unknown", "khataSetup"),
      // The terms explicitly require a profile/sign-up for the service.
      digikhata: cell("no", "digiTerms"),
      baxak: cell("unknown", "baxakCopy"),
    },
  },
  {
    id: "mobileApps",
    cells: {
      kaata: cell("yes", ["kaataAndroid", "kaataIos"]),
      zoodhesab: cell("yes", ["zoodAndroid", "zoodIos"]),
      khatabook: cell("yes", ["khataAndroid", "khataIos"]),
      digikhata: cell("yes", ["digiAndroid", "digiIos"]),
      baxak: cell("yes", ["baxakAndroid", "baxakIos"]),
    },
  },
  {
    id: "pashto",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: cell("yes", "zoodAndroid", "android"),
      // iOS lists no Pashto, but Android support has not been established.
      khatabook: cell("unknown", ["khataAndroid", "khataIos"]),
      digikhata: cell("yes", "digiIos", "iphone"),
      baxak: cell("yes", "baxakCopy"),
    },
  },
  {
    id: "currencies",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: cell("unknown", "zoodSite"),
      khatabook: cell("unknown", "khataSite"),
      digikhata: cell("unknown", "digiFeatures"),
      // Customer multi-currency transactions are in the September 2026 notes.
      baxak: cell("yes", "baxakIos", "iphone"),
    },
  },
  {
    id: "staff",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: cell("unknown", "zoodSite"),
      // Multiple devices do not establish separate staff accounts or access.
      khatabook: cell("unknown", "khataSite"),
      digikhata: cell("yes", "digiSite"),
      baxak: cell("unknown", "baxakCopy"),
    },
  },
  {
    id: "approvals",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: cell("unknown", "zoodSite"),
      khatabook: cell("unknown", "khataSite"),
      digikhata: cell("unknown", "digiFeatures"),
      baxak: cell("unknown", "baxakCopy"),
    },
  },
  {
    id: "whatsapp",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: cell("unknown", "zoodAndroid"),
      khatabook: cell("yes", "khataAndroid"),
      digikhata: cell("yes", "digiSite"),
      baxak: cell("yes", "baxakCopy"),
    },
  },
  {
    id: "pdf",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: cell("yes", "zoodAndroid", "android"),
      khatabook: cell("yes", ["khataReports", "khataIos"]),
      digikhata: cell("yes", "digiFeatures"),
      baxak: cell("yes", ["baxakCopy", "baxakAndroid"]),
    },
  },
  {
    id: "backup",
    cells: {
      kaata: cell("yes", "kaataSite"),
      zoodhesab: cell("yes", "zoodSite"),
      khatabook: cell("yes", ["khataSite", "khataIos"]),
      digikhata: cell("yes", ["digiSite", "digiFeatures"]),
      baxak: cell("yes", "baxakCopy", "googleDrive"),
    },
  },
] as const satisfies readonly { id: string; cells: Record<ComparisonBrandId, ComparisonCell> }[];
