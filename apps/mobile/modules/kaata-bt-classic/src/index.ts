// apps/mobile/modules/kaata-bt-classic/src/index.ts
//
// TypeScript public API for the kaata-bt-classic local Expo Module — Android
// Bluetooth Classic INSECURE RFCOMM, the way Briar does it: no OS bonding, no
// system pairing dialog, never shows as a connected device. All confidentiality
// /auth is kaata's own Noise-XX + membership-chain crypto layered on the raw
// byte stream (see lib/mesh/transport-btc.ts).
//
// An RFCOMM socket is a reliable ordered bidirectional byte stream ("TCP over
// Bluetooth"), so it maps onto the same MeshConnection byte-pipe LAN uses — no
// chunking/MTU/GATT machinery like BLE needed.
//
// Android-only. On other platforms the native module is absent; every call
// throws / no-ops and callers gate on Platform.OS === "android".

import { Platform } from "react-native";
import { type EventSubscription, requireNativeModule } from "expo-modules-core";

// ---------------------------------------------------------------------------
// Event payloads — mirror the HashMap payloads emitted from KaataBtClassicModule.kt
// ---------------------------------------------------------------------------

export type RfcommAcceptedEvent = {
  /** The server listener that accepted this socket. */
  listenerId: string;
  /** The accepted connection's socket id (used for read/write/close). */
  socketId: string;
  /** Remote device MAC, if the OS exposes it. */
  remoteMac: string | null;
};

export type RfcommDataEvent = {
  socketId: string;
  /** Raw inbound bytes, base64-encoded for the JS bridge. */
  valueBase64: string;
};

export type RfcommClosedEvent = {
  socketId: string;
  /** Best-effort reason (eof, read error, write failed, …). */
  reason?: string;
};

export type DeviceFoundEvent = {
  mac: string;
  name: string | null;
  /** BluetoothDevice.getType(): 1=CLASSIC, 2=LE, 3=DUAL, 0=UNKNOWN, -1=unavailable.
   *  Used to skip LE-only devices that can't answer an RFCOMM dial. */
  type?: number;
};

// ---------------------------------------------------------------------------
// Lazy native resolution (Android only).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NativeKaataBtClassic = any;

let _native: NativeKaataBtClassic | null = null;

function getNative(): NativeKaataBtClassic {
  if (_native) return _native;
  if (Platform.OS !== "android") {
    throw new Error("kaata-bt-classic is Android-only");
  }
  _native = requireNativeModule<NativeKaataBtClassic>("KaataBtClassic");
  return _native;
}

/** This device's Bluetooth name (e.g. "Galaxy A17"). Readable (unlike the MAC). */
export async function getLocalName(): Promise<string | null> {
  if (Platform.OS !== "android") return null;
  return (await getNative().getLocalName()) ?? null;
}

/**
 * This device's REAL Bluetooth MAC (Briar's 3-source recovery: adapter →
 * Settings.Secure → reflection), or null if none is obtainable on this device.
 * Put in the pair QR so the scanner dials the host directly instead of inquiring.
 */
export async function getLocalAddress(): Promise<string | null> {
  if (Platform.OS !== "android") return null;
  try {
    return (await getNative().getLocalAddress()) ?? null;
  } catch {
    return null;
  }
}

/** True iff the native module is loaded (Android only). */
export function isBtClassicSupported(): boolean {
  if (Platform.OS !== "android") return false;
  try {
    getNative();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// RFCOMM server / client / stream
// ---------------------------------------------------------------------------

/**
 * Open an INSECURE RFCOMM server socket on the given service UUID and start
 * accepting connections. Each accepted connection fires onRfcommAccepted with a
 * socketId. Returns a listenerId for stopRfcommServer. May be called multiple
 * times (e.g. one UUID per advertised vault digest).
 */
export async function openRfcommServer(serviceName: string, serviceUuid: string): Promise<string> {
  return await getNative().openRfcommServer(serviceName, serviceUuid);
}

export async function stopRfcommServer(listenerId: string): Promise<void> {
  await getNative().stopRfcommServer(listenerId);
}

/**
 * Dial a peer by MAC + service UUID over INSECURE RFCOMM (SDP-resolves the UUID
 * to a channel). Cancels any in-flight discovery first (radio contention).
 * Returns a socketId on success.
 */
export async function connectRfcomm(mac: string, serviceUuid: string): Promise<string> {
  return await getNative().connectRfcomm(mac, serviceUuid);
}

/** Write raw bytes (base64) to a connected socket. */
export async function writeRfcomm(socketId: string, valueBase64: string): Promise<void> {
  await getNative().writeRfcomm(socketId, valueBase64);
}

/** Close a socket (idempotent). Fires onRfcommClosed. */
export async function closeRfcomm(socketId: string): Promise<void> {
  await getNative().closeRfcomm(socketId);
}

// ---------------------------------------------------------------------------
// Classic discovery (inquiry) — used to learn a peer's MAC at first contact.
// ---------------------------------------------------------------------------

/** Start a classic inquiry scan. Fires onDeviceFound per device, onDiscoveryFinished at the end. */
export async function startClassicDiscovery(): Promise<boolean> {
  return await getNative().startClassicDiscovery();
}

export async function stopClassicDiscovery(): Promise<void> {
  await getNative().stopClassicDiscovery();
}

/**
 * Make this device classic-discoverable (system prompt, time-limited) so a peer
 * can learn its MAC via inquiry. Needed only for first contact; afterwards the
 * peer dials directly by the stored MAC.
 */
export async function requestDiscoverable(durationSec: number): Promise<boolean> {
  return await getNative().requestDiscoverable(durationSec);
}

// ---------------------------------------------------------------------------
// Native foreground service (Briar-style START_STICKY).
//
// Replaces notifee's JS-callback-bound foreground service so the "Nearby sync"
// notification + process survive app close / MIUI process death. See
// android/.../KaataForegroundService.kt. All no-op off Android.
// ---------------------------------------------------------------------------

/**
 * Start the native foreground service with the given notification copy. Throws
 * on a hard failure (e.g. background-start blocked) so the caller can treat the
 * FGS as not-started. channelName + channelDesc seed the native channel for the
 * no-JS sticky-restart case.
 */
export async function startMeshForegroundService(
  title: string,
  body: string,
  channelName: string,
  channelDesc: string,
): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  return await getNative().startMeshForegroundService(title, body, channelName, channelDesc);
}

/** Update the running service's title/body in place. Best-effort (never throws). */
export async function updateMeshForegroundService(title: string, body: string): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await getNative().updateMeshForegroundService(title, body);
  } catch {
    return false;
  }
}

/** Stop the service + remove its notification. Idempotent; never throws. */
export async function stopMeshForegroundService(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await getNative().stopMeshForegroundService();
  } catch {
    return false;
  }
}

/**
 * Mirror the REMOTE background-mesh kill-switch (#43 P2) into native SharedPrefs
 * so the killed-app background entry can read it with a plain Service Context
 * (the JS DB isn't natively readable, and appContext is dead post-kill). Driven
 * from the /v1/check-in response. Best-effort; never throws.
 */
export async function setBgMeshEnabled(enabled: boolean): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await getNative().setBgMeshEnabled(enabled);
  } catch {
    return false;
  }
}

/** Cutover flag (default OFF): run the native MeshEngine instead of headless JS. */
export async function setNativeEngineEnabled(enabled: boolean): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await getNative().setNativeEngineEnabled(enabled);
  } catch {
    return false;
  }
}

/** Inject the device Ed25519 seed (std base64) for the post-kill native engine.
 *  Stored AndroidKeyStore-encrypted natively. */
export async function setMeshDeviceSeed(seedB64: string): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await getNative().setMeshDeviceSeed(seedB64);
  } catch {
    return false;
  }
}

/**
 * Clear the LOCAL background-mesh crash-loop breaker. Called on every foreground
 * launch so a device that tripped the breaker self-heals the instant the app is
 * opened. Best-effort; never throws.
 */
export async function resetBgMeshFailures(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await getNative().resetBgMeshFailures();
  } catch {
    return false;
  }
}

/**
 * Cross-VM single-mesh heartbeat (#43 P2). The FOREGROUND mesh calls this ~every
 * 10s while live; the headless background entry reads isForegroundMeshAlive() and
 * stays out while a live JS mesh owns the radio. Best-effort; never throws.
 */
export async function markJsAlive(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await getNative().markJsAlive();
  } catch {
    return false;
  }
}

/** Read the heartbeat: is a foreground JS mesh probably alive right now?
 *  Fail-safe TRUE (assume alive => background stays out). */
export async function isForegroundMeshAlive(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await getNative().isForegroundAlive();
  } catch {
    return true;
  }
}

/** Clear the crash-loop breaker after a CLEAN headless window. Best-effort. */
export async function markBgMeshWindowOk(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await getNative().markBgMeshWindowOk();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event subscriptions (return { remove() } like the rest of the mesh adapters).
// ---------------------------------------------------------------------------

export function onRfcommAccepted(handler: (e: RfcommAcceptedEvent) => void): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getNative().addListener("onRfcommAccepted", (e: any) => handler(e as RfcommAcceptedEvent));
}

export function onRfcommData(handler: (e: RfcommDataEvent) => void): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getNative().addListener("onRfcommData", (e: any) => handler(e as RfcommDataEvent));
}

export function onRfcommClosed(handler: (e: RfcommClosedEvent) => void): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getNative().addListener("onRfcommClosed", (e: any) => handler(e as RfcommClosedEvent));
}

export function onDeviceFound(handler: (e: DeviceFoundEvent) => void): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getNative().addListener("onDeviceFound", (e: any) => handler(e as DeviceFoundEvent));
}

export function onDiscoveryFinished(handler: () => void): EventSubscription {
  if (Platform.OS !== "android") return { remove: () => {} };
  return getNative().addListener("onDiscoveryFinished", () => handler());
}
