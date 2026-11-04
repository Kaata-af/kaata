import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import { parseInstallReferrerSource, type InstallReferrerSource } from "./install-referrer-source";

type NativeInstallReferrer = { getInstallReferrer: (installID: string) => Promise<string | null> };

let result: InstallReferrerSource | null | undefined;
let pending: Promise<void> | undefined;
let originalInstallID: string | undefined;

async function readInstallReferrer(installID: string): Promise<void> {
  try {
    const module = requireOptionalNativeModule<NativeInstallReferrer>("KaataInstallReferrer");
    // An OTA update can run this JS on a build that predates the module.
    result = module ? parseInstallReferrerSource(await module.getInstallReferrer(installID)) : null;
  } catch {
    // Leave the result unresolved so the next foreground check-in can retry.
  }
}

export async function getInstallReferrerSource(
  installID: string,
): Promise<InstallReferrerSource | undefined> {
  if (Platform.OS !== "android") return undefined;
  originalInstallID ??= installID;
  if (originalInstallID !== installID) return undefined;
  if (result !== undefined) return result ?? undefined;
  pending ??= readInstallReferrer(installID).finally(() => {
    pending = undefined;
  });

  // The native call has its own timeout. Wait in the background check-in so
  // a slower Play service can still attribute a user's only app opening.
  await pending;
  return result ?? undefined;
}
