package expo.modules.kaatabtclassic

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Base64
import expo.modules.kaatabtclassic.mesh.KeystoreSeedStore
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val TAG = "KaataBtClassic"

// Event names — must match the TS surface in src/index.ts.
private const val EVENT_ACCEPTED = "onRfcommAccepted"
private const val EVENT_DATA = "onRfcommData"
private const val EVENT_CLOSED = "onRfcommClosed"
private const val EVENT_DEVICE_FOUND = "onDeviceFound"
private const val EVENT_DISCOVERY_FINISHED = "onDiscoveryFinished"

private const val READ_BUF_BYTES = 4096

// The fake MAC Android returns to apps since API 23 to hide the real address.
// getLocalAddress rejects it (mirrors Briar's AndroidUtils.FAKE_BLUETOOTH_ADDRESS).
private const val FAKE_BLUETOOTH_ADDRESS = "02:00:00:00:00:00"

// Cap concurrent RFCOMM sockets. A pileup of half-open accepted/dialed sockets
// (each = a reader coroutine + 4KB buffer + thread stack + the BT stack's own
// buffers) under connect churn was inflating RSS toward the ~300MB JAVA_CRASH.
private const val MAX_SOCKETS = 8

/**
 * Expo Module wrapping Android Bluetooth Classic INSECURE RFCOMM for the kaata
 * mesh — the Briar approach. Insecure RFCOMM = no OS bonding / no PIN dialog /
 * never appears as a system paired-or-connected device; kaata layers its own
 * Noise-XX + membership-chain crypto on the raw stream (lib/mesh/transport-btc.ts).
 *
 * An RFCOMM BluetoothSocket exposes input/output streams = a reliable ordered
 * bidirectional byte pipe ("TCP over Bluetooth"), so it drops onto the same
 * MeshConnection seam the LAN transport uses — none of the BLE GATT/MTU/CCCD
 * machinery is needed.
 *
 * JS surface (see src/index.ts):
 *   - openRfcommServer(name, uuid) -> listenerId   (insecure server + accept loop)
 *   - stopRfcommServer(listenerId)
 *   - connectRfcomm(mac, uuid) -> socketId         (insecure client dial)
 *   - writeRfcomm(socketId, base64) / closeRfcomm(socketId)
 *   - startClassicDiscovery() / stopClassicDiscovery()  (inquiry, learn a MAC)
 *   - emits onRfcommAccepted / onRfcommData / onRfcommClosed /
 *     onDeviceFound / onDiscoveryFinished
 */
class KaataBtClassicModule : Module() {

  private var scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val nextId = AtomicInteger(1)

  private class ServerState(val socket: BluetoothServerSocket) {
    @Volatile var job: Job? = null
  }

  private class SockState(val socket: BluetoothSocket) {
    @Volatile var readJob: Job? = null
  }

  private val servers = ConcurrentHashMap<String, ServerState>()
  private val sockets = ConcurrentHashMap<String, SockState>()

  @Volatile private var discoveryReceiver: BroadcastReceiver? = null

  private val appCtx: Context
    get() = appContext.reactContext
      ?: throw CodedException("E_NO_CONTEXT", "React context unavailable", null)

  private fun adapter(): BluetoothAdapter {
    val mgr = appCtx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      ?: throw CodedException("E_NO_BT", "BluetoothManager unavailable", null)
    return mgr.adapter ?: throw CodedException("E_NO_BT", "No Bluetooth adapter on this device", null)
  }

  private fun ensureConnectPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    val ok = ContextCompat.checkSelfPermission(
      appCtx,
      Manifest.permission.BLUETOOTH_CONNECT,
    ) == PackageManager.PERMISSION_GRANTED
    if (!ok) {
      throw CodedException("E_BLUETOOTH_CONNECT_DENIED", "BLUETOOTH_CONNECT not granted", null)
    }
  }

  private fun ensureScanPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    val ok = ContextCompat.checkSelfPermission(
      appCtx,
      Manifest.permission.BLUETOOTH_SCAN,
    ) == PackageManager.PERMISSION_GRANTED
    if (!ok) {
      throw CodedException("E_BLUETOOTH_SCAN_DENIED", "BLUETOOTH_SCAN not granted", null)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("KaataBtClassic")

    Events(EVENT_ACCEPTED, EVENT_DATA, EVENT_CLOSED, EVENT_DEVICE_FOUND, EVENT_DISCOVERY_FINISHED)

    Function("isAvailable") {
      try {
        (appCtx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter != null
      } catch (_: Throwable) {
        false
      }
    }

    // This device's Bluetooth name (readable, unlike the MAC). Put in the pair
    // QR so the scanner can target ONLY the host among discovered devices.
    AsyncFunction("getLocalName") { promise: Promise ->
      try {
        promise.resolve(adapter().name)
      } catch (_: Throwable) {
        promise.resolve(null)
      }
    }

    // This device's REAL Bluetooth MAC, so the pair QR can carry it and the
    // scanner dials the host DIRECTLY (no unreliable name-inquiry) — exactly how
    // Briar does it (AndroidUtils.getBluetoothAddressAndMethod). Returns null if
    // none of the three sources yield a valid (non-fake) address.
    AsyncFunction("getLocalAddress") { promise: Promise ->
      promise.resolve(resolveLocalAddress())
    }

    AsyncFunction("openRfcommServer") { serviceName: String, serviceUuid: String, promise: Promise ->
      scope.launch {
        try {
          ensureConnectPermission()
          val uuid = UUID.fromString(serviceUuid)
          val server = adapter().listenUsingInsecureRfcommWithServiceRecord(serviceName, uuid)
          val listenerId = "L" + nextId.getAndIncrement()
          val st = ServerState(server)
          servers[listenerId] = st
          st.job = scope.launch { acceptLoop(listenerId, server) }
          Log.i(TAG, "rfcomm server open listener=$listenerId uuid=$serviceUuid")
          promise.resolve(listenerId)
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          Log.w(TAG, "openRfcommServer failed", e)
          promise.reject(CodedException("E_SERVER_FAILED", e.message ?: "openRfcommServer failed", e))
        }
      }
    }

    AsyncFunction("stopRfcommServer") { listenerId: String, promise: Promise ->
      scope.launch {
        try {
          servers.remove(listenerId)?.let { st ->
            try { st.socket.close() } catch (_: Throwable) { /* */ }
            st.job?.cancel()
          }
          promise.resolve(null)
        } catch (e: Throwable) {
          promise.reject(CodedException("E_STOP_FAILED", e.message ?: "stopRfcommServer failed", e))
        }
      }
    }

    AsyncFunction("connectRfcomm") { mac: String, serviceUuid: String, promise: Promise ->
      scope.launch {
        try {
          ensureConnectPermission()
          // Inquiry contends with the single radio; Android REQUIRES
          // cancelDiscovery() before connect(), and the radio needs a moment to
          // settle afterwards or the first connect fails instantly.
          try { if (adapter().isDiscovering) adapter().cancelDiscovery() } catch (_: Throwable) { /* */ }
          delay(250)
          val dev = adapter().getRemoteDevice(mac)
          val uuid = UUID.fromString(serviceUuid)
          val s = connectInsecure(dev, uuid)
          val socketId = registerSocket(s)
          Log.i(TAG, "rfcomm connected socket=$socketId mac=$mac")
          promise.resolve(socketId)
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          Log.w(TAG, "connectRfcomm failed mac=$mac", e)
          promise.reject(CodedException("E_CONNECT_FAILED", e.message ?: "connectRfcomm failed", e))
        }
      }
    }

    AsyncFunction("writeRfcomm") { socketId: String, valueBase64: String, promise: Promise ->
      scope.launch {
        try {
          val st = sockets[socketId]
            ?: throw CodedException("E_NO_SOCKET", "No socket $socketId", null)
          val bytes = Base64.decode(valueBase64, Base64.NO_WRAP)
          st.socket.outputStream.write(bytes)
          st.socket.outputStream.flush()
          promise.resolve(null)
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          // A write failure means the link is gone — surface as closed.
          closeSocketInternal(socketId, "write failed: ${e.message}")
          promise.reject(CodedException("E_WRITE_FAILED", e.message ?: "writeRfcomm failed", e))
        }
      }
    }

    AsyncFunction("closeRfcomm") { socketId: String, promise: Promise ->
      scope.launch {
        closeSocketInternal(socketId, null)
        promise.resolve(null)
      }
    }

    AsyncFunction("startClassicDiscovery") { promise: Promise ->
      scope.launch {
        try {
          ensureScanPermission()
          registerDiscoveryReceiver()
          try { if (adapter().isDiscovering) adapter().cancelDiscovery() } catch (_: Throwable) { /* */ }
          val started = adapter().startDiscovery()
          promise.resolve(started)
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          promise.reject(CodedException("E_DISCOVERY_FAILED", e.message ?: "startClassicDiscovery failed", e))
        }
      }
    }

    AsyncFunction("stopClassicDiscovery") { promise: Promise ->
      scope.launch {
        try {
          try { adapter().cancelDiscovery() } catch (_: Throwable) { /* */ }
          unregisterDiscoveryReceiver()
          promise.resolve(null)
        } catch (e: Throwable) {
          promise.reject(CodedException("E_STOP_DISCOVERY_FAILED", e.message ?: "stopClassicDiscovery failed", e))
        }
      }
    }

    // Make THIS device classic-discoverable so a peer that doesn't know our MAC
    // can find it via inquiry (Android hides the local MAC since API 23). Shows
    // the system ACTION_REQUEST_DISCOVERABLE prompt; time-limited (max ~300s on
    // most OEMs). Needed only for first contact.
    AsyncFunction("requestDiscoverable") { durationSec: Int, promise: Promise ->
      try {
        val activity = appContext.currentActivity
          ?: throw CodedException("E_NO_ACTIVITY", "No current activity for discoverability", null)
        val intent = Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE)
          .putExtra(BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, durationSec)
        activity.runOnUiThread { activity.startActivity(intent) }
        promise.resolve(true)
      } catch (e: CodedException) {
        promise.reject(e)
      } catch (e: Throwable) {
        Log.w(TAG, "requestDiscoverable failed", e)
        promise.reject(CodedException("E_DISCOVERABLE_FAILED", e.message ?: "requestDiscoverable failed", e))
      }
    }

    // -----------------------------------------------------------------------
    // Native foreground service (Briar-style START_STICKY). Replaces notifee's
    // JS-callback-bound FGS so the "Nearby sync" notification + process survive
    // app close / MIUI process death. See KaataForegroundService.kt.
    // -----------------------------------------------------------------------

    // Start (or update) the foreground service. The app is in the foreground
    // whenever this is called (user toggle / app-open auto-resume), so
    // startForegroundService is allowed by the API 31+ background-start rules.
    AsyncFunction("startMeshForegroundService") {
        title: String, body: String, channelName: String, channelDesc: String, promise: Promise ->
      try {
        val intent = Intent(appCtx, KaataForegroundService::class.java).apply {
          action = KaataForegroundService.ACTION_START
          putExtra(KaataForegroundService.EXTRA_TITLE, title)
          putExtra(KaataForegroundService.EXTRA_BODY, body)
          putExtra(KaataForegroundService.EXTRA_CHANNEL_NAME, channelName)
          putExtra(KaataForegroundService.EXTRA_CHANNEL_DESC, channelDesc)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) appCtx.startForegroundService(intent)
        else appCtx.startService(intent)
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.w(TAG, "startMeshForegroundService failed", e)
        promise.reject(CodedException("E_FGS_START", e.message ?: "startMeshForegroundService failed", e))
      }
    }

    // Background-mesh kill-switch + crash-loop breaker (#43 P2 Phase 0). These run
    // while JS is ALIVE (foreground), so appCtx is valid here — the gate itself
    // reads with a plain Service Context after a swipe-kill. setBgMeshEnabled
    // mirrors the remote /v1/check-in flag into SharedPrefs so the background
    // entry (Phase 1/2) can read it natively post-kill; resetBgMeshFailures clears
    // the local breaker on every foreground launch (self-heal).
    AsyncFunction("setBgMeshEnabled") { enabled: Boolean, promise: Promise ->
      try {
        KaataBgMeshGate.setEnabled(appCtx, enabled)
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.w(TAG, "setBgMeshEnabled failed", e)
        promise.reject(CodedException("E_BG_GATE", e.message ?: "setBgMeshEnabled failed", e))
      }
    }

    // Cutover wiring (#43 P2 native engine). Mirror the native_engine_enabled flag
    // from the check-in response; default OFF means the legacy headless path stays
    // the default until explicitly enabled per-cohort. JS-alive => appCtx valid.
    AsyncFunction("setNativeEngineEnabled") { enabled: Boolean, promise: Promise ->
      try {
        KaataBgMeshGate.setNativeEngineEnabled(appCtx, enabled)
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.w(TAG, "setNativeEngineEnabled failed", e)
        promise.reject(CodedException("E_BG_GATE", e.message ?: "setNativeEngineEnabled failed", e))
      }
    }

    // Inject the device Ed25519 seed (standard base64) so the post-kill native
    // engine can sign proof-of-possession. Stored AndroidKeyStore-encrypted
    // (KeystoreSeedStore) — never plaintext. Called from JS at foreground.
    AsyncFunction("setMeshDeviceSeed") { seedB64: String, promise: Promise ->
      try {
        val seed = Base64.decode(seedB64, Base64.NO_WRAP)
        if (seed.size != 32) {
          promise.reject(CodedException("E_SEED", "seed must be 32 bytes (got ${seed.size})", null))
        } else {
          val ok = KeystoreSeedStore.setSeed(appCtx, seed)
          promise.resolve(ok)
        }
      } catch (e: Throwable) {
        Log.w(TAG, "setMeshDeviceSeed failed", e)
        promise.reject(CodedException("E_SEED", e.message ?: "setMeshDeviceSeed failed", e))
      }
    }

    AsyncFunction("resetBgMeshFailures") { promise: Promise ->
      try {
        KaataBgMeshGate.resetFailures(appCtx)
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.w(TAG, "resetBgMeshFailures failed", e)
        promise.reject(CodedException("E_BG_GATE", e.message ?: "resetBgMeshFailures failed", e))
      }
    }

    // Cross-VM single-mesh heartbeat (#43 P2). The FOREGROUND mesh stamps this ~10s;
    // the headless background entry reads isForegroundAlive() and stays OUT while a
    // live JS mesh owns the radio. markBgMeshWindowOk clears the crash-loop breaker
    // after a CLEAN headless window. All run while a JS context is alive => appCtx valid.
    AsyncFunction("markJsAlive") { promise: Promise ->
      try {
        KaataBgMeshGate.markJsAlive(appCtx, System.currentTimeMillis())
        promise.resolve(true)
      } catch (e: Throwable) {
        promise.reject(CodedException("E_BG_GATE", e.message ?: "markJsAlive failed", e))
      }
    }

    AsyncFunction("isForegroundAlive") { promise: Promise ->
      try {
        promise.resolve(KaataBgMeshGate.isForegroundAlive(appCtx, System.currentTimeMillis()))
      } catch (e: Throwable) {
        // Fail-safe: assume alive so the background path stays out.
        promise.resolve(true)
      }
    }

    AsyncFunction("markBgMeshWindowOk") { promise: Promise ->
      try {
        KaataBgMeshGate.markWindowOk(appCtx)
        promise.resolve(true)
      } catch (e: Throwable) {
        promise.reject(CodedException("E_BG_GATE", e.message ?: "markBgMeshWindowOk failed", e))
      }
    }

    // In-place title/body update as peer count changes. Uses startService (NOT
    // startForegroundService): updates can fire while the app is backgrounded,
    // and re-issuing startForegroundService from the background throws on API
    // 31+. The service is already running+foreground here, so a plain
    // startService command is allowed. Best-effort — failures are ignored.
    AsyncFunction("updateMeshForegroundService") { title: String, body: String, promise: Promise ->
      try {
        val intent = Intent(appCtx, KaataForegroundService::class.java).apply {
          action = KaataForegroundService.ACTION_START
          putExtra(KaataForegroundService.EXTRA_TITLE, title)
          putExtra(KaataForegroundService.EXTRA_BODY, body)
        }
        appCtx.startService(intent)
        promise.resolve(true)
      } catch (_: Throwable) {
        promise.resolve(false)
      }
    }

    // Stop the service (user toggled Nearby sync off). stopService -> onDestroy
    // removes the notification; not subject to the 5s startForeground rule.
    AsyncFunction("stopMeshForegroundService") { promise: Promise ->
      try {
        appCtx.stopService(Intent(appCtx, KaataForegroundService::class.java))
        promise.resolve(true)
      } catch (e: Throwable) {
        Log.w(TAG, "stopMeshForegroundService failed", e)
        promise.resolve(false)
      }
    }

    OnDestroy {
      // Cancel the scope so coroutines don't leak on HMR/rebind; tear down on a
      // throwaway scope (mirrors KaataGattServerModule).
      val prior = scope
      val teardown = CoroutineScope(SupervisorJob() + Dispatchers.IO)
      teardown.launch {
        try { internalCloseAll() } catch (_: Throwable) { /* */ }
        try { prior.cancel() } catch (_: Throwable) { /* */ }
        try { teardown.cancel() } catch (_: Throwable) { /* */ }
      }
      scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  // Emit a JS event ONLY if the React context is still alive, and never let the
  // emit throw. sendEvent() throws when the runtime/JS context is gone (app
  // backgrounded/killed, HMR rebind) — and these emits fire on IO coroutines and
  // the discovery BroadcastReceiver's main thread, where an UNCAUGHT throw kills
  // the whole process. That was the observed JAVA_CRASH during connect churn.
  private fun safeEmit(name: String, payload: Map<String, Any?>) {
    try {
      if (appContext.reactContext != null) sendEvent(name, payload)
    } catch (_: Throwable) {
      /* context torn down mid-emit during churn — must never crash the process */
    }
  }

  private fun isValidBtAddress(addr: String?): Boolean =
    !addr.isNullOrEmpty() &&
      BluetoothAdapter.checkBluetoothAddress(addr) &&
      addr != FAKE_BLUETOOTH_ADDRESS

  // Port of Briar's AndroidUtils.getBluetoothAddressAndMethod: try the adapter,
  // then Settings.Secure (API < 33), then reflection on the hidden mService.
  // Each source is guarded — a SecurityException (missing BLUETOOTH_CONNECT) just
  // falls through to the next. Returns null when no source yields a real address.
  private fun resolveLocalAddress(): String? {
    val adapter = try { adapter() } catch (_: Throwable) { return null }
    // 1. adapter.getAddress() — valid on older Android / some OEMs.
    try {
      val a = adapter.address
      if (isValidBtAddress(a)) return a
    } catch (_: Throwable) { /* SecurityException on newer Android — try next */ }
    // 2. Settings.Secure "bluetooth_address" — readable on API < 33.
    if (Build.VERSION.SDK_INT < 33) {
      try {
        val a = Settings.Secure.getString(appCtx.contentResolver, "bluetooth_address")
        if (isValidBtAddress(a)) return a
      } catch (_: Throwable) { /* */ }
    }
    // 3. Reflection on the hidden mService.getAddress().
    try {
      val field = adapter.javaClass.getDeclaredField("mService")
      field.isAccessible = true
      val mService = field.get(adapter)
      if (mService != null) {
        val getAddress = mService.javaClass.getMethod("getAddress")
        val a = getAddress.invoke(mService) as? String
        if (isValidBtAddress(a)) return a
      }
    } catch (_: Throwable) { /* */ }
    return null
  }

  // Blocking accept loop on an IO coroutine. Cancelled by closing the server
  // socket (accept() then throws IOException) + removing the listener.
  private suspend fun acceptLoop(listenerId: String, server: BluetoothServerSocket) {
    while (servers.containsKey(listenerId)) {
      val socket: BluetoothSocket = try {
        server.accept()
      } catch (_: IOException) {
        break // server closed / stopped
      } catch (e: Throwable) {
        Log.w(TAG, "accept failed listener=$listenerId", e)
        break
      }
      try {
        val socketId = registerSocket(socket)
        val payload = HashMap<String, Any?>()
        payload["listenerId"] = listenerId
        payload["socketId"] = socketId
        // Validate the accepted socket's remote address: modern Android /
        // insecure-RFCOMM often hands back the MASKED 02:00:00:00:00:00
        // (FAKE_BLUETOOTH_ADDRESS). Emitting that let the owner cache a dead MAC
        // for the joiner and dial it forever (owner->joiner BT sync never
        // worked). Emit only a real, routable address; else null.
        payload["remoteMac"] = try {
          val ra = socket.remoteDevice?.address
          if (isValidBtAddress(ra)) ra else null
        } catch (_: Throwable) {
          null
        }
        safeEmit(EVENT_ACCEPTED, payload)
        Log.i(TAG, "rfcomm accepted socket=$socketId listener=$listenerId")
      } catch (e: Throwable) {
        try { socket.close() } catch (_: Throwable) { /* */ }
        Log.w(TAG, "accept handling failed", e)
      }
    }
  }

  // Insecure RFCOMM connect, SDP-based, like Briar. The first attempt right after
  // an inquiry commonly fails (SDP not warmed up), so retry once.
  //
  // NO reflection createInsecureRfcommSocket(channel=1) fallback. Channel 1 is
  // almost never the service's real (system-assigned) channel, so dialing it
  // connects to whatever OTHER RFCOMM service happens to sit on channel 1 — NOT
  // our pairing service. With the dial-every-discovered-device sweep, that made
  // discoverAndConnect "succeed" against the WRONG device, and the kaata
  // handshake then died with "connection closed / unsupported wire version
  // undefined" against that wrong service. Briar has no such fallback for exactly
  // this reason: only the SDP path (UUID -> the host's real channel) reaches the
  // pairing service; a device without the service simply fails to connect and the
  // sweep moves on to the next candidate (the real host).
  private suspend fun connectInsecure(dev: BluetoothDevice, uuid: UUID): BluetoothSocket {
    var lastErr: Throwable? = null
    for (attempt in 1..2) {
      var s: BluetoothSocket? = null
      try {
        s = dev.createInsecureRfcommSocketToServiceRecord(uuid)
        s.connect()
        return s
      } catch (e: Throwable) {
        lastErr = e
        try { s?.close() } catch (_: Throwable) { /* */ }
        Log.w(TAG, "rfcomm SDP connect attempt $attempt failed: ${e.message}")
        if (attempt < 2) delay(500)
      }
    }
    throw lastErr ?: IOException("rfcomm connect failed")
  }

  private fun registerSocket(socket: BluetoothSocket): String {
    // Refuse + close beyond the cap so a half-open pileup can't grow unbounded.
    // We close the passed socket ourselves so neither caller (connect/accept)
    // leaks it when this throws.
    if (sockets.size >= MAX_SOCKETS) {
      Log.w(TAG, "socket cap reached ($MAX_SOCKETS) — refusing + closing new socket")
      try { socket.close() } catch (_: Throwable) { /* */ }
      throw CodedException("E_TOO_MANY_SOCKETS", "Too many open RFCOMM sockets", null)
    }
    val socketId = "S" + nextId.getAndIncrement()
    val st = SockState(socket)
    sockets[socketId] = st
    st.readJob = scope.launch { readLoop(socketId, socket) }
    return socketId
  }

  // Blocking read loop on an IO coroutine. Emits inbound bytes as base64.
  private suspend fun readLoop(socketId: String, socket: BluetoothSocket) {
    val input = try {
      socket.inputStream
    } catch (e: Throwable) {
      closeSocketInternal(socketId, "no input stream")
      return
    }
    val buf = ByteArray(READ_BUF_BYTES)
    while (sockets.containsKey(socketId)) {
      val n = try {
        input.read(buf)
      } catch (e: IOException) {
        closeSocketInternal(socketId, "read error: ${e.message}")
        return
      } catch (e: Throwable) {
        closeSocketInternal(socketId, "read failed: ${e.message}")
        return
      }
      if (n < 0) {
        closeSocketInternal(socketId, "eof")
        return
      }
      if (n == 0) continue
      val b64 = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
      val payload = HashMap<String, Any?>()
      payload["socketId"] = socketId
      payload["valueBase64"] = b64
      safeEmit(EVENT_DATA, payload)
    }
  }

  private fun closeSocketInternal(socketId: String, reason: String?) {
    val st = sockets.remove(socketId) ?: return
    try { st.socket.close() } catch (_: Throwable) { /* */ }
    st.readJob?.cancel()
    val payload = HashMap<String, Any?>()
    payload["socketId"] = socketId
    if (reason != null) payload["reason"] = reason
    safeEmit(EVENT_CLOSED, payload)
    Log.i(TAG, "rfcomm closed socket=$socketId reason=$reason")
  }

  private fun internalCloseAll() {
    for (id in servers.keys.toList()) {
      servers.remove(id)?.let { st ->
        try { st.socket.close() } catch (_: Throwable) { /* */ }
        st.job?.cancel()
      }
    }
    for (id in sockets.keys.toList()) {
      sockets.remove(id)?.let { st ->
        try { st.socket.close() } catch (_: Throwable) { /* */ }
        st.readJob?.cancel()
      }
    }
    unregisterDiscoveryReceiver()
  }

  private fun registerDiscoveryReceiver() {
    // synchronized so concurrent start/stopClassicDiscovery (steady-loop inquiry
    // churn + a pair inquiry) can't double-register or race the field set, which
    // threw "receiver already registered" uncaught → JAVA_CRASH.
    synchronized(this) {
      if (discoveryReceiver != null) return
      registerDiscoveryReceiverLocked()
    }
  }

  private fun registerDiscoveryReceiverLocked() {
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
          BluetoothDevice.ACTION_FOUND -> {
            val dev: BluetoothDevice? =
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
              } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
              }
            if (dev != null) {
              val payload = HashMap<String, Any?>()
              payload["mac"] = dev.address
              payload["name"] = try { dev.name } catch (_: Throwable) { null }
              // type so JS can skip BLE-only devices (DEVICE_TYPE_LE = 2) — they
              // can never answer an RFCOMM SDP dial (Briar's d.getType()!=LE filter).
              payload["type"] = try { dev.type } catch (_: Throwable) { -1 }
              safeEmit(EVENT_DEVICE_FOUND, payload)
            }
          }
          BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
            safeEmit(EVENT_DISCOVERY_FINISHED, HashMap<String, Any?>())
          }
        }
      }
    }
    val filter = IntentFilter().apply {
      addAction(BluetoothDevice.ACTION_FOUND)
      addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
    }
    // ACTION_FOUND / ACTION_DISCOVERY_FINISHED are system (protected) broadcasts;
    // RECEIVER_EXPORTED is the correct flag for the Android 14+ requirement.
    // Guarded: a stray double-register must not throw uncaught.
    try {
      ContextCompat.registerReceiver(appCtx, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
      discoveryReceiver = receiver
    } catch (e: Throwable) {
      Log.w(TAG, "registerDiscoveryReceiver failed (already registered?)", e)
    }
  }

  private fun unregisterDiscoveryReceiver() {
    synchronized(this) {
      discoveryReceiver?.let {
        try { appCtx.unregisterReceiver(it) } catch (_: Throwable) { /* */ }
      }
      discoveryReceiver = null
    }
  }
}
