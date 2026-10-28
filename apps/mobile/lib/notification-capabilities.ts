import { getBackendUrl } from "./api";

/** An old deployment must not silently keep sending full-detail alerts. */
export async function notificationPreferencesSupported(jwt: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const base = await getBackendUrl();
    const response = await fetch(`${base}/v1/sync/capabilities`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Kaata-Currencies": "1",
        "X-Kaata-Tab-Recording": "1",
      },
    });
    if (!response.ok) throw new Error("notification_capabilities_unavailable");
    const result = (await response.json()) as { notification_preferences?: unknown };
    return result.notification_preferences === true;
  } finally {
    clearTimeout(timeout);
  }
}
