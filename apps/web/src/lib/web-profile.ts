import { WebApiError, webRequest } from "./web-auth";

export type WebProfile = {
  name: string;
  phone: string;
  shop_name: string;
  needs_setup: boolean;
  has_onboarded: boolean;
};

export function parseWebProfile(value: unknown): WebProfile {
  if (!value || typeof value !== "object") throw invalidProfile();
  const profile = value as Record<string, unknown>;
  if (
    ["name", "phone", "shop_name"].some((key) => typeof profile[key] !== "string") ||
    typeof profile.needs_setup !== "boolean" ||
    typeof profile.has_onboarded !== "boolean"
  )
    throw invalidProfile();
  return {
    name: profile.name as string,
    phone: profile.phone as string,
    shop_name: profile.shop_name as string,
    needs_setup: profile.needs_setup,
    has_onboarded: profile.has_onboarded,
  };
}

function invalidProfile() {
  return new WebApiError("Profile could not be loaded.", 502, "invalid_response");
}

export async function getWebProfile(signal?: AbortSignal): Promise<WebProfile> {
  return parseWebProfile(await webRequest("/v1/account/web-profile", { signal }));
}

export async function saveWebProfile(
  profile: { name: string; phone: string },
  signal?: AbortSignal,
): Promise<WebProfile> {
  return parseWebProfile(
    await webRequest("/v1/account/web-profile", {
      method: "PUT",
      body: JSON.stringify({ name: profile.name.trim(), phone: profile.phone.trim() }),
      signal,
    }),
  );
}
