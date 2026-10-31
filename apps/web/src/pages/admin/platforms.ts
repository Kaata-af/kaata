// Account platform sets are additive. Older servers only send the latest
// installation's platform, so retain that value during independent rollouts.
export function accountPlatforms(platforms?: readonly string[], latest?: string): string[] {
  const values = [...(Array.isArray(platforms) ? platforms : []), latest];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value && value !== "__unknown__" && value !== "unknown"),
    ),
  ].sort();
}

export function platformLabel(platform: string): string {
  const value = (platform || "").trim().toLowerCase();
  if (value === "ios") return "iOS";
  if (value === "android") return "Android";
  if (value === "web") return "Web";
  return value && value !== "__unknown__" && value !== "unknown" ? platform.trim() : "Unknown";
}

export function platformsLabel(platforms?: readonly string[], latest?: string): string {
  const values = accountPlatforms(platforms, latest);
  return values.length ? values.map(platformLabel).join(" · ") : "Unknown";
}

export function platformFacets(platforms: readonly string[]): readonly string[] {
  return platforms.length ? platforms : ["__unknown__"];
}
