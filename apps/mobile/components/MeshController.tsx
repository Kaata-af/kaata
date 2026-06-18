// apps/mobile/components/MeshController.tsx
//
// Phase 6 mesh orchestrator. Mounts once at the app root and drives the
// mesh subsystem reactively. Renders nothing visible — surfaces are:
//   - foreground notification (lib/mesh/foreground.ts, body updates as
//     peer count changes)
//   - in-app toasts (registered via setWifiUpgradeToastBridge)
//   - wifi-upgrade prompt (registered via setWifiUpgradePromptBridge,
//     dispatched to a ConfirmDialog rendered inside this component)
//   - BLE permission rationale + denial dialog
//
// Reactive to (account_id, shop_mode_enabled):
//   - account_id null         → mesh stays off (local-only mode invariant).
//   - shop_mode_enabled != '1' → mesh stays off.
//   - both set                → request BLE permissions, then start mesh.
//
// Lifecycle when toggling ON:
//   1. User flips Switch → setAppMeta("shop_mode_enabled", "1")
//   2. This effect detects the change.
//   3. If we already have BLE perms (or non-Android): call startShopMode().
//   4. Else: show rationale dialog → requestBlePermissions() →
//        - on grant: startShopMode()
//        - on denied (retryable): revert toggle + toast
//        - on never_ask_again: show "Open settings" dialog
//
// Auto-off rules: same as Phase 5.1 (12h idle / 24h no-handshake cap).

import { useEffect, useRef, useState } from "react";
import { Linking, Platform } from "react-native";

import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { getAppMeta, setAppMeta } from "../lib/db";
import { t } from "../lib/i18n";
import { hasBlePermissions, requestBlePermissions } from "../lib/mesh/ble-permissions";
import { buildWifiUpgradePromptCopy, type WifiUpgradeChoice } from "../lib/mesh/wifi-upgrade";

const APP_META_POLL_MS = 10_000;
// Auto-resume backoff. A transient start failure (Bluetooth momentarily off,
// radio busy after a kill, FGS race) must NOT wipe the user's intent — we keep
// shop_mode_enabled="1" and retry a few times this session; the mount effect
// also retries on every app launch. Bounded so a permanently-failing start
// doesn't spin forever (the intent still persists for the next launch).
const START_RETRY_BASE_MS = 4_000;
const MAX_START_RETRIES = 4;
// Phase 7 founder decision: Nearby sync does NOT auto-off. The user is
// the only one who decides when to stop sharing — battery is their call,
// not ours. The 12h auto-off + 24h initial-grace logic from earlier
// phases has been removed entirely (was AUTO_OFF_AFTER_MS / AUTO_OFF_TICK_MS
// / INITIAL_GRACE_AFTER_MS). Foreground service keeps the radio alive
// until the user toggles off.

type WifiPromptState = {
  visible: boolean;
  copy: {
    title: string;
    body: string;
    tryWifiLabel: string;
    stayBleLabel: string;
  } | null;
  resolve: ((choice: WifiUpgradeChoice) => void) | null;
};

export function MeshController() {
  const toast = useToast();
  // accountId is tracked for observability only — Phase 7 removed it as a
  // mesh gate; see the PHASE 7 NOTE below.
  const [accountId, setAccountId] = useState<string | null>(null);
  void accountId;
  const [shopModeEnabled, setShopModeEnabled] = useState<boolean>(false);
  const [activePeers, setActivePeers] = useState(0);

  // BLE permission flow state.
  const [bleRationaleOpen, setBleRationaleOpen] = useState(false);
  const [bleDeniedOpen, setBleDeniedOpen] = useState(false);
  const [bleRationalePending, setBleRationalePending] = useState(false);

  // Wifi-upgrade prompt state — dispatched from anti-entropy via the
  // bridge registered in the mount effect below.
  const [wifiPrompt, setWifiPrompt] = useState<WifiPromptState>({
    visible: false,
    copy: null,
    resolve: null,
  });

  // Stable ref to the latest toast.push so the wifi-upgrade bridge
  // (registered ONCE on mount) always sees the live function.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Phase 9 D-FALLBACK-UX: debounce / coalesce state for the failure
  // bridge. peripheralUnsupported is a once-per-session latch;
  // adapterOff clears when adapter_on fires; peer failures get
  // 30s + 3-per-15-min coalescing so a noisy environment doesn't
  // produce a toast storm.
  const peripheralUnsupportedShownRef = useRef(false);
  const adapterOffShownRef = useRef(false);
  // M2c: once-per-session latch for the "nearby kaata needs an update"
  // toast (an outdated peer will keep retrying handshakes; one toast is
  // enough until the user restarts shop mode).
  const peerOutdatedShownRef = useRef(false);
  const peerFailureWindowRef = useRef<{ timestamps: number[]; lastToastAt: number }>({
    timestamps: [],
    lastToastAt: 0,
  });

  // Auto-resume retry state. attempts counts consecutive failed starts this
  // session; timer holds the pending backoff so we don't stack retries.
  const startAttemptsRef = useRef(0);
  const startRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Wire mesh-side bridges to UI surfaces on mount. Only ONE
  // MeshController is rendered per app lifetime (mounted in _layout),
  // so this is safe to do at mount without race-against-unmount.
  useEffect(() => {
    let cancelled = false;
    // Hoisted so the OUTER effect cleanup can release them. The previous
    // version returned a cleanup function from the inner async IIFE —
    // which is discarded by definition — so the status unsub and bridge
    // resets were dead code (leaked duplicate subscriptions on dev
    // fast-refresh).
    let statusUnsub: (() => void) | null = null;
    let meshMod: typeof import("../lib/mesh") | null = null;
    let wifiMod: typeof import("../lib/mesh/wifi-upgrade") | null = null;
    void (async () => {
      const mesh = await import("../lib/mesh");
      const wifi = await import("../lib/mesh/wifi-upgrade");
      if (cancelled) return;
      meshMod = mesh;
      wifiMod = wifi;

      wifi.setWifiUpgradeToastBridge((msg, kind) => {
        toastRef.current.push(msg, kind);
      });

      // Phase 9 D-FALLBACK-UX: failure bridge from the mesh layer.
      // Switch on the discriminator and pick the right (debounced) toast.
      mesh.setMeshFailureBridge((event) => {
        // Mythos crash-reporter: capture every mesh failure into the
        // backend outbox (best-effort, never throws). adapter_on is a
        // recovery signal, not a failure — skip it. The per-event toast
        // logic below is unchanged.
        if (event.kind !== "adapter_on") {
          const reason = (event as { reason?: string }).reason;
          void import("../lib/crash-report").then((cr) =>
            cr.queueCrashReport({
              kind: "mesh",
              name: event.kind,
              message: reason ? `reason=${reason}` : "",
            }),
          );
        }
        // M2c 'peer_outdated': a v1 peer was refused on an anchored
        // vault (membership-chain handshake). Handled via a string
        // match BEFORE the switch because the kind isn't in errors.ts's
        // MeshFailureEvent union yet (file deliberately untouched in
        // M2c; fold the kind into the union in M4). Also stamps the
        // peer-failure debounce window so the generic
        // peer_handshake_failed that the session-teardown path emits
        // right after doesn't double-toast.
        if ((event.kind as string) === "peer_outdated") {
          peerFailureWindowRef.current.lastToastAt = Date.now();
          if (peerOutdatedShownRef.current) return;
          peerOutdatedShownRef.current = true;
          toastRef.current.push(t("menu.ble.peerOutdated"), "info");
          return;
        }
        switch (event.kind) {
          case "peripheral_unsupported": {
            if (peripheralUnsupportedShownRef.current) return;
            peripheralUnsupportedShownRef.current = true;
            // Stays running (central-only). DO NOT revert the toggle.
            toastRef.current.push(t("menu.ble.peripheralUnsupported"), "info");
            return;
          }
          case "adapter_off": {
            if (adapterOffShownRef.current) return;
            adapterOffShownRef.current = true;
            toastRef.current.push(t("menu.ble.adapterOff"), "info");
            return;
          }
          case "adapter_on": {
            adapterOffShownRef.current = false;
            return;
          }
          case "peer_handshake_failed": {
            // A "transport" reason = the plumbing failed (couldn't connect / the
            // socket dropped before the handshake) — it auto-retries on the next
            // dial, so do NOT alarm the user with the "different Kaata" copy
            // (that copy is only accurate for a real membership/chain mismatch:
            // vmc_invalid, pop_failed, device_not_bound, no_genesis, …).
            if (event.reason === "transport") {
              console.info(
                "[mesh-ctl] peer transport failed (will retry):",
                event.reason,
                event.detail ?? "",
              );
              return;
            }
            const now = Date.now();
            const w = peerFailureWindowRef.current;
            w.timestamps = w.timestamps.filter((ts) => now - ts < 15 * 60 * 1000);
            if (w.timestamps.length >= 3) return;
            if (now - w.lastToastAt < 30 * 1000) return;
            w.timestamps.push(now);
            w.lastToastAt = now;
            console.info("[mesh-ctl] peer handshake failed:", event.reason, event.detail ?? "");
            // Append the precise verdict detail (verdict reason + folded vault)
            // while the BT pair/sync flow is being stabilized — far more useful
            // to a tester than the generic copy, and visible without adb.
            toastRef.current.push(
              t("menu.ble.peerHandshakeFailed") + (event.detail ? ` — ${event.detail}` : ""),
              "info",
            );
            return;
          }
          case "peer_decrypt_failed": {
            const now = Date.now();
            const w = peerFailureWindowRef.current;
            w.timestamps = w.timestamps.filter((ts) => now - ts < 15 * 60 * 1000);
            if (w.timestamps.length >= 3) return;
            if (now - w.lastToastAt < 30 * 1000) return;
            w.timestamps.push(now);
            w.lastToastAt = now;
            toastRef.current.push(t("menu.ble.peerDecryptFailed"), "info");
            return;
          }
          case "peer_dropped_midsync": {
            console.info("[mesh-ctl] peer dropped mid-sync, will retry on next discovery");
            return;
          }
        }
      });

      wifi.setWifiUpgradePromptBridge(async (opts) => {
        const copy = buildWifiUpgradePromptCopy({
          estimatedSeconds: opts.estimatedSeconds,
          totalEvents: opts.totalEvents,
          peerLabel: opts.peerLabel,
          t: (key, vars) => t(key as never, vars as never),
        });
        return await new Promise<WifiUpgradeChoice>((resolve) => {
          setWifiPrompt({
            visible: true,
            copy: {
              title: copy.title,
              body: copy.body,
              tryWifiLabel: copy.tryWifiLabel,
              stayBleLabel: copy.stayBleLabel,
            },
            resolve,
          });
        });
      });

      // Subscribe to status changes so the FG notification body and
      // local activePeers state stay in sync without polling.
      statusUnsub =
        mesh.onShopModeStatusChange?.((s) => {
          if (cancelled) return;
          setActivePeers(s.activePeers);
          // Update the persistent notification body to match real state.
          void (async () => {
            try {
              const fg = await import("../lib/mesh/foreground");
              const body =
                s.activePeers === 0
                  ? t("fgs.waiting")
                  : s.activePeers === 1
                    ? t("fgs.connectedOne")
                    : t("fgs.connectedMany", { count: s.activePeers });
              await fg.updateShopModeNotification({ body });
            } catch (err) {
              if (__DEV__) console.warn("[mesh-ctl] updateShopModeNotification failed", err);
            }
          })();
        }) ?? null;
    })();
    return () => {
      cancelled = true;
      if (statusUnsub) statusUnsub();
      if (wifiMod) {
        wifiMod.setWifiUpgradePromptBridge(null);
        wifiMod.setWifiUpgradeToastBridge(null);
      }
      if (meshMod) meshMod.setMeshFailureBridge(null);
    };
  }, []);

  // 10s app_meta poll. Mirrors AutoSync. (Status changes for active peer
  // count flow via onShopModeStatusChange above — not via polling.)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      // NO account_id gating here. A previous version latched the poll
      // off permanently on the first null account_id read — which meant
      // local-only shopkeepers (the Phase 7 target persona) who enabled
      // Nearby sync via any path that only writes app_meta (battery-
      // exemption confirm, pair-scan join, pair deep link) were never
      // observed: toggle showed ON, mesh never started until a cold
      // relaunch. Phase 7's local-CA design explicitly removed the
      // account requirement; the poll must mirror that.
      const [id, raw] = await Promise.all([
        getAppMeta("account_id"),
        getAppMeta("shop_mode_enabled"),
      ]);
      if (cancelled) return;
      setAccountId(id);
      setShopModeEnabled(raw === "1");
      // #43 P2 cross-VM heartbeat: while the FOREGROUND mesh is live, stamp the
      // heartbeat (~every 10s) so the headless background entry stays OUT (the
      // single-mesh guard). When the app is swipe-killed this poll stops, the
      // heartbeat goes stale (~25s), and the headless path may run. Only while
      // shop mode is on (no point claiming the radio when sync is off).
      if (raw === "1") {
        void import("../lib/mesh/bg-task")
          .then((m) => m.heartbeatJsAlive())
          .catch(() => {
            /* best-effort */
          });
      }
    };
    void poll();
    const t = setInterval(() => void poll(), APP_META_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // BLE permission gate. When the user toggles ON, we check whether the
  // runtime perms are granted; if not, show the rationale dialog FIRST,
  // then request, then either start mesh or (on an explicit permission
  // denial) clear the intent.
  //
  // INTENT-PRESERVING START ERRORS: a *transient* start failure must NOT
  // clear shop_mode_enabled. That was the bug behind "the toggle is OFF
  // every time I reopen the app" — a single radio/FGS hiccup disabled
  // sync silently. Only an explicit user choice (toggle-off, permission
  // denied) clears the persisted intent; everything else keeps it and
  // retries (handleStartError -> scheduleStartRetry).
  //
  // "Nothing to sync" — the user has no mesh-eligible vault yet. Retrying is
  // pointless and it isn't a failure the user can act on, so we stay quiet and
  // do NOT touch the intent (it resumes once they create/join a Kaata).
  const isTerminalStartError = (err: unknown): boolean =>
    !!err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name: string }).name === "ShopModeNotAvailableError";

  // Retry startShopMode with growing backoff WITHOUT wiping the user's intent.
  // Self-contained (only re-arms itself) so there's no ref cycle. Bails if the
  // user turned the intent off while we were waiting.
  const scheduleStartRetry = useRef(() => {
    if (startRetryTimerRef.current) return; // a retry is already pending
    if (startAttemptsRef.current >= MAX_START_RETRIES) return; // give up THIS session
    const attempt = startAttemptsRef.current;
    const delay = START_RETRY_BASE_MS * (attempt + 1);
    startRetryTimerRef.current = setTimeout(() => {
      startRetryTimerRef.current = null;
      void (async () => {
        const intent = await getAppMeta("shop_mode_enabled");
        if (intent !== "1") {
          startAttemptsRef.current = 0; // user turned it off — stop retrying
          return;
        }
        startAttemptsRef.current = attempt + 1;
        try {
          const mesh = await import("../lib/mesh");
          await mesh.startShopMode();
          startAttemptsRef.current = 0; // recovered
        } catch (e) {
          if (isTerminalStartError(e)) return;
          scheduleStartRetry.current();
        }
      })();
    }, delay);
  });

  // A start failed. CRITICAL: never clear shop_mode_enabled here. It is the
  // persisted user intent; clearing it on a transient failure was what forced
  // a manual re-toggle on every app reopen. Keep it set and retry instead.
  const handleStartError = useRef((err: unknown) => {
    if (isTerminalStartError(err)) return; // nothing to sync; keep intent, no retry
    console.warn("[mesh-ctl] startShopMode failed — keeping intent, retrying", err);
    scheduleStartRetry.current();
  });
  // Engineering critique N#1: single body. Prior version set the
  // useRef initial value AND immediately overwrote it with a near-identical
  // body — the initial-value version was dead code.
  const ensurePermsAndStart = useRef(async () => {
    try {
      const mesh = await import("../lib/mesh");
      const ok = await hasBlePermissions();
      if (ok) {
        try {
          await mesh.startShopMode();
        } catch (err) {
          handleStartError.current(err);
        }
        return;
      }
      // Show rationale; the dialog buttons drive the actual permission
      // request and either-start-or-revert flow.
      setBleRationaleOpen(true);
    } catch (err) {
      // Module-load / perm-check failure — transient, not a user choice.
      // Keep the intent and retry rather than silently disabling sync.
      console.warn("[mesh-ctl] ensurePermsAndStart failed — keeping intent, retrying", err);
      scheduleStartRetry.current();
    }
  });

  // Start / stop mesh in response to shop_mode_enabled.
  //
  // PHASE 7 NOTE: this used to gate on !!accountId so mesh stayed off in
  // local-only mode. Phase 7's local-CA design (vault owner's device key as
  // the trust anchor) explicitly removed that requirement — a shopkeeper
  // with no Google account must still be able to mesh with staff phones.
  // Keeping the old gate meant local-only users toggling Nearby sync
  // bypassed THIS effect entirely (which holds the BLE permission
  // rationale + request flow) and the home screen's direct
  // mesh.startShopMode() call hit BLUETOOTH_ADVERTISE SecurityException at
  // the advertise call → process killed. The accountId is still surfaced
  // (it influences the cloud-sync paths) but no longer gates mesh.
  useEffect(() => {
    const wantOn = shopModeEnabled;
    console.log("[mesh.toggle] effect fired wantOn=", wantOn);
    // A fresh intent (or an off-flip) cancels any pending auto-resume retry
    // and resets the backoff so a new toggle-on isn't blocked by a previous
    // session's exhausted attempts.
    if (startRetryTimerRef.current) {
      clearTimeout(startRetryTimerRef.current);
      startRetryTimerRef.current = null;
    }
    if (wantOn) startAttemptsRef.current = 0;
    let cancelled = false;
    void (async () => {
      try {
        const mesh = await import("../lib/mesh");
        await mesh.hydrateLastActiveAt();
        if (cancelled) return;
        if (wantOn) {
          // startShopMode is idempotent (no-ops when already running), so
          // re-entering here after home's direct start call is harmless.
          await ensurePermsAndStart.current();
        } else {
          await mesh.stopShopMode();
        }
        // #43 P2 Phase 1: register/unregister the periodic background catch-up to
        // match (shop_mode_enabled × bg_mesh_enabled). No-op unless the remote
        // kill-switch is on; idempotent; never throws.
        try {
          const { reconcileBgCatchup } = await import("../lib/mesh/bg-task");
          await reconcileBgCatchup();
        } catch {
          /* best-effort */
        }
      } catch (err) {
        console.warn("[mesh-ctl] mesh module load failed", err);
      }
    })();
    // NO stop in this cleanup. The previous version depended on
    // [accountId, shopModeEnabled] and unconditionally stopped mesh in
    // cleanup — so a sign-in (accountId flip) or the poll catching up
    // with home's direct start blipped mesh off/on mid-handshake, with
    // the unsequenced stop able to land AFTER the restart and kill mesh
    // while the toggle showed on. Off-transitions are handled by the
    // effect body above; true teardown by the unmount effect below.
    return () => {
      cancelled = true;
    };
  }, [shopModeEnabled]);

  // True-unmount teardown (app close / Activity destroy / dev fast-refresh).
  // BRIAR PARITY: this is a BACKGROUND HANDOFF, not a stop. We release the
  // JS-held radios but KEEP the native foreground service + resident engine
  // running (keepForegroundService) so the "Nearby sync" notification does NOT
  // vanish when the user swipes the app away — the native engine takes over.
  // Coupling the service to this unmount is exactly what caused the
  // "notification vanishes and comes back" flicker. stopShopMode WITHOUT
  // userInitiated also leaves shop_mode_enabled set, so a remount auto-resumes.
  useEffect(() => {
    return () => {
      if (startRetryTimerRef.current) {
        clearTimeout(startRetryTimerRef.current);
        startRetryTimerRef.current = null;
      }
      void import("../lib/mesh")
        .then((m) => m.stopShopMode({ keepForegroundService: true }))
        .catch(() => {
          /* */
        });
    };
  }, []);

  // No auto-off effect. Nearby sync stays on until the user toggles it
  // off. (Removed in Phase 7 per founder decision — see constants block.)

  // Tap-through suppressor for activePeers (avoid unused-var lint).
  void activePeers;

  return (
    <>
      {/* BLE permission rationale — shown BEFORE the OS dialogs so the
          user understands what they're agreeing to. Stock Android's
          "find/connect/relative position of nearby devices?" copy
          panics non-technical users; this dialog frames it in Kaata
          shopkeeper terms. */}
      <ConfirmDialog
        visible={bleRationaleOpen}
        title={t("menu.ble.permRationale.title")}
        description={t("menu.ble.permRationale.body")}
        confirmLabel={t("menu.ble.permRationale.continue")}
        cancelLabel={t("menu.ble.permRationale.cancel")}
        onConfirm={async () => {
          setBleRationaleOpen(false);
          if (bleRationalePending) return;
          setBleRationalePending(true);
          try {
            const result = await requestBlePermissions();
            if (result.kind === "ok") {
              const mesh = await import("../lib/mesh");
              try {
                await mesh.startShopMode();
              } catch (err) {
                handleStartError.current(err);
              }
            } else if (result.kind === "never_ask_again") {
              await setAppMeta("shop_mode_enabled", "0");
              setBleDeniedOpen(true);
            } else if (result.kind === "denied") {
              await setAppMeta("shop_mode_enabled", "0");
              toastRef.current.push(t("menu.sync.shopMode.failed"), "info");
            } else {
              // platform_unsupported → just start (perms not applicable)
              const mesh = await import("../lib/mesh");
              try {
                await mesh.startShopMode();
              } catch (err) {
                handleStartError.current(err);
              }
            }
          } finally {
            setBleRationalePending(false);
          }
        }}
        onCancel={async () => {
          setBleRationaleOpen(false);
          await setAppMeta("shop_mode_enabled", "0");
        }}
      />

      {/* "Don't ask again" recovery dialog — deep-link to system settings
          so the user can grant manually. */}
      <ConfirmDialog
        visible={bleDeniedOpen}
        title={t("menu.ble.permDenied.title")}
        description={t("menu.ble.permDenied.body")}
        confirmLabel={t("menu.ble.permDenied.openSettings")}
        cancelLabel={t("menu.ble.permDenied.cancel")}
        onConfirm={async () => {
          setBleDeniedOpen(false);
          if (Platform.OS === "android") {
            await Linking.openSettings().catch(() => {
              /* */
            });
          }
        }}
        onCancel={() => setBleDeniedOpen(false)}
      />

      {/* Wifi-upgrade prompt. Two buttons only (no destructive "Cancel
          sync" — that was the wrong-default destructive action between
          two non-destructive ones; users who want to abort just toggle
          the master Sync switch off). */}
      <ConfirmDialog
        visible={wifiPrompt.visible && wifiPrompt.copy !== null}
        title={wifiPrompt.copy?.title ?? ""}
        description={wifiPrompt.copy?.body}
        confirmLabel={wifiPrompt.copy?.tryWifiLabel ?? ""}
        cancelLabel={wifiPrompt.copy?.stayBleLabel ?? ""}
        onConfirm={() => {
          const r = wifiPrompt.resolve;
          setWifiPrompt({ visible: false, copy: null, resolve: null });
          r?.("wifi");
        }}
        onCancel={() => {
          const r = wifiPrompt.resolve;
          setWifiPrompt({ visible: false, copy: null, resolve: null });
          r?.("ble");
        }}
      />
    </>
  );
}
