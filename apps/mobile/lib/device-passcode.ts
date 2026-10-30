import { Platform } from "react-native";
import { loadDeviceAuthModule, type NativeDeviceAuth } from "../modules/kaata-device-auth";

export type DevicePasscodeResult = { success: true } | { success: false; error: string };
const failure = (error = "not_available"): DevicePasscodeResult => ({ success: false, error });
const nativeErrors = new Set([
  "app_cancel",
  "system_cancel",
  "user_cancel",
  "authentication_failed",
  "invalid_context",
  "not_available",
  "passcode_not_set",
  "lockout",
  "not_interactive",
]);
let loaded = false;
let native: NativeDeviceAuth | null = null;
type Request = {
  id: string;
  cancelled: boolean;
  started: boolean;
  promise: Promise<DevicePasscodeResult>;
};
let pending: Request | null = null;

function availableModule(): NativeDeviceAuth | null {
  if (Platform.OS !== "ios") return null;
  if (!loaded) {
    loaded = true;
    native = loadDeviceAuthModule();
  }
  try {
    return native &&
      typeof native.authenticateWithDevicePasscode === "function" &&
      typeof native.cancelDevicePasscode === "function" &&
      typeof native.supportsDevicePasscode === "function" &&
      native.supportsDevicePasscode() === true
      ? native
      : null;
  } catch {
    return null;
  }
}

/** Availability of the dedicated system-passcode route, not an authentication result. */
export function supportsDevicePasscode(): boolean {
  return availableModule() !== null;
}

/** No phone passcode enters JavaScript. Only a native protected-read outcome does. */
export function authenticateWithDevicePasscode(
  requestId: string,
  reason: string,
  cancelLabel: string,
): Promise<DevicePasscodeResult> {
  if (
    typeof requestId !== "string" ||
    !requestId.trim() ||
    requestId.length > 128 ||
    typeof reason !== "string" ||
    !reason.trim() ||
    reason.length > 2048 ||
    typeof cancelLabel !== "string" ||
    cancelLabel.length > 256
  )
    return Promise.resolve(failure("invalid_context"));
  const module = availableModule();
  if (!module) return Promise.resolve(failure());
  if (pending)
    return pending.id === requestId ? pending.promise : Promise.resolve(failure("app_cancel"));
  const job: Request = {
    id: requestId,
    cancelled: false,
    started: false,
    promise: Promise.resolve(failure()),
  };
  pending = job;
  job.promise = Promise.resolve()
    .then(async (): Promise<DevicePasscodeResult> => {
      if (job.cancelled) return failure("app_cancel");
      job.started = true;
      const result = await module.authenticateWithDevicePasscode(requestId, reason, cancelLabel);
      if (job.cancelled) return failure("app_cancel");
      if (!result || typeof result !== "object") return failure();
      const value = result as { success?: unknown; error?: unknown };
      if (value.success === true && !("error" in value)) return { success: true };
      return value.success === false &&
        typeof value.error === "string" &&
        nativeErrors.has(value.error)
        ? failure(value.error)
        : failure();
    })
    .catch(() => failure(job.cancelled ? "app_cancel" : "not_available"))
    .finally(() => {
      if (pending === job) pending = null;
    });
  return job.promise;
}

/** A late cancellation cannot invalidate a newer request with a different id. */
export async function cancelDevicePasscode(requestId: string): Promise<void> {
  const job = pending;
  if (!job || job.id !== requestId) return;
  job.cancelled = true;
  if (!job.started || !native) return;
  try {
    await native.cancelDevicePasscode(requestId);
  } catch {
    /* Never convert cancellation into authentication. */
  }
}
