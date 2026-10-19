export type Lang = "en" | "fa" | "ps";

/** Canonical language for stored choices and browser/snapshot locale tags. */
export function languageForLocale(value: string | null | undefined): Lang | undefined {
  const primary = (value ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (primary === "ps") return "ps";
  if (primary === "fa" || primary === "prs") return "fa";
  return primary === "en" ? "en" : undefined;
}

export function isRtlLanguage(lang: Lang): boolean {
  return lang !== "en";
}

export function detectLanguage(stored: string | null, browserLanguages: readonly string[]): Lang {
  const saved = languageForLocale(stored);
  if (saved) return saved;
  for (const locale of browserLanguages) {
    const language = languageForLocale(locale);
    if (language) return language;
  }
  return "en";
}
