import * as Crypto from "expo-crypto";
import { getAppMeta, setAppMeta } from "./db";
import { getDb } from "./db-tx";

// On a brand-new install the first time the app cold-starts, we mint the
// install_id AND record the wall-clock install timestamp from the device.
// Both go into app_meta and persist forever. We capture installed_at here
// (not server-side on first check-in) because the install can be offline
// for hours or days before its first check-in — and "when did this APK
// first run" is information that's only knowable at this moment.
//
// The device clock is the source of truth. Backend clamps to NOW() on
// receipt to defend against future-dated timestamps from a wrong clock.
//
// Called from app/_layout.tsx BEFORE initDb()'s migration phase runs, so
// that migration 006 (synthetic backfill) can stamp install_id as hlc.did
// on every backfilled event. To make that boot order legal, we bootstrap
// the app_meta table here ourselves — initDb's CREATE TABLE IF NOT EXISTS
// will be a no-op when it runs next.
export async function ensureInstallId(): Promise<string> {
  const db = await getDb();
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const existing = await getAppMeta("install_id");
  if (existing) return existing;
  const id = Crypto.randomUUID();
  const installedAt = Date.now();
  await setAppMeta("install_id", id);
  await setAppMeta("installed_at_unix_ms", String(installedAt));
  return id;
}

export async function getInstalledAtUnixMs(): Promise<number | null> {
  const raw = await getAppMeta("installed_at_unix_ms");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "1" once the server has answered 410 for THIS install_id: an account the
// phone was signed in to has been deleted, and check-in plus every sign-in are
// refused for this id from then on (see InstallRetiredError in lib/auth.ts).
// app/account.tsx shows the reset notice while it is set. Two things remove
// it: resetRetiredInstall, which drops app_meta along with every other table,
// and clearInstallRetired, once a later check-in or sign-in for the same id
// succeeds.
export const INSTALL_RETIRED_KEY = "install_retired";

// Records a 410 for `installId`, but only while it is still this phone's
// install_id. A reset that minted a fresh id while the request was in flight
// must not inherit the old id's verdict, so the check and the write are ONE
// statement instead of a read followed by a write that a reset can slip between.
export async function markInstallRetired(installId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO app_meta (key, value)
       SELECT ?, '1'
        WHERE EXISTS (SELECT 1 FROM app_meta WHERE key = 'install_id' AND value = ?)`,
    INSTALL_RETIRED_KEY,
    installId,
  );
}

// Forgets a recorded 410 once a check-in or sign-in for `installId` has
// SUCCEEDED. The server never accepts a retired id, so that 410 came from
// something else on the way (a proxy, a captive portal, a parked domain after
// a backend-URL move), and without this the notice would stay forever.
//
// The same one-statement id check as markInstallRetired, for the mirror-image
// reason: a success for an id that a reset has since replaced says nothing
// about the fresh id, so it must not erase a 410 recorded for that fresh id.
// Within one id the flag follows whichever answer is handled last. A success
// and a 410 for the same id that cross on the network can leave the wrong
// value, and the next check-in (every launch and foreground) puts it right.
export async function clearInstallRetired(installId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `DELETE FROM app_meta
      WHERE key = ?
        AND EXISTS (SELECT 1 FROM app_meta WHERE key = 'install_id' AND value = ?)`,
    INSTALL_RETIRED_KEY,
    installId,
  );
}

export async function isInstallRetired(): Promise<boolean> {
  return (await getAppMeta(INSTALL_RETIRED_KEY)) === "1";
}
