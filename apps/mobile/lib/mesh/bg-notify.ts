// apps/mobile/lib/mesh/bg-notify.ts
//
// #46 — per-sync notification. When a SYNCED (remote-origin) ledger event is
// applied while the app is NOT in the foreground, post a local notification so
// the shopkeeper knows new entries arrived — without opening the app.
//
// Originally written for the Briar-style nearby-phone mesh; with the mesh
// parked, the live producer is CLOUD sync — lib/sync pulls events and applies
// them through lib/projection with origin "remote", which is what fires
// onLedgerApplied here. It is what a shopkeeper with a second device sees.
//
// Uses expo-notifications. It previously used @notifee/react-native, which was
// ARCHIVED in April 2026 (9.1.8 is the final release that will ever exist) and
// is a legacy-bridge module: its Android headless path calls
// ReactApplication.getReactNativeHost(), which React Native 0.83 makes throw and
// which Expo SDK 55's MainApplication no longer overrides. expo-notifications
// was already a dependency and already configured in app.json, so this cost one
// call site to remove an entire dead-upstream native dependency.
//
// Subscribes at module load (imported from index.js after the polyfills) so the
// subscription exists in BOTH the foreground VM (when backgrounded) and the
// headless VM. The onLedgerApplied listener set is per-VM; whichever VM applied
// the synced event fires its own listener.
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";

import { getAppMeta } from "../db";
import { getDb } from "../db-tx";
import { onLedgerApplied } from "../ledger-events";

const CHANNEL_ID = "ledger-updates";
// Coalesce a sync batch (and a burst of vaults) into one notification.
const DEBOUNCE_MS = 3000;

let channelReady = false;
const pendingVaults = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureChannel(): Promise<void> {
  if (channelReady) return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "Synced updates",
    importance: Notifications.AndroidImportance.DEFAULT,
    description: "New entries synced from your account while Kaata was in the background.",
  });
  channelReady = true;
}

async function shopName(vaultId: string): Promise<string | null> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ shop_name: string }>(
      "SELECT shop_name FROM shop_profile WHERE vault_id = ? LIMIT 1",
      vaultId,
    );
    return row?.shop_name?.trim() || null;
  } catch {
    return null;
  }
}

async function flush(): Promise<void> {
  flushTimer = null;
  const vaults = Array.from(pendingVaults);
  pendingVaults.clear();
  if (vaults.length === 0) return;
  // Opt-out (default ON). Lets the user silence it from Settings later without a
  // build, and the channel is user-mutable in the OS too.
  if ((await getAppMeta("bg_notify_enabled")) === "0") return;

  try {
    await ensureChannel();
  } catch {
    return;
  }

  let title = "New entries synced";
  let body = "Tap to open Kaata";
  if (vaults.length === 1) {
    const name = await shopName(vaults[0]);
    if (name) {
      title = name;
      body = "New entries synced — tap to open";
    }
  }

  try {
    // trigger is the CHANNEL-AWARE form, not null. Both deliver immediately, but
    // `null` drops the notification onto expo-notifications' auto-created
    // "Miscellaneous" fallback channel — so the user's mute/importance settings
    // for "Synced updates" would silently not apply to it.
    //
    // The small icon and accent colour come from the expo-notifications config
    // plugin in app.json; there is no per-notification icon option.
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: { channelId: CHANNEL_ID },
    });
  } catch (err) {
    if (__DEV__) console.warn("[bg-notify] scheduleNotificationAsync failed", err);
  }
}

if (Platform.OS === "android") {
  onLedgerApplied((vaultId, origin) => {
    // Only SYNCED entries (not the user's own local writes), and only when the
    // user isn't actively looking at the app. In the headless VM AppState is
    // always "background", so it correctly fires there too.
    if (origin !== "remote") return;
    if ((AppState.currentState as string) === "active") return;
    pendingVaults.add(vaultId);
    if (flushTimer == null) flushTimer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });
}
