import * as Application from "expo-application";
import { getBackendUrl } from "./api";
import { clearLocalSession, getSessionJWT } from "./auth";
import { getAppMeta, getDb, setAppMeta } from "./db";

// Current snapshot schema version. Bump when the SQLite schema changes
// in a way that requires migration during restore. The backend stores
// this version alongside the snapshot so a later mobile build knows how
// to interpret an older snapshot.
export const SNAPSHOT_VERSION = 1;

// Network deadline for an upload. Snapshots are tiny (KBs to low MB) so
// 30s is generous — but flaky Afghan mobile networks justify a real
// upper bound here. Without this, a hung backend strands the UI spinner
// indefinitely.
const UPLOAD_TIMEOUT_MS = 30_000;

// Distinct error class for the 401 / session-expired case so the
// Settings UI can disambiguate "session needs re-auth" from "network
// or server failed." Callers should `instanceof SessionExpiredError`
// check before falling through to a generic message.
export class SessionExpiredError extends Error {
  constructor() {
    super("session_expired");
    this.name = "SessionExpiredError";
  }
}

// Snapshot is a plain-JSON representation of the entire mobile ledger.
// Stays close to the SQLite row shapes so restore can do straight
// INSERTs rather than synthesizing. Things we DON'T back up:
//   - app_meta (locale_pref, currency, tour_step, install_id) — these
//     are device-local settings, not ledger data
//   - schema_migrations — restore replays the local migration chain
//   - SecureStore (session JWT) — re-issued on next sign-in
type RawUser = {
  id: string;
  phone_e164: string | null;
  display_name: string;
  is_local_self: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

type RawShopProfile = {
  id: number;
  user_id: string;
  shop_name: string;
  owner_name: string | null;
  created_at: number;
  updated_at: number;
};

type RawRelationship = {
  id: string;
  user_a_id: string;
  user_b_id: string;
  context: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

type RawEntry = {
  id: string;
  relationship_id: string;
  type: string;
  amount_afn: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  proposed_by_user_id: string | null;
  accepted_at: number | null;
  disputed_at: number | null;
  disputed_reason: string | null;
  settled_at: number | null;
};

export type Snapshot = {
  version: number;
  exported_at: number; // unix ms — wall clock at build time
  users: RawUser[];
  shop_profile: RawShopProfile | null;
  relationships: RawRelationship[];
  entries: RawEntry[];
};

// buildSnapshot reads every ledger table from SQLite and serializes
// them into a flat snapshot. Wrapped in withTransactionAsync so all four
// queries see a consistent point-in-time view — without it, a concurrent
// write between two reads could produce a snapshot where (e.g.) an entry
// references a relationship_id that isn't in the relationships array.
//
// In practice the only concurrent writer is the user via the UI, and the
// app is foregrounded during a backup. But background tasks like the
// check-in could theoretically write, and the transaction makes the
// guarantee bulletproof at near-zero cost (these are sub-millisecond
// reads on a normal-sized ledger).
export async function buildSnapshot(): Promise<Snapshot> {
  const db = await getDb();
  let users: RawUser[] = [];
  let shopProfile: RawShopProfile | undefined;
  let relationships: RawRelationship[] = [];
  let entries: RawEntry[] = [];
  await db.withTransactionAsync(async () => {
    users = await db.getAllAsync<RawUser>(
      `SELECT id, phone_e164, display_name, is_local_self,
              created_at, updated_at, archived_at
       FROM users`,
    );
    const sp = await db.getFirstAsync<RawShopProfile>(
      `SELECT id, user_id, shop_name, owner_name, created_at, updated_at
       FROM shop_profile WHERE id = 1`,
    );
    shopProfile = sp ?? undefined;
    relationships = await db.getAllAsync<RawRelationship>(
      `SELECT id, user_a_id, user_b_id, context,
              created_at, updated_at, archived_at
       FROM relationships`,
    );
    entries = await db.getAllAsync<RawEntry>(
      `SELECT id, relationship_id, type, amount_afn, note,
              created_at, updated_at, deleted_at,
              proposed_by_user_id, accepted_at, disputed_at,
              disputed_reason, settled_at
       FROM entries`,
    );
  });

  return {
    version: SNAPSHOT_VERSION,
    exported_at: Date.now(),
    users,
    shop_profile: shopProfile ?? null,
    relationships,
    entries,
  };
}

// uploadBackup builds a snapshot and posts it to the backend.
//
// Error contract:
//   - Throws SessionExpiredError when the JWT is missing locally or the
//     backend returns 401. On 401, also wipes the cached session
//     (clearLocalSession) so the Settings UI immediately reflects the
//     "signed out" state and prompts re-auth.
//   - Throws Error("backup_failed:<status>:<detail>") on any other
//     non-2xx response, with the backend's error string preserved when
//     possible for diagnostics in console.warn.
//   - Throws Error("backup_timeout") when the request exceeds
//     UPLOAD_TIMEOUT_MS.
//
// On success persists last_backup_at_iso + last_backup_byte_size to
// app_meta so the Settings UI can show "Backed up N minutes ago" without
// a round-trip on next mount.
export async function uploadBackup(): Promise<{ updatedAt: string; byteSize: number }> {
  const jwt = await getSessionJWT();
  if (!jwt) {
    throw new SessionExpiredError();
  }
  const snapshot = await buildSnapshot();
  // Application.nativeApplicationVersion is the version baked into the
  // APK at build time. In dev/Expo Go it returns the value from
  // app.json's expo.version. Either way it's the source of truth — the
  // earlier process.env.EXPO_PUBLIC_APP_VERSION was never defined
  // anywhere and silently fell through to 'dev' on every upload.
  const appVersion = Application.nativeApplicationVersion ?? "unknown";
  const body = JSON.stringify({
    snapshot,
    snapshot_version: SNAPSHOT_VERSION,
    app_version: appVersion,
  });

  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/backup/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError surfaces as an exception. Map it to a distinct error
    // string so the caller can render a timeout-specific hint if it
    // wants. Other network errors (DNS, no route) bubble unchanged.
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("backup_timeout");
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (res.status === 401) {
    // JWT expired or secret rotated server-side. Wipe local session so
    // the UI flips to "signed out" immediately; the user has to sign
    // back in before another backup can succeed.
    await clearLocalSession();
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: string };
      detail = parsed?.error ?? "";
    } catch {
      // ignore parse failure
    }
    throw new Error(`backup_failed:${res.status}:${detail}`);
  }
  const json = (await res.json()) as { updated_at: string; byte_size: number };
  await setAppMeta("last_backup_at_iso", json.updated_at);
  await setAppMeta("last_backup_byte_size", String(json.byte_size));
  return { updatedAt: json.updated_at, byteSize: json.byte_size };
}

// Read-only access to the last-backup-at timestamp persisted by the
// most recent successful uploadBackup() call. Returns null if no backup
// has ever succeeded on this install.
export async function getLastBackupAt(): Promise<Date | null> {
  const iso = await getAppMeta("last_backup_at_iso");
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
