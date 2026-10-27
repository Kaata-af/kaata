import type { ConfigContext, ExpoConfig } from "expo/config";
import { existsSync } from "node:fs";

// Firebase's client configuration is supplied locally or as an EAS file
// environment variable. Expo Go/dev without it remains fully usable.
export default ({ config }: ConfigContext): ExpoConfig => {
  const googleServices = process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json";
  // Native app branding is black and white, independent of the marketing
  // palette. app.json matches the restored opaque black splash asset and
  // keeps the notification accent black; provider artwork/masks stay intact.
  const plugins = [...(config.plugins ?? [])];
  if (
    !plugins.some(
      (plugin) =>
        (Array.isArray(plugin) ? plugin[0] : plugin) === "@react-native-community/datetimepicker",
    )
  ) {
    plugins.push("@react-native-community/datetimepicker");
  }
  return {
    ...config,
    name: config.name ?? "Kaata",
    slug: config.slug ?? "kaata",
    plugins,
    // SDK 58 defaults this fallback on. Windows uses the watched file map so
    // HMR reuses eagerly computed metadata instead of reading files on demand.
    experiments: {
      ...config.experiments,
      ...(process.platform === "win32" ? { onDemandFilesystem: false } : {}),
    },
    android: {
      ...config.android,
      adaptiveIcon: {
        ...config.android?.adaptiveIcon,
        backgroundColor: "#000000",
      },
      ...(existsSync(googleServices) ? { googleServicesFile: googleServices } : {}),
    },
  };
};
