// Lightweight read-only hooks for ProfileSettingsSheet (Phase 7)
// + the deprecated HamburgerMenuSheet's "this kaata" footprint.
//
// useMembersCount(vaultId, enabled)
//   Counts non-revoked rows in vault_members_mirror for the given vault.
//   In Phase 2 / local-only mode, the mirror is usually empty AND the user
//   is still the owner (see use-vault-role.ts's LOCAL_OWNER_DEFAULT rationale);
//   we treat an empty mirror as "1 member" so the menu reads
//   "Members (1)" instead of "Members (0)". That matches reality from the
//   shopkeeper's POV: it's their kaata, they're the member.
//
// useLastSyncedRelative(vaultId, enabled)
//   Reads sync_state.last_pull_at / last_push_at and returns a localized
//   relative-time string ("just now", "3 min ago", "2 hr ago") plus the raw
//   millisecond timestamp for callers that want to render their own copy.
//   Returns null when sync has never run (local-only install, fresh sign-in
//   pre-first-poll). The string is recomputed every 30s while enabled and
//   foregrounded so the menu doesn't go stale during a long inspection.
//
// Both hooks are read-only — they never mutate DB state. A mounted sheet
// passes its visibility as enabled, so closed sheets do no reads or polling.
// Opening/resuming reads immediately; closing/backgrounding retains the
// displayed value for the existing exit animation and ignores late replies.

import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { getDb } from "./db-tx";
import { getSyncIndicator } from "./sync";
import { t } from "./i18n";

const MEMBERS_REFRESH_MS = 15_000;
const SYNC_REFRESH_MS = 30_000;

// Each foreground interval owns its requests. A background/close/reopen edge
// invalidates the old interval even when its SQLite read cannot be cancelled.
function startForegroundRefresh(
  read: (isCurrent: () => boolean) => Promise<void>,
  cadence: number,
): () => void {
  let alive = true;
  let epoch = 0;
  let state = AppState.currentState;
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop() {
    epoch++;
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function start() {
    if (state !== "active") return;
    const requestEpoch = epoch;
    let reading = false;
    const isCurrent = () => alive && state === "active" && requestEpoch === epoch;
    async function refresh() {
      if (reading || !isCurrent()) return;
      reading = true;
      try {
        await read(isCurrent);
      } finally {
        reading = false;
      }
    }
    void refresh();
    timer = setInterval(() => void refresh(), cadence);
  }

  const subscription = AppState.addEventListener("change", (next) => {
    if (next === state) return;
    state = next;
    stop();
    start();
  });
  start();
  return () => {
    alive = false;
    stop();
    subscription.remove();
  };
}

export function useMembersCount(vaultId: string | null, enabled = true): number {
  // Default 1 means "just you". Empty mirror is the common Phase 2 case —
  // see header comment for why 1 (not 0) is the floor.
  const [count, setCount] = useState<number>(1);

  useEffect(() => {
    if (!enabled || !vaultId) return;

    async function read(isCurrent: () => boolean) {
      try {
        const db = await getDb();
        if (!isCurrent()) return;
        const row = await db.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) AS n FROM vault_members_mirror
            WHERE vault_id = ? AND revoked_at IS NULL`,
          vaultId,
        );
        if (!isCurrent()) return;
        const raw = row?.n ?? 0;
        // Empty mirror in Phase 2 means "no rows yet" — present that as a
        // single-member vault (the shopkeeper themself).
        setCount(raw === 0 ? 1 : raw);
      } catch {
        // Transient read failure → leave the existing value in place. A
        // count of "1" if we never read once is the safest fallback (the
        // user is always at least one member of their own vault).
      }
    }

    return startForegroundRefresh(read, MEMBERS_REFRESH_MS);
  }, [vaultId, enabled]);

  return count;
}

export type LastSyncedInfo = {
  // Most-recent of (last_pull_at, last_push_at) in ms-epoch. null when sync
  // has never completed for this vault.
  ms: number | null;
  // Localized relative-time string — already wrapped in t() so it changes
  // with the user's language pick.
  label: string;
};

export function useLastSyncedRelative(vaultId: string | null, enabled = true): LastSyncedInfo {
  const [info, setInfo] = useState<LastSyncedInfo>({
    ms: null,
    label: t("menu.sync.never"),
  });

  useEffect(() => {
    if (!enabled) return;
    if (!vaultId) {
      setInfo({ ms: null, label: t("menu.sync.never") });
      return;
    }
    const vid = vaultId;
    async function read(isCurrent: () => boolean) {
      try {
        const ind = await getSyncIndicator(vid);
        // last_push_at is usually fresher than last_pull_at because the
        // scheduler runs push AFTER pull; in steady state they're seconds
        // apart. We take max() so a vault that ONLY pulls (viewer role)
        // still shows a sensible value.
        const pull = ind.lastPullAt?.getTime() ?? 0;
        const push = ind.lastPushAt?.getTime() ?? 0;
        const newest = Math.max(pull, push);
        if (!isCurrent()) return;
        if (newest === 0) {
          setInfo({ ms: null, label: t("menu.sync.never") });
        } else {
          setInfo({ ms: newest, label: formatRelative(newest) });
        }
      } catch {
        // Same logic as useMembersCount — leave the previous label in
        // place rather than flashing "never".
      }
    }

    return startForegroundRefresh(read, SYNC_REFRESH_MS);
  }, [vaultId, enabled]);

  return info;
}

// Returns a short relative-time string for ms-epoch. Buckets are chosen to
// avoid the "0 seconds ago" / "59 seconds ago" precision that adds nothing
// useful: under 60s we say "just now", under an hour we say "N min ago",
// under a day "N hr ago", then fall back to days.
function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return t("menu.sync.justNow"); // clock skew → optimistic
  if (diff < 60_000) return t("menu.sync.justNow");
  if (diff < 60 * 60_000) {
    const m = Math.floor(diff / 60_000);
    return t("menu.sync.minAgo", { n: m });
  }
  if (diff < 24 * 60 * 60_000) {
    const h = Math.floor(diff / (60 * 60_000));
    return t("menu.sync.hrAgo", { n: h });
  }
  const d = Math.floor(diff / (24 * 60 * 60_000));
  return t("menu.sync.dayAgo", { n: d });
}
