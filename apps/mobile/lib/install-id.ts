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
