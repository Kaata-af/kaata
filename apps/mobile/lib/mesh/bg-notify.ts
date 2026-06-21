// apps/mobile/lib/mesh/bg-notify.ts
//
// #46 — Briar-style per-sync notification. When a SYNCED (remote-origin) ledger
// event is applied while the app is NOT in the foreground (backgrounded, or in the
// headless background-sync context), post a local notification so the shopkeeper
// knows new entries arrived from a nearby phone — without opening the app.
//
// Subscribes at module load (imported from index.js after the polyfills) so the
// subscription exists in BOTH the foreground VM (when backgrounded) and the
// headless VM. The onLedgerApplied listener set is per-VM; whichever VM applied
// the synced event fires its own listener.
import { AppState, Platform } from "react-native";

import { getAppMeta } from "../db";
import { IS_EXPO_GO } from "../expo-go";
import { getDb } from "../db-tx";
import { onLedgerApplied } from "../ledger-events";

const CHANNEL_ID = "ledger-updates";
// Coalesce a sync batch (and a burst of vaults) into one notification.
const DEBOUNCE_MS = 3000;

let channelReady = false;
const pendingVaults = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// require (not import) so Metro doesn't resolve notifee for web — matches
// foreground.ts / foreground-bootstrap.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNotifee(): any | null {
  // Expo Go lacks the notifee native module — require() throws at load and
  // surfaces in LogBox. Skip there; callers already null-check.
  if (IS_EXPO_GO) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@notifee/react-native");
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureChannel(notifee: any): Promise<void> {
  if (channelReady) return;
  await notifee.default.createChannel({
    id: CHANNEL_ID,
    name: "Synced updates",
    importance: notifee.AndroidImportance.DEFAULT,
    description: "New entries synced from a nearby phone while Kaata was in the background.",
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

  const notifee = getNotifee();
  if (notifee == null) return;
  try {
    await ensureChannel(notifee);
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
    await notifee.default.displayNotification({
      title,
      body,
      android: {
        channelId: CHANNEL_ID,
        pressAction: { id: "default" },
        smallIcon: "notification_icon",
      },
    });
  } catch (err) {
    if (__DEV__) console.warn("[bg-notify] displayNotification failed", err);
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
