export type InstallReferrerSource = "facebook_ads" | "organic_posts" | "bill_share";

function isInstallReferrerSource(value: string): value is InstallReferrerSource {
  return value === "facebook_ads" || value === "organic_posts" || value === "bill_share";
}

// Only a known campaign slug crosses the check-in boundary. In particular, a
// Facebook click ID or a generic Play organic referrer is not campaign evidence.
export function parseInstallReferrerSource(raw: string | null): InstallReferrerSource | null {
  if (!raw || raw.length > 4096) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    // React Native's parser throws for malformed percent-encoded values.
    return null;
  }
  const sources = params.getAll("kaata_source");
  if (sources.length) {
    const source = sources[0];
    return sources.length === 1 && isInstallReferrerSource(source) ? source : null;
  }

  const utmSources = params.getAll("utm_source");
  const utmMedia = params.getAll("utm_medium");
  if (utmSources.length !== 1 || utmMedia.length !== 1) return null;
  const source = utmSources[0]?.toLowerCase() ?? "";
  const medium = utmMedia[0]?.toLowerCase() ?? "";
  if (
    ["facebook", "fb", "meta"].includes(source) &&
    ["paid_social", "paidsocial", "paid-social", "paid", "cpc", "cpm", "ppc", "ads"].includes(
      medium,
    )
  ) {
    return "facebook_ads";
  }
  if (
    ["facebook", "fb", "instagram", "tiktok", "youtube", "social"].includes(source) &&
    ["organic_social", "organic-social", "organic", "social"].includes(medium)
  ) {
    return "organic_posts";
  }
  return null;
}
