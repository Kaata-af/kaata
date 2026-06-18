package expo.modules.kaatabtclassic.mesh.plugin.plugins

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.content.Context
import android.util.Log
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import expo.modules.kaatabtclassic.mesh.MeshConnection
import expo.modules.kaatabtclassic.mesh.MeshDb
import expo.modules.kaatabtclassic.mesh.MeshDiscovery
import expo.modules.kaatabtclassic.mesh.MeshEngine
import expo.modules.kaatabtclassic.mesh.plugin.PluginState
import expo.modules.kaatabtclassic.mesh.plugin.TransportId
import expo.modules.kaatabtclassic.mesh.plugin.TransportPlugin
import expo.modules.kaatabtclassic.mesh.plugin.TransportPluginCallback

/**
 * Bluetooth Classic (RFCOMM) transport plugin — Briar-port phase 1.
 *
 * Holds the BT-specific accept + dial logic that used to live inline in
 * MeshEngine.runWindow. Same behavior (multi-day rendezvous UUIDs, continuous
 * accept, exponential dial backoff, per-vault session dedup), restructured behind
 * the TransportPlugin seam so it's interchangeable with the coming LAN + hotspot
 * plugins. RESIDENT: start() opens accept servers + dial loops that run until
 * stop() (bounded by a stop flag, not a window deadline); the phase-1 runWindow
 * shim just start()s for maxMs then stop()s. Sessions themselves are capped by
 * SESSION_MAX_MS. All session work routes through MeshEngine.runSession (the shared
 * transport-agnostic seam: handshake + anti-entropy + strong trust gate).
 */
class BtcRfcommPlugin(
  private val context: Context,
  private val callback: TransportPluginCallback,
) : TransportPlugin {

  override val id = TransportId.BLUETOOTH

  @Volatile private var stopped = false
  @Volatile private var pluginState = PluginState.INACTIVE
  private val servers = CopyOnWriteArrayList<BluetoothServerSocket>()

  override fun state(): PluginState = pluginState

  override fun start() {
    if (pluginState == PluginState.ACTIVE || pluginState == PluginState.STARTING) return
    stopped = false
    setState(PluginState.STARTING)
    val adapter =
      (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    if (adapter == null) {
      Log.i(TAG, "start: no bluetooth adapter — bail")
      setState(PluginState.DISABLED)
      return
    }
    if (!adapter.isEnabled) {
      Log.i(TAG, "start: bluetooth is OFF — bail")
      setState(PluginState.INACTIVE)
      return
    }
    val ctx = MeshEngine.loadEngineContext(context)
    if (ctx == null) {
      setState(PluginState.INACTIVE)
      return
    }

    val now = System.currentTimeMillis()
    // MULTI-DAY rendezvous: advertise on today+tomorrow, dial across
    // yesterday/today/tomorrow, so clock skew / a UTC-midnight boundary still meet.
    val advertiseDays = MeshDiscovery.advertiseDays(now)
    val scanDays = MeshDiscovery.acceptableScanDays(now)

    // ACCEPT: one resident server per (vault, advertiseDay) UUID; near-continuous
    // listening so a peer's dial lands whenever it sweeps.
    for (v in ctx.vaults) {
      for (d in advertiseDays) {
        try {
          val uuid = UUID.fromString(MeshDiscovery.steadyUuid(v.id, d))
          val server = adapter.listenUsingInsecureRfcommWithServiceRecord(SERVICE_NAME, uuid)
          servers.add(server)
          Thread({ acceptLoop(server, ctx.identity, v) }, "kaata-mesh-accept")
            .apply { isDaemon = true }
            .start()
        } catch (e: Throwable) {
          Log.w(TAG, "listen failed v=${v.id} d=$d", e)
        }
      }
    }

    // Bonded devices are a cheap extra dial candidate (insecure RFCOMM doesn't
    // bond, so cached MACs are the real source — but enumeration is free).
    val bonded =
      try {
        adapter.bondedDevices?.mapNotNull { it.address } ?: emptyList()
      } catch (e: Throwable) {
        emptyList()
      }

    // DIAL: one resident loop per vault, exponential-backoff sweeps.
    for (v in ctx.vaults) {
      val cached = ctx.peersByVault[v.id].orEmpty()
      Thread({ dialLoop(adapter, ctx.identity, v, scanDays, cached, bonded) }, "kaata-mesh-dial")
        .apply { isDaemon = true }
        .start()
    }

    setState(PluginState.ACTIVE)
    Log.i(TAG, "active on ${ctx.vaults.size} vault(s)")
  }

  override fun stop() {
    stopped = true
    // Closing each server unblocks its accept() so the accept loop exits.
    for (s in servers) {
      try {
        s.close()
      } catch (e: Throwable) {
        /* */
      }
    }
    servers.clear()
    setState(PluginState.INACTIVE)
  }

  /** Phase 1: the dial loop runs continuously while started, so an explicit poll
   *  is a no-op. Phase 2's Poller drives outbound sweeps through here. */
  override fun poll() {}

  private fun setState(s: PluginState) {
    pluginState = s
    try {
      callback.onStateChanged(id, s)
    } catch (e: Throwable) {
      /* a misbehaving callback must never break the transport */
    }
  }

  private fun acceptLoop(server: BluetoothServerSocket, identity: MeshEngine.Identity, vault: MeshDb.Vault) {
    val db =
      try {
        MeshDb.open(context)
      } catch (e: Throwable) {
        return
      }
    try {
      while (!stopped) {
        val socket =
          try {
            server.accept() // blocks until a peer dials OR stop() closes the server
          } catch (e: Throwable) {
            break // server closed (stop) or fatal
          }
        if (stopped) {
          try {
            socket.close()
          } catch (e: Throwable) {
            /* */
          }
          break
        }
        val peerMac = try { socket.remoteDevice?.address } catch (e: Throwable) { null }
        MeshEngine.runSession(
          MeshConnection.fromBluetooth(socket, peerMac),
          db,
          identity,
          vault,
          System.currentTimeMillis() + SESSION_MAX_MS,
          peerMac,
        )
      }
    } finally {
      db.close()
    }
  }

  private fun dialLoop(
    adapter: BluetoothAdapter,
    identity: MeshEngine.Identity,
    vault: MeshDb.Vault,
    scanDays: List<Long>,
    cached: List<String>,
    bonded: List<String>,
  ) {
    val db =
      try {
        MeshDb.open(context)
      } catch (e: Throwable) {
        return
      }
    try {
      val dayUuids =
        scanDays.mapNotNull {
          try {
            UUID.fromString(MeshDiscovery.steadyUuid(vault.id, it))
          } catch (e: Throwable) {
            null
          }
        }
      var backoff = DIAL_SWEEP_MIN_MS
      while (!stopped) {
        // Already syncing this vault? don't pile on a redundant dial.
        if (MeshEngine.hasActiveSessionForVault(vault.id)) {
          if (!sleepInterruptible(backoff)) break
          continue
        }
        val candidates = LinkedHashSet<String>()
        candidates.addAll(cached)
        candidates.addAll(bonded)
        var connectedThisSweep = false
        for (mac in candidates) {
          if (stopped) break
          if (!db.isDialableMac(mac)) continue
          for (uuid in dayUuids) {
            if (stopped) break
            if (tryDial(adapter, mac, uuid, db, identity, vault)) {
              connectedThisSweep = true
              break
            }
          }
        }
        if (stopped) break
        backoff =
          if (connectedThisSweep) DIAL_SWEEP_MIN_MS else minOf(backoff * 2, DIAL_SWEEP_MAX_MS)
        if (!sleepInterruptible(backoff)) break
      }
    } finally {
      db.close()
    }
  }

  private fun tryDial(
    adapter: BluetoothAdapter,
    mac: String,
    uuid: UUID,
    db: MeshDb,
    identity: MeshEngine.Identity,
    vault: MeshDb.Vault,
  ): Boolean {
    if (stopped) return false
    return try {
      adapter.cancelDiscovery()
      val device = adapter.getRemoteDevice(mac)
      val socket = device.createInsecureRfcommSocketToServiceRecord(uuid)
      socket.connect() // blocks; throws if peer isn't listening on this UUID
      MeshEngine.runSession(
        MeshConnection.fromBluetooth(socket, mac),
        db,
        identity,
        vault,
        System.currentTimeMillis() + SESSION_MAX_MS,
        mac,
      )
      true
    } catch (e: Throwable) {
      Log.d(TAG, "dial $mac failed: ${e.message}")
      false
    }
  }

  /** Sleep, returning false if interrupted (caller should exit the loop). */
  private fun sleepInterruptible(ms: Long): Boolean =
    try {
      Thread.sleep(ms)
      true
    } catch (e: InterruptedException) {
      false
    }

  companion object {
    private const val TAG = "BtcRfcommPlugin"
    private const val SERVICE_NAME = "kaata-steady"
    // Exponential dial-sweep backoff (Briar BackoffImpl style): fast first probe,
    // grow toward 30s when nobody answers, reset to the floor on a connect.
    private const val DIAL_SWEEP_MIN_MS = 2_000L
    private const val DIAL_SWEEP_MAX_MS = 30_000L
    // Per-session cap (handshake + one anti-entropy delta). Independent of the
    // plugin lifetime so a resident plugin doesn't run unbounded sessions.
    private const val SESSION_MAX_MS = 60_000L
  }
}
