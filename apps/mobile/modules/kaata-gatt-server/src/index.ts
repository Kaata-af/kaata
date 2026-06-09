// apps/mobile/modules/kaata-gatt-server/src/index.ts
//
// TypeScript public API for the kaata-gatt-server local Expo Module.
//
// Wraps the Kotlin BluetoothGattServer module behind a typed surface that
// matches the rest of lib/mesh/transport-ble.ts's adapter convention:
//   - openGattServer returns a teardown function (Promise<void>)
//   - on* subscriptions return EventSubscription (.remove())
//   - notifyCentral is a Promise wrapper
//
// Platform: Android-only. On non-Android the native require would throw
// at import time, so we lazily resolve the native module and gate every
// call. Callers in transport-ble.ts already gate on Platform.OS === "android"
// before invoking anything in this module — this is belt-and-suspenders.

import { Platform } from "react-native";
import { type EventSubscription, requireNativeModule } from "expo-modules-core";

// ---------------------------------------------------------------------------
// Event payload types - mirror the HashMap<String, Any?> payloads emitted
// from KaataGattServerModule.kt.
// ---------------------------------------------------------------------------

export type CentralConnectedEvent = {
  address: string;
  mtu: number;
};

export type CentralDisconnectedEvent = {
  address: string;
  /** Android GATT status code. 0 = clean. Logged only. */
  status: number;
};

export type CentralWriteEvent = {
  address: string;
  charUuid: string;
  /** Raw chunk bytes from the central, base64-encoded for the JS bridge. */
  valueBase64: string;
};

export type MtuChangedEvent = {
  address: string;
  mtu: number;
};

// ---------------------------------------------------------------------------
// Lazy native resolution. On Android, requireNativeModule succeeds once
// autolinking registered "KaataGattServer". On other platforms we leave it
// null and every public API throws / no-ops accordingly.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NativeKaataGattServer = any;

let _native: NativeKaataGattServer | null = null;

function getNative(): NativeKaataGattServer {
  if (_native) return _native;
  if (Platform.OS !== "android") {
    throw new Error("kaata-gatt-server is Android-only");
  }
  _native = requireNativeModule<NativeKaataGattServer>("KaataGattServer");
  return _native;
}

/** True iff the native module is loaded (Android only). */
export function isGattServerSupported(): boolean {
  if (Platform.OS !== "android") return false;
  try {
    getNative();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open the Kaata mesh GATT service with both characteristics registered.
 * Idempotent: calling twice tears down the previous server first.
 *
 * Returns a teardown function whose call closes the server cleanly. Caller is
 * responsible for runtime permissions (BLUETOOTH_CONNECT on Android 12+); if
 * missing, the returned promise rejects with code E_BLUETOOTH_CONNECT_DENIED.
 */
export async function openGattServer(
  serviceUuid: string,
  handshakeCharUuid: string,
  streamCharUuid: string,
): Promise<() => Promise<void>> {
  const native = getNative();
  await native.openGattServer(serviceUuid, handshakeCharUuid, streamCharUuid);
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    try {
      await native.closeGattServer();
    } catch {
      /* idempotent */
    }
  };
}

/**
 * Push a notification to a connected central. The native side looks up the
 * BluetoothDevice by `address`, calls notifyCharacteristicChanged, and
 * resolves once onNotificationSent fires (or rejects on timeout/failure).
 */
export async function notifyCentral(
  address: string,
  charUuid: string,
  valueBase64: string,
): Promise<void> {
  await getNative().notifyCentral(address, charUuid, valueBase64);
}

/** Force-disconnect a specific central. Idempotent. */
export async function disconnectCentral(address: string): Promise<void> {
  await getNative().disconnectCentral(address);
}

/** List currently-connected central MAC addresses. */
export async function getConnectedCentrals(): Promise<string[]> {
  const result = await getNative().getConnectedCentrals();
  return Array.isArray(result) ? (result as string[]) : [];
}

// ---------------------------------------------------------------------------
// Event subscriptions. Returning { remove(): void } matches the rest of the
// transport adapter conventions in lib/mesh/transport-ble.ts.
// ---------------------------------------------------------------------------

// In Expo SDK 52+, the native module instance IS an EventEmitter. Calling
// `getNative().addListener(name, handler)` is the canonical pattern; the
// older `new EventEmitter(nativeModule)` wrapper is deprecated and slated
// for removal.

export function onCentralConnected(
  handler: (event: CentralConnectedEvent) => void,
): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getNative().addListener("onCentralConnected", (e: any) =>
    handler(e as CentralConnectedEvent),
  );
}

export function onCentralDisconnected(
  handler: (event: CentralDisconnectedEvent) => void,
): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getNative().addListener("onCentralDisconnected", (e: any) =>
    handler(e as CentralDisconnectedEvent),
  );
}

export function onCentralWrite(handler: (event: CentralWriteEvent) => void): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getNative().addListener("onCentralWrite", (e: any) => handler(e as CentralWriteEvent));
}

export function onMtuChanged(handler: (event: MtuChangedEvent) => void): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getNative().addListener("onMtuChanged", (e: any) => handler(e as MtuChangedEvent));
}
