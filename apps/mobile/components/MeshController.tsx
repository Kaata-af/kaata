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
  const [accountId, setAccountId] = useState<string | null>(null);
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
  const peerFailureWindowRef = useRef<{ timestamps: number[]; lastToastAt: number }>({
    timestamps: [],
    lastToastAt: 0,
  });

  // Wire mesh-side bridges to UI surfaces on mount. Only ONE
  // MeshController is rendered per app lifetime (mounted in _layout),
  // so this is safe to do at mount without race-against-unmount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mesh = await import("../lib/mesh");
      const wifi = await import("../lib/mesh/wifi-upgrade");
      if (cancelled) return;

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
            const now = Date.now();
            const w = peerFailureWindowRef.current;
            w.timestamps = w.timestamps.filter((ts) => now - ts < 15 * 60 * 1000);
            if (w.timestamps.length >= 3) return;
            if (now - w.lastToastAt < 30 * 1000) return;
            w.timestamps.push(now);
            w.lastToastAt = now;
            console.info("[mesh-ctl] peer handshake failed:", event.reason);
            toastRef.current.push(t("menu.ble.peerHandshakeFailed"), "info");
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
      const unsub = mesh.onShopModeStatusChange?.((s) => {
        if (cancelled) return;
        setActivePeers(s.activePeers);
        // Update the persistent notification body to match real state.
        void (async () => {
          try {
            const fg = await import("../lib/mesh/foreground");
            const body =
              s.activePeers === 0
                ? "Waiting for your team to connect…"
                : s.activePeers === 1
                  ? "Connected to 1 paired phone"
                  : `Connected to ${s.activePeers} paired phones`;
            await fg.updateShopModeNotification({ body });
          } catch (err) {
            if (__DEV__) console.warn("[mesh-ctl] updateShopModeNotification failed", err);
          }
        })();
      });

      return () => {
        if (typeof unsub === "function") unsub();
        wifi.setWifiUpgradePromptBridge(null);
        wifi.setWifiUpgradeToastBridge(null);
        mesh.setMeshFailureBridge(null);
      };
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 10s app_meta poll. Mirrors AutoSync. (Status changes for active peer
  // count flow via onShopModeStatusChange above — not via polling.)
  useEffect(() => {
    let cancelled = false;
    let confirmedNoAccount = false;
    const poll = async () => {
      if (confirmedNoAccount) return;
      const [id, raw] = await Promise.all([
        getAppMeta("account_id"),
        getAppMeta("shop_mode_enabled"),
      ]);
      if (cancelled) return;
      setAccountId(id);
      setShopModeEnabled(raw === "1");
      if (!id) {
        confirmedNoAccount = true;
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
  // then request, then either start mesh or revert+toast.
  //
  // UX critique #6: on Android, ShopModeForegroundServiceFailedError
  // means the FGS never came up — the radio won't survive Doze and the
  // user thinks Nearby sync is on while it actually isn't. Revert the
  // toggle and show a specific error toast so the state matches reality.
  const handleStartError = useRef((err: unknown) => {
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      (err as { name: string }).name === "ShopModeForegroundServiceFailedError"
    ) {
      void setAppMeta("shop_mode_enabled", "0");
      toastRef.current.push(t("menu.sync.shopMode.fgsFailed"), "error");
      return;
    }
    console.warn("[mesh-ctl] startShopMode failed", err);
    void setAppMeta("shop_mode_enabled", "0");
    toastRef.current.push(t("menu.sync.shopMode.failed"), "error");
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
      console.warn("[mesh-ctl] ensurePermsAndStart failed", err);
      await setAppMeta("shop_mode_enabled", "0");
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
    void accountId; // referenced so the linter doesn't complain about it being unused
    const wantOn = shopModeEnabled;
    console.log(
      "[mesh.toggle] effect fired wantOn=",
      wantOn,
      "accountId?=",
      !!accountId,
      "shop_mode_enabled=",
      shopModeEnabled,
    );
    let cancelled = false;
    void (async () => {
      try {
        const mesh = await import("../lib/mesh");
        await mesh.hydrateLastActiveAt();
        if (cancelled) return;
        if (wantOn) {
          await ensurePermsAndStart.current();
        } else {
          await mesh.stopShopMode();
        }
      } catch (err) {
        console.warn("[mesh-ctl] mesh module load failed", err);
      }
    })();
    return () => {
      cancelled = true;
      void (async () => {
        try {
          const mesh = await import("../lib/mesh");
          await mesh.stopShopMode();
        } catch {
          /* */
        }
      })();
    };
  }, [accountId, shopModeEnabled]);

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
