// Channel-aware update routing — the single decision point for where the
// UpdateBanner and the force-update screen send the user when a new release
// is announced. Replaces the old platform-blind `apk_url || play_store_url`
// pick, which would have offered iPhones an APK and (worse) offered Play
// installs a sideload APK they structurally cannot apply: Play App Signing
// re-signs store builds, so a sideloaded APK's signature never matches a
// Play install (and vice versa) — Android refuses the update outright.
//
// Release-row conventions (app_releases; check-in already filters rows by
// the client's platform):
//   android rows → apk_url = the sideload APK (api.kaata.af/v1/download),
//                  play_store_url = the Play listing (once live).
//   ios rows     → play_store_url = the App Store listing, apk_url NULL.
//                  ("play_store_url" is historical naming — semantically it
//                  is THE PLATFORM'S STORE LISTING; shipped clients already
//                  read it as their store fallback, so reusing it needs no
//                  backend or schema change.)

import { Platform } from "react-native";

import { APP_STORE_URL, DISTRIBUTION } from "../constants/env";
import type { AppMetaUpdate } from "./types";

// The website's download page — the universal last resort (it routes every
// platform/channel by hand).
const DOWNLOAD_PAGE = "https://kaata.af/download";

/**
 * The URL this install's update action should open, or null when the
 * announced release has NO target for this install's channel — a store
 * build being told about a sideload-only release. The banner HIDES in the
 * null case (prompting a Play/App Store install to sideload is worse than
 * saying nothing; the store row lands days later and the banner appears
 * then).
 */
export function updateTargetUrl(update: AppMetaUpdate): string | null {
  if (Platform.OS === "ios") {
    // iOS has exactly one channel. The baked listing URL covers even a
    // misconfigured release row.
    return update.play_store_url || APP_STORE_URL;
  }
  if (DISTRIBUTION === "store") {
    // Play install: only the Play listing can update it.
    return update.play_store_url || null;
  }
  // Sideload install: the APK, with the store listing as a fallback (a
  // sideload CAN'T install over Play's signature, but by the time an
  // android row ships store-only, pointing people at Play is the intended
  // migration), and the download page as the never-dead-end floor.
  return update.apk_url || update.play_store_url || DOWNLOAD_PAGE;
}

/**
 * Force-update variant: the blocking screen's button must NEVER be a dead
 * end, so a channel with no target falls back to the download page instead
 * of null.
 */
export function forceUpdateTargetUrl(update: AppMetaUpdate | null): string {
  if (!update) return DOWNLOAD_PAGE;
  return updateTargetUrl(update) ?? DOWNLOAD_PAGE;
}
