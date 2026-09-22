import type { ConfigContext, ExpoConfig } from "expo/config";
import { existsSync } from "node:fs";

// Firebase's client configuration is supplied locally or as an EAS file
// environment variable. Expo Go/dev without it remains fully usable.
export default ({ config }: ConfigContext): ExpoConfig => {
  const googleServices = process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json";
  return {
    ...config,
    name: config.name ?? "Kaata",
    slug: config.slug ?? "kaata",
    android: {
      ...config.android,
      ...(existsSync(googleServices) ? { googleServicesFile: googleServices } : {}),
    },
  };
};
