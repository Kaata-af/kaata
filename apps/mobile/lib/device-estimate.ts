import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { IS_EXPO_GO } from "./expo-go";

export type DeviceEstimate = {
  device_id_hash: string;
  device_id_kind: "android_id" | "ios_idfv";
};

// This is optional analytics: a slow native call must not hold up check-in.
const LOOKUP_TIMEOUT_MS = 500;

function normalizeId(kind: DeviceEstimate["device_id_kind"], value: unknown): string | null {
  if (typeof value !== "string") return null;
  let id = value.trim().toLowerCase();
  if (kind === "android_id") {
    if (!/^[0-9a-f]{1,16}$/.test(id)) return null;
    // Android 7 generates this 64-bit value via Long.toHexString, which drops
    // leading zeroes. Canonicalize so padded and unpadded forms hash alike.
    id = id.padStart(16, "0");
    // Old Android builds sometimes returned this shared ID; placeholders must
    // never merge otherwise unrelated phones into one estimated device.
    if (["0000000000000000", "ffffffffffffffff", "9774d56d682e549c"].includes(id)) return null;
  } else {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
    if (id === "00000000-0000-0000-0000-000000000000") return null;
  }
  return id;
}

async function readDeviceEstimate(): Promise<DeviceEstimate | null> {
  if (IS_EXPO_GO || (Platform.OS !== "android" && Platform.OS !== "ios")) return null;
  const kind = Platform.OS === "android" ? "android_id" : "ios_idfv";
  const raw =
    kind === "android_id" ? Application.getAndroidId() : await Application.getIosIdForVendorAsync();
  const id = normalizeId(kind, raw);
  if (!id) return null;
  // Domain separation prevents this digest being reused as another identifier.
  // Raw OS IDs are neither stored nor sent; installation history stays separate.
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `kaata-device:v1:${kind}:${id}`,
  );
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  return { device_id_kind: kind, device_id_hash: hash };
}

export async function getDeviceEstimate(): Promise<DeviceEstimate | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readDeviceEstimate(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // iOS can return no ID before the first unlock after reboot. Native access
    // or hashing can also fail. Do not cache failure: the next check-in retries.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
