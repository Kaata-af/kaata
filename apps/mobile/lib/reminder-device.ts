import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const KEY = "kaata_private_reminder_device";
const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
let pending: Promise<string> | null = null;
let cached: string | null = null;

/** Available after any reminder service read; null while SecureStore loads. */
export function getReminderDeviceIdSync(): string | null {
  return cached;
}

/** SQLite/app_meta can move to another phone through OS backup. This private
 * key stays outside that backup (Android's existing SecureStore exclusion,
 * iOS THIS_DEVICE_ONLY) so its copy cannot activate this phone's reminders.
 * A rolling local database recovery on the same phone keeps the same key. */
export function getReminderDeviceId(): Promise<string> {
  if (!pending) {
    pending = (async () => {
      const saved = await SecureStore.getItemAsync(KEY, options);
      if (saved) return (cached = saved);
      const id = Crypto.randomUUID();
      await SecureStore.setItemAsync(KEY, id, options);
      return (cached = id);
    })().catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}
