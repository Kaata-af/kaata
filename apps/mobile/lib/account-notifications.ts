import { getBackendUrl } from "./api";
import { applyForCurrentSession, type SessionSnapshot } from "./auth";
import { getInstallIdSync } from "./db-tx";
import type { NotificationPolicy } from "./notification-policy";
import { TabApiError } from "./tabs/errors";

/** Separate from shared-tally registration: even an account with no contacts
 * needs incoming friendship/member invitations. */
export async function registerAccountNotifications(
  session: SessionSnapshot,
  token: string,
  locale: string,
  preferences?: NotificationPolicy,
  signal?: AbortSignal,
): Promise<{ enabled: boolean }> {
  await applyForCurrentSession(session, async () => {});
  const base = await getBackendUrl();
  await applyForCurrentSession(session, async () => {});
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 10_000);
  // Credit-alert delivery has its own subscription; this endpoint shares the
  // strict connection/tally policy schema rather than the device-only shape.
  const wirePreferences = preferences ? { ...preferences } : undefined;
  if (wirePreferences) delete (wirePreferences as Partial<NotificationPolicy>).credit_alerts;
  try {
    const response = await fetch(`${base}/v1/notifications/registration`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        install_id: getInstallIdSync(),
        token,
        locale,
        ...(wirePreferences ? { preferences: wirePreferences } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok)
      throw new TabApiError(
        response.status,
        "notification_registration",
        "Notification registration failed",
      );
    const result = await response.json();
    return applyForCurrentSession(session, async () => ({ enabled: result.enabled === true }));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
