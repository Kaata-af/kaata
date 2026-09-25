// Store-only update destinations. Historical check-in rows remain readable,
// but their download URLs must never route an installed app outside its store.
import { Platform } from "react-native";
import { APP_STORE_URL, PLAY_STORE_URL } from "../constants/env";
import type { AppMetaUpdate } from "./types";

const DOWNLOAD_PAGE = "https://kaata.af/download";

export function updateTargetUrl(_update: AppMetaUpdate | null): string {
  if (Platform.OS === "ios") return APP_STORE_URL;
  if (Platform.OS === "android") return PLAY_STORE_URL;
  return DOWNLOAD_PAGE;
}

export function forceUpdateTargetUrl(update: AppMetaUpdate | null): string {
  return updateTargetUrl(update);
}
