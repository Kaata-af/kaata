import { requireOptionalNativeModule } from "expo-modules-core";

export type NativeDeviceAuth = {
  supportsDevicePasscode(): boolean;
  authenticateWithDevicePasscode(
    requestId: string,
    reason: string,
    cancelLabel: string,
  ): Promise<unknown>;
  cancelDevicePasscode(requestId: string): Promise<void> | void;
};

/** Optional because this local iOS module is absent from Expo Go and old builds. */
export function loadDeviceAuthModule(): NativeDeviceAuth | null {
  try {
    return requireOptionalNativeModule<NativeDeviceAuth>("KaataDeviceAuth");
  } catch {
    return null;
  }
}
