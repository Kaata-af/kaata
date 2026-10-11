import type { ConfigContext, ExpoConfig } from "expo/config";
import { existsSync } from "node:fs";
import brand from "../_shared/brand-palette.json";

// Firebase's client configuration is supplied locally or as an EAS file
// environment variable. Expo Go/dev without it remains fully usable.
export default ({ config }: ConfigContext): ExpoConfig => {
  const googleServices = process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json";
  // Native chrome consumes the same palette as JS and the website. Keep
  // provider artwork, notification masks and launcher geometry unchanged.
  const plugins = config.plugins?.map((plugin): NonNullable<ExpoConfig["plugins"]>[number] => {
    if (!Array.isArray(plugin)) return plugin;
    const [name, options] = plugin;
    // The existing splash PNG has an opaque black background. Preserve
    // its matching native background until an editable master is available.
    if (name === "expo-notifications") return [name, { ...options, color: brand.aubergine }];
    return plugin;
  });
  return {
    ...config,
    name: config.name ?? "Kaata",
    slug: config.slug ?? "kaata",
    plugins,
    android: {
      ...config.android,
      adaptiveIcon: {
        ...config.android?.adaptiveIcon,
        backgroundColor: brand.aubergine,
      },
      ...(existsSync(googleServices) ? { googleServicesFile: googleServices } : {}),
    },
  };
};
