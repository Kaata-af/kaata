// Vault audit log — Phase 7 / D-AUDIT-LOG-LOCAL.
//
// Two-mode screen:
//   - Local-CA vault (vault_trust_anchor_pubkey set): derived from local
//     event_log via fetchLocalAuditLog(). No network. Always works offline.
//   - Server-anchored vault: calls fetchAuditLog() exactly once on mount.
//     - 404 -> terminal "not available" empty-state; never retried.
//     - 5xx/network -> bounded exponential backoff (1s, 2s, 4s, 8s; max 4
//       attempts, cap 30s). After that, surface a retry-button empty-state.
//     - Request aborts on unmount.
//
// The original screen re-fired loadFirstPage on every render because its
// useEffect depended on loadFirstPage (which depended on router/toast).
// On 404 the failure path called toast.push, which re-rendered, which
// recreated loadFirstPage, which re-fired the effect — ~8 req/s loop.
// Fix: mount effect has empty deps and reads everything it needs via refs.

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ScreenLoading } from "../../components/ScreenLoading";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getActiveVaultId, getDb } from "../../lib/db-tx";
import { getAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { fetchLocalAuditLog, isLocalCAVault } from "../../lib/projection/audit-log-local";
import { icon, radius } from "../../lib/tokens";
import { useVaultRole } from "../../lib/use-vault-role";
import { canPerformAction, type VaultRole } from "../../lib/vault-roles";
import { fetchAuditLog, type AuditEntry } from "../../lib/vault-api";

const PAGE_SIZE = 50;
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const BACKOFF_CAP_MS = 30_000;

/** Actor-initial circle in a row. Named so its radius is size/2, never a
 *  literal 22 that can drift away from the diameter (lib/tokens rule 3). */
const AVATAR_SIZE = 44;

type LoadError =
  | { kind: "none" }
  | { kind: "not_available" } // 404 — terminal, no retry
  | { kind: "transient"; attempts: number }; // 5xx/network — retry button

export default function VaultAuditLogScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();

  // Stable refs so we can call them from the mount effect without putting
  // them in the dep array (router/toast identities can change on render).
  const routerRef = useRef(router);
  const toastRef = useRef(toast);
  useEffect(() => {
    routerRef.current = router;
    toastRef.current = toast;
  }, [router, toast]);

  const [vaultId, setVaultId] = useState<string>("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [isLocal, setIsLocal] = useState<boolean>(false);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<LoadError>({ kind: "none" });
  const [actorNames, setActorNames] = useState<Map<string, string>>(new Map());

  const role = useVaultRole(vaultId, accountId);

  // Abort controller for the in-flight server fetch. Aborts on unmount and
  // before a manual refresh.
  const abortRef = useRef<AbortController | null>(null);

  // No-access redirect — separate from data load so it doesn't re-trigger
  // fetch. Consults the PERMISSIONS matrix (viewer AND clerk excluded —
  // roles v2 review fix: the old literal 'viewer' test let a clerk in).
  useEffect(() => {
    if (!loaded) return;
    if (!canPerformAction(role, "vault.view_audit_log")) {
      toastRef.current.push(t("auditLog.noViewerAccess"), "info");
      routerRef.current.back();
    }
  }, [role, loaded]);

  // Core loader. The mount effect runs once and calls it directly; refresh
  // and retry call it too. Sets state for the screen.
  const loadFirstPage = useCallback(
    async (opts: { isRefresh: boolean } = { isRefresh: false }): Promise<void> => {
      const vid = await getActiveVaultId();
      if (!vid) {
        toastRef.current.push(t("auditLog.toast.noActive"), "error");
        routerRef.current.back();
        return;
      }
      setVaultId(vid);
      const accId = await getAppMeta("account_id");
      setAccountId(accId);

      const db = await getDb();

      // Viewer redirect before the fetch path — avoids the flash of
      // spinner → empty/content → redirect cycle a viewer used to see.
      // The role-resolution helper inside-tx walks the same projection
      // useVaultRole consumes; running it here lets us short-circuit
      // before paying for either fetchLocalAuditLog or fetchAuditLog.
      if (accId) {
        const me = await db.getFirstAsync<{ role: string; revoked_at: number | null }>(
          `SELECT role, revoked_at FROM vault_members_mirror
            WHERE vault_id = ? AND account_id = ?`,
          vid,
          accId,
        );
        if (
          me &&
          me.revoked_at == null &&
          !canPerformAction(me.role as VaultRole, "vault.view_audit_log")
        ) {
          toastRef.current.push(t("auditLog.noViewerAccess"), "info");
          routerRef.current.back();
          return;
        }
      }

      // Actor-name lookup map — used for both local + server-mode rendering.
      const userRows = await db.getAllAsync<{
        account_id: string;
        display_name: string;
      }>(
        `SELECT account_id, display_name FROM users
          WHERE account_id IS NOT NULL`,
      );
      const map = new Map<string, string>();
      for (const r of userRows) {
        if (r.account_id) map.set(r.account_id, r.display_name);
      }
      setActorNames(map);

      const local = await isLocalCAVault(vid);
      setIsLocal(local);

      // ----- Local-CA path: query event_log, never throws on 404 -----
      if (local) {
        const page = await fetchLocalAuditLog(vid, {
          cursor: null,
          limit: PAGE_SIZE,
        });
        setEntries(page.entries);
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
        setError({ kind: "none" });
        return;
      }

      // ----- Server-anchored path: ONE attempt, bounded backoff on 5xx ---
      // Cancel any in-flight server request before starting a new one.
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (ctrl.signal.aborted) return;
        try {
          const page = await fetchAuditLog(vid, {
            cursor: null,
            limit: PAGE_SIZE,
          });
          if (ctrl.signal.aborted) return;
          setEntries(page.entries);
          setCursor(page.next_cursor);
          setHasMore(page.has_more ?? page.next_cursor !== null);
          setError({ kind: "none" });
          return;
        } catch (err) {
          if (ctrl.signal.aborted) return;
          const msg = err instanceof Error ? err.message : "";
          const is404 = /\b404\b/.test(msg) || /not found/i.test(msg);
          const is403 = /\b403\b/.test(msg) || /forbidden/i.test(msg);
          if (is403) {
            toastRef.current.push(t("auditLog.noViewerAccess"), "info");
            routerRef.current.back();
            return;
          }
          if (is404) {
            // Terminal: server has no audit log for this vault. Don't retry.
            setEntries([]);
            setCursor(null);
            setHasMore(false);
            setError({ kind: "not_available" });
            return;
          }
          // Transient. Backoff and try again, up to BACKOFF_MS.length times.
          attempt += 1;
          if (attempt > BACKOFF_MS.length || opts.isRefresh) {
            setError({ kind: "transient", attempts: attempt });
            return;
          }
          const delay = Math.min(BACKOFF_MS[attempt - 1] ?? BACKOFF_CAP_MS, BACKOFF_CAP_MS);
          await sleepAbortable(delay, ctrl.signal);
        }
      }
    },
    [],
  );

  // Mount-only effect. Empty deps. Guarantees exactly-once fetch on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadFirstPage({ isRefresh: false });
      } catch (err) {
        if (cancelled) return;
        console.warn("[vault/audit-log] load failed", err);
        toastRef.current.push(t("auditLog.toast.loadFailed"), "error");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    setExpanded(new Set());
    try {
      await loadFirstPage({ isRefresh: true });
    } catch (err) {
      console.warn("[vault/audit-log] refresh failed", err);
    } finally {
      setRefreshing(false);
    }
  }

  async function onRetry() {
    setError({ kind: "none" });
    setLoaded(false);
    try {
      await loadFirstPage({ isRefresh: false });
    } finally {
      setLoaded(true);
    }
  }

  async function onEndReached() {
    if (!hasMore || loadingMore || cursor === null) return;
    if (error.kind !== "none") return;
    setLoadingMore(true);
    try {
      const page = isLocal
        ? await fetchLocalAuditLog(vaultId, { cursor, limit: PAGE_SIZE })
        : await fetchAuditLog(vaultId, { cursor, limit: PAGE_SIZE });
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.next_cursor);
      setHasMore(page.has_more ?? page.next_cursor !== null);
    } catch (err) {
      // Pagination failures are silent (don't retry-loop); user can pull
      // to refresh.
      console.warn("[vault/audit-log] page failed", err);
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!loaded) {
    // Same title / onBack / edges as the loaded branch. This screen can sit
    // here for seconds (the server path retries with 1/2/4/8s backoff), and
    // the old header-less spinner gave a viewer no way out while it did.
    return (
      <ScreenLoading
        title={t("auditLog.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        edges={["top", "bottom"]}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScreenHeader
        title={t("auditLog.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      {/* All three "nothing to show" states now speak EmptyState's grammar
          rather than this screen's private 16px headline. emptyWrap survives
          as the centering box only — EmptyState owns the copy's air. */}
      {error.kind === "not_available" ? (
        <View style={styles.emptyWrap}>
          <EmptyState
            title={t("auditLog.notAvailable.title")}
            subtitle={t("auditLog.notAvailable.body")}
            isRTL={isRTL}
            icon="cloud-offline-outline"
          />
        </View>
      ) : error.kind === "transient" ? (
        <View style={styles.emptyWrap}>
          <EmptyState
            title={t("auditLog.toast.loadFailed")}
            // Retry is the only way off this state, so it rides EmptyState's
            // `action` slot. secondary (not primary) keeps the quiet weight the
            // bgMuted pill had — a black CTA here would out-shout the message.
            action={
              <Button label={t("common.retry")} onPress={onRetry} variant="muted" size="pill" />
            }
            isRTL={isRTL}
            icon="alert-circle-outline"
            iconColor={colors.danger}
          />
        </View>
      ) : entries.length === 0 ? (
        <View style={styles.emptyWrap}>
          <EmptyState
            title={t("auditLog.empty.title")}
            subtitle={t("auditLog.empty.body")}
            isRTL={isRTL}
            icon="document-text-outline"
          />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          renderItem={({ item }) => (
            <AuditRow
              entry={item}
              actorName={item.actor_id ? (actorNames.get(item.actor_id) ?? null) : null}
              expanded={expanded.has(item.id)}
              onToggle={() => toggleExpand(item.id)}
              isRTL={isRTL}
            />
          )}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footerLoading}>
                <ActivityIndicator color={colors.textDefault} />
              </View>
            ) : !hasMore && entries.length > 0 ? (
              <Text style={styles.endText}>{t("auditLog.endOfHistory")}</Text>
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

function AuditRow(props: {
  entry: AuditEntry;
  actorName: string | null;
  expanded: boolean;
  onToggle: () => void;
  isRTL: boolean;
}) {
  const { entry, actorName, expanded, onToggle, isRTL } = props;
  const display = actorName ?? shortId(entry.actor_id) ?? t("auditLog.system");
  const initial = (display.trim()[0] ?? "?").toUpperCase();
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.bgMuted }]}
    >
      <View style={[styles.rowMain, rowDir(isRTL)]}>
        <View style={[styles.avatarFallback, isRTL ? { marginLeft: 14 } : { marginRight: 14 }]}>
          <Text style={styles.avatarLetter}>{initial}</Text>
        </View>
        <View style={styles.rowTextCol}>
          <Text style={[styles.rowKind, textDir(isRTL)]} numberOfLines={1}>
            {humanizeKind(entry.kind, entry.payload)}
          </Text>
          <Text style={[styles.rowMeta, textDir(isRTL)]} numberOfLines={1}>
            {display} · {formatRelative(entry.occurred_at)}
          </Text>
          {!expanded ? (
            <Text style={[styles.previewText, textDir(isRTL)]} numberOfLines={1}>
              {previewPayload(entry.payload)}
            </Text>
          ) : null}
        </View>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={icon.trailing}
          color={colors.textMuted}
          style={isRTL ? { marginRight: 8 } : { marginLeft: 8 }}
        />
      </View>
      {expanded ? (
        <View style={[styles.payloadBox, isRTL ? { marginRight: 58 } : { marginLeft: 58 }]}>
          <Text style={styles.payloadText}>{JSON.stringify(entry.payload, null, 2)}</Text>
          {entry.target_id ? (
            <Text style={styles.payloadMeta}>
              {t("auditLog.target", { id: shortId(entry.target_id) ?? "" })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

// Kind humanizer covers both server-emitted audit kinds AND raw event_type
// values used by the local-CA derivation. Falls back to the raw value so we
// never render a blank row. Every branch now routes through t() so Dari
// (and future Persian) locales render correctly — previously the local-CA
// raw-event-type branches hardcoded English which leaked into the audit
// log in non-English locales.
function humanizeKind(kind: string, payload: Record<string, unknown> | null): string {
  switch (kind) {
    // ----- server audit kinds -----
    case "invite_issued":
      return t("auditLog.kind.inviteIssued");
    case "invite_accepted":
      return t("auditLog.kind.inviteAccepted");
    case "role_changed":
      return t("auditLog.kind.roleChanged");
    case "member_revoked":
      return t("auditLog.kind.memberRevoked");
    case "member_left":
      return t("auditLog.kind.memberLeft");
    case "vault_archived":
      return t("auditLog.kind.vaultArchived");
    case "transfer_initiated":
      return t("auditLog.kind.transferInitiated");
    case "transfer_completed":
      return t("auditLog.kind.transferCompleted");
    // ----- local-CA raw event types -----
    case "vault_member_added": {
      const role = payload && typeof payload.role === "string" ? payload.role : "";
      return role
        ? t("auditLog.kind.local.addedMemberAs", { role })
        : t("auditLog.kind.local.addedMember");
    }
    case "vault_member_role_changed": {
      const role = payload && typeof payload.role === "string" ? payload.role : "";
      return role
        ? t("auditLog.kind.local.roleChangedTo", { role })
        : t("auditLog.kind.roleChanged");
    }
    case "vault_member_removed":
      return t("auditLog.kind.memberRevoked");
    case "vault_setting_set": {
      const k = payload && typeof payload.key === "string" ? payload.key : "";
      const v = payload && typeof payload.value === "string" ? payload.value : "";
      if (k === "currency")
        return v
          ? t("auditLog.kind.local.currencyChangedTo", { value: v })
          : t("auditLog.kind.local.currencyChanged");
      if (k === "name")
        return v
          ? t("auditLog.kind.local.renamedTo", { value: v })
          : t("auditLog.kind.local.renamed");
      if (k === "archived_at")
        return v && v.trim() !== ""
          ? t("auditLog.kind.vaultArchived")
          : t("auditLog.kind.vaultUnarchived");
      return k
        ? t("auditLog.kind.local.settingChangedKey", { key: k })
        : t("auditLog.kind.local.settingChanged");
    }
    case "shop_profile_updated":
      return t("auditLog.kind.local.shopProfileUpdated");
    case "entry_created":
      return t("auditLog.kind.local.entryAdded");
    case "entry_amended":
      return t("auditLog.kind.local.entryEdited");
    case "entry_deleted":
      return t("auditLog.kind.local.entryDeleted");
    case "person_added":
      return t("auditLog.kind.local.personAdded");
    case "person_renamed":
      return t("auditLog.kind.local.personRenamed");
    case "person_archived":
      return t("auditLog.kind.local.personArchived");
    case "person_unarchived":
      return t("auditLog.kind.local.personUnarchived");
    default:
      return kind;
  }
}

function previewPayload(p: Record<string, unknown> | null): string {
  if (!p) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v == null) continue;
    // Skip technical id/UUID columns — they leak implementation detail
    // into the user-visible row preview (e.g. "relationship_id: 7e0…").
    // The expanded payload box still shows the full JSON for debugging.
    if (k === "vault_id" || k.endsWith("_id")) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}: ${v}`);
    }
    if (parts.length >= 3) break;
  }
  return parts.join(" · ");
}

function shortId(id: string | null): string | null {
  if (!id) return null;
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}…`;
}

function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return t("auditLog.relative.justNow");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("auditLog.relative.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("auditLog.relative.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("auditLog.relative.daysAgo", { n: days });
  const months = Math.floor(days / 30);
  return t("auditLog.relative.monthsAgo", { n: months });
}

// AbortSignal-aware sleep used by the server-mode backoff loop. Resolves
// early (without rejecting) when the signal aborts so the calling while-loop
// can detect aborted state via its own signal check.
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },

  listContent: { paddingBottom: 32 },

  row: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    minHeight: 64,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  rowMain: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  rowTextCol: { flex: 1 },
  avatarFallback: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: colors.bgMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLetter: {
    fontSize: 20,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
  },
  rowKind: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  rowMeta: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 1,
  },
  previewText: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textMuted,
    marginTop: 4,
  },
  payloadBox: {
    marginTop: 8,
    padding: 10,
    backgroundColor: colors.bgMuted,
    borderRadius: radius.sm,
  },
  payloadText: {
    fontSize: 12,
    fontFamily: fonts.monoRegular,
    color: colors.textEmphasis,
  },
  payloadMeta: {
    fontSize: 11,
    fontFamily: fonts.monoRegular,
    color: colors.textMuted,
    marginTop: 6,
  },

  // Centering box only. The horizontal padding and 12px gap moved into
  // EmptyState (which pads 24/56 itself) — keeping them here would double up.
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center" },

  footerLoading: { paddingVertical: 16, alignItems: "center" },
  endText: {
    textAlign: "center",
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textMuted,
    paddingVertical: 18,
  },
});
