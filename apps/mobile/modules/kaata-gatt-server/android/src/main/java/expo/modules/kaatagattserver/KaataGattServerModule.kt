package expo.modules.kaatagattserver

import android.Manifest
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Debug
import android.os.StatFs
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

private const val TAG = "KaataGattServer"

// Event names — must match the TS EventsMap in src/index.ts.
private const val EVENT_CONNECTED = "onCentralConnected"
private const val EVENT_DISCONNECTED = "onCentralDisconnected"
private const val EVENT_WRITE = "onCentralWrite"
private const val EVENT_MTU = "onMtuChanged"

// Client Characteristic Configuration Descriptor (CCCD) - standard 0x2902.
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

// Notification timeout for the onNotificationSent callback. If the OS never
// fires it (some OEM stacks drop it on disconnect), we time out and let the
// next notification proceed.
private const val NOTIFY_TIMEOUT_MS = 5_000L

// Mobile-Native critique H2 — idle-connect reaper. A central that completes
// link-layer connect but never writes is force-disconnected after this many
// ms. Bounds the connectedDevices map against probe-connects from non-Kaata
// devices and battery-pull stale entries.
private const val IDLE_CONNECT_TIMEOUT_MS = 30_000L

// Cap on simultaneous central connections. Above this, new connects are
// force-cancelled. Defensive — prevents map / mutex growth under attack.
private const val MAX_CONCURRENT_CENTRALS = 8

// Mobile-Native critique M (GATT_BUSY retry). On API 33+ notifyChara…Changed
// can return GATT_BUSY which is transient. Retry up to this many times with
// a short back-off before failing the whole notify.
private const val NOTIFY_BUSY_RETRIES = 3
private const val NOTIFY_BUSY_BACKOFF_MS = 50L

// Mobile-Native critique M2 — wait for onServiceAdded before resolving
// openGattServer. addService is async at the BLE layer; without this gate a
// fast central could race us and find an empty service tree.
private const val SERVICE_ADD_TIMEOUT_MS = 3_000L

// Android GATT_BUSY constant. The android.bluetooth.BluetoothGatt class only
// exposes GATT_SUCCESS / GATT_FAILURE etc. publicly on some API levels —
// hard-coded here against the AOSP value to keep the build green.
private const val GATT_BUSY = 0x84

/**
 * Expo Module wrapping Android's BluetoothGattServer for the Kaata mesh
 * peripheral side. The advertiser (react-native-ble-advertiser) keeps doing
 * its job - radiating a connectable advertisement; this module is the
 * GATT server that actually owns the service tree the central discovers
 * after connecting.
 *
 * JS surface (see src/index.ts):
 *   - openGattServer(serviceUuid, handshakeCharUuid, streamCharUuid)
 *   - closeGattServer()
 *   - notifyCentral(address, charUuid, valueBase64)
 *   - emits onCentralConnected / onCentralWrite / onCentralDisconnected /
 *     onMtuChanged
 */
class KaataGattServerModule : Module() {

  private var scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  // State guarded by stateMutex. Volatile so the callback path on the
  // Binder thread sees the latest writes without entering the suspend
  // mutex (pickCharacteristic / onCharacteristicWriteRequest etc.).
  private val stateMutex = Mutex()
  @Volatile private var gattServer: BluetoothGattServer? = null
  @Volatile private var service: BluetoothGattService? = null
  @Volatile private var handshakeChar: BluetoothGattCharacteristic? = null
  @Volatile private var streamChar: BluetoothGattCharacteristic? = null

  // Resolver for onServiceAdded. Set by openInternal before calling
  // addService, completed by the GATT callback. null when not waiting.
  @Volatile private var serviceAddedResolver: ((Boolean) -> Unit)? = null

  // Engineering critique #2 — class-level mutex serializing
  // characteristic.value mutation on the pre-33 notify path. Without this,
  // concurrent notifies to two different addresses race on the shared
  // BluetoothGattCharacteristic instance and one writes can be smashed by
  // the other before notifyCharacteristicChanged reads it.
  private val pre33NotifyMutex = Mutex()

  // Per-connection state (concurrent so callback path doesn't need the
  // top-level mutex on the binder thread).
  private val connectedDevices = ConcurrentHashMap<String, BluetoothDevice>()
  private val mtuByAddress = ConcurrentHashMap<String, Int>()
  // One mutex per device serializes notification dispatch.
  private val notifyMutexByAddress = ConcurrentHashMap<String, Mutex>()
  // Pending notify resolver, set BEFORE notifyCharacteristicChanged fires.
  // Passes the Int status code from onNotificationSent (GATT_SUCCESS=0,
  // GATT_BUSY=0x84, etc.) so the caller can branch on retry-able codes.
  // Sentinel values for synchronous failures: -1 (pre-33 boolean false),
  // -2 (close drained pending).
  private val pendingNotifyByAddress = ConcurrentHashMap<String, (Int) -> Unit>()
  // Idle-connect reaper: tracks first-valid-write per address so a central
  // that never authenticates is force-disconnected after IDLE timeout.
  private val firstValidWriteAtByAddress = ConcurrentHashMap<String, Long>()

  private val appCtx: Context
    get() = appContext.reactContext
      ?: throw CodedException("E_NO_CONTEXT", "React context unavailable", null)

  override fun definition() = ModuleDefinition {
    Name("KaataGattServer")

    Events(EVENT_CONNECTED, EVENT_DISCONNECTED, EVENT_WRITE, EVENT_MTU)

    AsyncFunction("openGattServer") { serviceUuid: String, handshakeCharUuid: String, streamCharUuid: String, promise: Promise ->
      scope.launch {
        try {
          ensureBluetoothConnectPermission()
          stateMutex.withLock {
            // Idempotent: tear down any prior server, then open fresh.
            internalClose()
            openInternal(
              UUID.fromString(serviceUuid),
              UUID.fromString(handshakeCharUuid),
              UUID.fromString(streamCharUuid),
            )
          }
          promise.resolve(null)
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          Log.w(TAG, "openGattServer failed", e)
          promise.reject(CodedException("E_OPEN_FAILED", e.message ?: "openGattServer failed", e))
        }
      }
    }

    AsyncFunction("closeGattServer") { promise: Promise ->
      scope.launch {
        try {
          stateMutex.withLock { internalClose() }
          promise.resolve(null)
        } catch (e: Throwable) {
          Log.w(TAG, "closeGattServer failed", e)
          promise.reject(CodedException("E_CLOSE_FAILED", e.message ?: "closeGattServer failed", e))
        }
      }
    }

    AsyncFunction("notifyCentral") { address: String, charUuid: String, valueBase64: String, promise: Promise ->
      scope.launch {
        try {
          val device = connectedDevices[address]
            ?: throw CodedException("E_NOT_CONNECTED", "No central at $address", null)
          val server = gattServer
            ?: throw CodedException("E_NOT_OPEN", "GATT server not open", null)
          val targetChar = pickCharacteristic(UUID.fromString(charUuid))
            ?: throw CodedException("E_UNKNOWN_CHAR", "Unknown characteristic $charUuid", null)

          val payload = Base64.decode(valueBase64, Base64.NO_WRAP)
          val ok = sendNotification(server, device, targetChar, payload)
          if (ok) {
            promise.resolve(null)
          } else {
            throw CodedException("E_NOTIFY_FAILED", "notifyCharacteristicChanged failed", null)
          }
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          Log.w(TAG, "notifyCentral failed", e)
          promise.reject(CodedException("E_NOTIFY_FAILED", e.message ?: "notifyCentral failed", e))
        }
      }
    }

    AsyncFunction("disconnectCentral") { address: String, promise: Promise ->
      scope.launch {
        try {
          val device = connectedDevices[address]
          val server = gattServer
          if (device != null && server != null) {
            try {
              server.cancelConnection(device)
            } catch (_: Throwable) { /* idempotent */ }
          }
          promise.resolve(null)
        } catch (e: Throwable) {
          promise.reject(CodedException("E_DISCONNECT_FAILED", e.message ?: "disconnectCentral failed", e))
        }
      }
    }

    AsyncFunction("getConnectedCentrals") { promise: Promise ->
      try {
        promise.resolve(connectedDevices.keys.toList())
      } catch (e: Throwable) {
        promise.reject(CodedException("E_LIST_FAILED", e.message ?: "getConnectedCentrals failed", e))
      }
    }

    // Mythos crash-diagnosis instrumentation. These two Functions have
    // NOTHING to do with the GATT server — they're parked here because the
    // module scaffolding already works and a separate native module is
    // overkill for two read-only OS queries. Rename/relocate later.

    // getLastExitReasons: ApplicationExitInfo (API 30+). On every launch the
    // app can ask the OS EXACTLY why its previous process died — LOW_MEMORY
    // (LMK/OOM verdict), JAVA_CRASH, NATIVE_CRASH (Hermes abort), ANR,
    // EXCESSIVE_RESOURCE (OEM killer) — plus RSS at death. This is THE
    // confirming measurement: it replaces every crash hypothesis with a
    // verdict, no adb required.
    Function("getLastExitReasons") {
      if (Build.VERSION.SDK_INT < 30) return@Function emptyList<Map<String, Any?>>()
      val ctx = appContext.reactContext ?: return@Function emptyList<Map<String, Any?>>()
      val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      am.getHistoricalProcessExitReasons(ctx.packageName, 0, 8).map { info ->
        mapOf(
          "timestamp" to info.timestamp,
          "reason" to info.reason,
          "reasonName" to when (info.reason) {
            ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
            ApplicationExitInfo.REASON_CRASH -> "JAVA_CRASH"
            ApplicationExitInfo.REASON_CRASH_NATIVE -> "NATIVE_CRASH"
            ApplicationExitInfo.REASON_ANR -> "ANR"
            ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
            ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE"
            ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
            ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
            else -> "OTHER_${info.reason}"
          },
          "description" to (info.description ?: ""),
          "rssKb" to info.rss,
          "pssKb" to info.pss,
          "importance" to info.importance,
        )
      }
    }

    // getMemorySnapshot: the per-minute sample. nativePss vs dalvikPss is the
    // slope that convicts native (BLE/WebRTC) vs JS/Java retention.
    // storageFreeMb settles whether the Samsung "Clear cache" prompt was
    // really a low-STORAGE warning rather than RAM.
    Function("getMemorySnapshot") {
      val ctx = appContext.reactContext ?: return@Function emptyMap<String, Any?>()
      val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val dmi = Debug.MemoryInfo()
      Debug.getMemoryInfo(dmi)
      val ami = ActivityManager.MemoryInfo()
      am.getMemoryInfo(ami)
      val rt = Runtime.getRuntime()
      mapOf(
        "totalPssKb" to dmi.totalPss,
        "nativePssKb" to dmi.nativePss,
        "dalvikPssKb" to dmi.dalvikPss,
        "nativeHeapAllocKb" to (Debug.getNativeHeapAllocatedSize() / 1024).toInt(),
        "javaHeapUsedKb" to ((rt.totalMemory() - rt.freeMemory()) / 1024).toInt(),
        "systemAvailMemMb" to (ami.availMem / 1048576).toInt(),
        "systemLowMemory" to ami.lowMemory,
        "storageFreeMb" to (StatFs(ctx.filesDir.absolutePath).availableBytes / 1048576).toInt(),
      )
    }

    OnDestroy {
      // Engineering critique #6 — cancel scope so coroutines don't leak on
      // HMR / module rebinds. The close runs synchronously-ish on a fresh
      // throwaway scope because the main scope is being torn down.
      val priorScope = scope
      val teardownScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
      teardownScope.launch {
        try {
          stateMutex.withLock { internalClose() }
        } catch (_: Throwable) { /* */ }
        try { priorScope.cancel() } catch (_: Throwable) { /* */ }
        try { teardownScope.cancel() } catch (_: Throwable) { /* */ }
      }
      // Replace scope so any subsequent definition() runs (unlikely but
      // possible on HMR) use a live scope.
      scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private fun ensureBluetoothConnectPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    val granted = ContextCompat.checkSelfPermission(
      appCtx,
      Manifest.permission.BLUETOOTH_CONNECT,
    ) == PackageManager.PERMISSION_GRANTED
    if (!granted) {
      throw CodedException(
        "E_BLUETOOTH_CONNECT_DENIED",
        "BLUETOOTH_CONNECT runtime permission not granted",
        null,
      )
    }
  }

  // Caller MUST hold stateMutex.
  private suspend fun openInternal(
    serviceUuid: UUID,
    handshakeUuid: UUID,
    streamUuid: UUID,
  ) {
    val btManager = appCtx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
      ?: throw CodedException("E_NO_BT", "BluetoothManager unavailable", null)

    val server: BluetoothGattServer = try {
      btManager.openGattServer(appCtx, callback)
        ?: throw CodedException("E_OPEN_FAILED", "openGattServer returned null", null)
    } catch (sec: SecurityException) {
      throw CodedException("E_BLUETOOTH_CONNECT_DENIED", sec.message ?: "openGattServer SecurityException", sec)
    }

    val svc = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)

    // PERMISSION_WRITE (NOT _WRITE_ENCRYPTED) keeps the OS pair dialog from
    // firing - the link is unauthenticated, which is fine because the upper
    // layer runs its own X25519+ChaCha20-Poly1305 + PoP handshake.
    val props = BluetoothGattCharacteristic.PROPERTY_WRITE or
      BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
      BluetoothGattCharacteristic.PROPERTY_NOTIFY or
      BluetoothGattCharacteristic.PROPERTY_READ
    val perms = BluetoothGattCharacteristic.PERMISSION_WRITE or
      BluetoothGattCharacteristic.PERMISSION_READ

    val hs = BluetoothGattCharacteristic(handshakeUuid, props, perms)
    hs.addDescriptor(
      BluetoothGattDescriptor(
        CCCD_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )

    val st = BluetoothGattCharacteristic(streamUuid, props, perms)
    st.addDescriptor(
      BluetoothGattDescriptor(
        CCCD_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )

    svc.addCharacteristic(hs)
    svc.addCharacteristic(st)

    // Install the volatile state BEFORE addService so the callback can find
    // the server / service pointers when onServiceAdded fires.
    gattServer = server
    service = svc
    handshakeChar = hs
    streamChar = st

    // Wait for onServiceAdded before considering the server ready. addService
    // is queued at the BLE layer — a racing central could otherwise dial and
    // walk an empty service tree.
    val added = withTimeoutOrNull(SERVICE_ADD_TIMEOUT_MS) {
      suspendCancellableCoroutine<Boolean> { cont ->
        serviceAddedResolver = { ok ->
          if (cont.isActive) cont.resumeWith(Result.success(ok))
        }
        val queued = try {
          server.addService(svc)
        } catch (sec: SecurityException) {
          serviceAddedResolver = null
          if (cont.isActive) cont.resumeWith(Result.failure(sec))
          return@suspendCancellableCoroutine
        }
        if (!queued) {
          serviceAddedResolver = null
          if (cont.isActive) cont.resumeWith(Result.success(false))
        }
      }
    }
    serviceAddedResolver = null
    if (added != true) {
      // Roll back partial state and close the server before failing.
      gattServer = null
      this.service = null
      handshakeChar = null
      streamChar = null
      try { server.close() } catch (_: Throwable) { /* */ }
      throw CodedException(
        "E_OPEN_FAILED",
        if (added == null) "addService timed out" else "addService returned false",
        null,
      )
    }
    Log.i(TAG, "GATT server opened service=$serviceUuid handshake=$handshakeUuid stream=$streamUuid")
  }

  // Caller MUST hold stateMutex.
  private fun internalClose() {
    val server = gattServer ?: return
    try {
      for (dev in connectedDevices.values.toList()) {
        try { server.cancelConnection(dev) } catch (_: Throwable) { /* */ }
      }
      service?.let {
        try { server.removeService(it) } catch (_: Throwable) { /* */ }
      }
      try { server.close() } catch (_: Throwable) { /* */ }
    } finally {
      gattServer = null
      service = null
      handshakeChar = null
      streamChar = null
      connectedDevices.clear()
      mtuByAddress.clear()
      notifyMutexByAddress.clear()
      firstValidWriteAtByAddress.clear()
      // Engineering critique #7 — snapshot AND clear the pending-notify map
      // BEFORE resolving so any in-flight coroutine that lost the race
      // doesn't reinstall its resolver into an already-cleared map.
      val pending = pendingNotifyByAddress.toMap()
      pendingNotifyByAddress.clear()
      for ((_, resolve) in pending) {
        try { resolve(-2) } catch (_: Throwable) { /* */ }
      }
      // Resolve any pending onServiceAdded waiter as failure so the
      // suspending openInternal returns instead of hanging until timeout.
      try { serviceAddedResolver?.invoke(false) } catch (_: Throwable) { /* */ }
      serviceAddedResolver = null
      Log.i(TAG, "GATT server closed")
    }
  }

  private fun pickCharacteristic(uuid: UUID): BluetoothGattCharacteristic? {
    // Snapshot to local vars so a concurrent close() / openInternal() can't
    // null them between the when-arm match and the return.
    val hs = handshakeChar
    val st = streamChar
    return when (uuid) {
      hs?.uuid -> hs
      st?.uuid -> st
      else -> null
    }
  }

  // Serializes notifications per-device; awaits onNotificationSent.
  private suspend fun sendNotification(
    server: BluetoothGattServer,
    device: BluetoothDevice,
    characteristic: BluetoothGattCharacteristic,
    value: ByteArray,
  ): Boolean {
    val mutex = notifyMutexByAddress.getOrPut(device.address) { Mutex() }
    return mutex.withLock {
      // Mobile-Native critique M3 — verify the device we hold is still the
      // currently-connected device. Between getOrPut and now a disconnect /
      // reconnect could have replaced the BluetoothDevice ref; we'd
      // otherwise notify into the dead session.
      val current = connectedDevices[device.address]
      if (current == null || current !== device) {
        return@withLock false
      }
      var attempt = 0
      var ok = false
      while (true) {
        // Install the resolver BEFORE issuing the notify so we don't race
        // the callback (Android binder thread). Sentinel codes:
        //   GATT_SUCCESS=0, GATT_BUSY=0x84, -1=synchronous issue failure,
        //   -2=close drained pending.
        val deferred = CompletableDeferred<Int>()
        pendingNotifyByAddress[device.address] = { status ->
          deferred.complete(status)
        }
        val issuedStatus = issueNotify(server, device, characteristic, value)
        if (issuedStatus == null) {
          // Pre-33 boolean false OR caught exception — synchronous failure.
          pendingNotifyByAddress.remove(device.address)
          deferred.complete(-1)
        } else if (issuedStatus != BluetoothGatt.GATT_SUCCESS) {
          // API 33+: synchronous non-success status (e.g.
          // GATT_INVALID_ATTRIBUTE_LENGTH, GATT_BUSY). onNotificationSent
          // will NOT fire in this case.
          pendingNotifyByAddress.remove(device.address)
          deferred.complete(issuedStatus)
        }
        // else: notify queued; wait for onNotificationSent via deferred.

        val result = withTimeoutOrNull(NOTIFY_TIMEOUT_MS) { deferred.await() }
        pendingNotifyByAddress.remove(device.address)

        if (result == BluetoothGatt.GATT_SUCCESS) {
          ok = true
          break
        }
        if (result == GATT_BUSY && attempt < NOTIFY_BUSY_RETRIES) {
          attempt++
          delay(NOTIFY_BUSY_BACKOFF_MS)
          // Verify device is still connected before retrying.
          val stillThere = connectedDevices[device.address]
          if (stillThere == null || stillThere !== device) {
            ok = false
            break
          }
          continue
        }
        ok = false
        break
      }
      ok
    }
  }

  // API-33 split for notifyCharacteristicChanged.
  // Returns the Int status code from the 4-arg API (33+), OR null on the
  // pre-33 boolean path to signal "synchronous boolean failure" upstream.
  @Suppress("DEPRECATION")
  private suspend fun issueNotify(
    server: BluetoothGattServer,
    device: BluetoothDevice,
    characteristic: BluetoothGattCharacteristic,
    value: ByteArray,
  ): Int? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        // API 33+: 4-arg form takes the byte[] directly, returns Int status.
        server.notifyCharacteristicChanged(device, characteristic, false, value)
      } else {
        // Pre-33: setValue() then 3-arg form returning Boolean. Engineering
        // critique #2 — serialize the shared characteristic mutation +
        // notify call under a class-level mutex so concurrent multi-central
        // notifies don't race on characteristic.value.
        pre33NotifyMutex.withLock {
          characteristic.value = value
          val ok = server.notifyCharacteristicChanged(device, characteristic, false)
          if (ok) BluetoothGatt.GATT_SUCCESS else null
        }
      }
    } catch (_: SecurityException) {
      null
    } catch (e: Throwable) {
      Log.w(TAG, "issueNotify failed", e)
      null
    }
  }

  // Spawn the idle-connect reaper: if no valid Kaata write arrives within
  // IDLE_CONNECT_TIMEOUT_MS, force-disconnect the central.
  private fun scheduleIdleReap(device: BluetoothDevice) {
    val address = device.address
    scope.launch {
      delay(IDLE_CONNECT_TIMEOUT_MS)
      val firstWriteAt = firstValidWriteAtByAddress[address]
      val stillConnected = connectedDevices[address]
      // If we never recorded a valid write AND we're still connected, reap.
      if (firstWriteAt == null && stillConnected != null && stillConnected === device) {
        val server = gattServer
        if (server != null) {
          Log.i(TAG, "idle reaper force-disconnecting addr=$address (no valid write within ${IDLE_CONNECT_TIMEOUT_MS}ms)")
          try { server.cancelConnection(device) } catch (_: Throwable) { /* */ }
        }
      }
    }
  }

  // Clear per-address state for a given address. Used by both rapid-reconnect
  // (in onConnectionStateChange.STATE_CONNECTED if address already present)
  // and the STATE_DISCONNECTED handler.
  private fun clearPerAddressState(address: String) {
    mtuByAddress.remove(address)
    notifyMutexByAddress.remove(address)
    firstValidWriteAtByAddress.remove(address)
    pendingNotifyByAddress.remove(address)?.invoke(-2)
  }

  // ---------------------------------------------------------------------------
  // GATT callback - runs on Binder thread. Keep work tiny.
  // ---------------------------------------------------------------------------

  private val callback = object : BluetoothGattServerCallback() {

    override fun onServiceAdded(status: Int, svc: BluetoothGattService) {
      val ok = status == BluetoothGatt.GATT_SUCCESS && svc.uuid == service?.uuid
      try { serviceAddedResolver?.invoke(ok) } catch (_: Throwable) { /* */ }
    }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      val address = device.address
      when (newState) {
        BluetoothProfile.STATE_CONNECTED -> {
          // Mobile-Native critique H3 — rapid-reconnect handling. If the
          // same MAC was already in the map (Android sometimes delivers
          // STATE_CONNECTED twice on MTU renegotiation, or after a fast
          // disconnect/reconnect we never saw STATE_DISCONNECTED for), tear
          // down the prior per-address state so the fresh session doesn't
          // inherit stale mutex / pending-notify entries.
          if (connectedDevices.containsKey(address)) {
            Log.w(TAG, "STATE_CONNECTED for already-tracked addr=$address — replacing")
            clearPerAddressState(address)
          }
          // Cap concurrent connections. Reject above the limit.
          if (connectedDevices.size >= MAX_CONCURRENT_CENTRALS) {
            Log.w(TAG, "STATE_CONNECTED at MAX_CONCURRENT_CENTRALS — refusing addr=$address")
            val server = gattServer
            if (server != null) {
              try { server.cancelConnection(device) } catch (_: Throwable) { /* */ }
            }
            return
          }
          connectedDevices[address] = device
          mtuByAddress[address] = 23 // Android default until onMtuChanged
          val payload = HashMap<String, Any?>()
          payload["address"] = address
          payload["mtu"] = 23
          sendEvent(EVENT_CONNECTED, payload)
          // Start the idle reaper.
          scheduleIdleReap(device)
          Log.i(TAG, "central connected addr=$address status=$status")
        }
        BluetoothProfile.STATE_DISCONNECTED -> {
          connectedDevices.remove(address)
          clearPerAddressState(address)
          val payload = HashMap<String, Any?>()
          payload["address"] = address
          payload["status"] = status
          sendEvent(EVENT_DISCONNECTED, payload)
          Log.i(TAG, "central disconnected addr=$address status=$status")
        }
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      mtuByAddress[device.address] = mtu
      val payload = HashMap<String, Any?>()
      payload["address"] = device.address
      payload["mtu"] = mtu
      sendEvent(EVENT_MTU, payload)
      Log.i(TAG, "central mtu addr=${device.address} mtu=$mtu")
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      val server = gattServer
      // ACK first so the central is unblocked while JS processes the chunk.
      // Track whether the ACK succeeded — if it threw, the link is dropping
      // anyway and the central will never see this write; suppress the
      // event to avoid double-processing on the central's retry.
      var ackOk = true
      if (responseNeeded && server != null) {
        try {
          server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
        } catch (_: Throwable) {
          ackOk = false
        }
      }
      if (!ackOk) return

      // Mark "first valid write" so the idle reaper doesn't disconnect this
      // central. We only count writes to our known characteristics — random
      // writes to other handles don't count as Kaata-protocol traffic.
      val charUuid = characteristic.uuid
      val isKaataChar = charUuid == handshakeChar?.uuid || charUuid == streamChar?.uuid
      if (isKaataChar) {
        firstValidWriteAtByAddress.putIfAbsent(device.address, SystemClock.elapsedRealtime())
      }

      val b64 = Base64.encodeToString(value, Base64.NO_WRAP)
      val payload = HashMap<String, Any?>()
      payload["address"] = device.address
      payload["charUuid"] = charUuid.toString()
      payload["valueBase64"] = b64
      sendEvent(EVENT_WRITE, payload)
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      // CCCD writes (subscribe / unsubscribe). Just ACK; we don't track the
      // subscription state because we always allow notifications - the peer's
      // monitorCharacteristicForService side toggles it for us.
      val server = gattServer
      if (responseNeeded && server != null) {
        try {
          server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
        } catch (_: Throwable) { /* */ }
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      // Pass the raw status into the resolver so retry logic can distinguish
      // GATT_BUSY (retryable) from GATT_SUCCESS / other (fatal).
      pendingNotifyByAddress.remove(device.address)?.invoke(status)
    }

    override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
      // Prepared writes unused by Kaata protocol; just ACK.
      try {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      } catch (_: Throwable) { /* */ }
    }
  }
}
