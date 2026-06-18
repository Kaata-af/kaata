package expo.modules.kaatabtclassic.mesh

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.content.Context
import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Native mesh engine — Briar-parity step 13, the driver. This is Briar's model:
 * plain JVM threads doing RFCOMM accept + dial inside the foreground-service
 * process, running the proven protocol modules (handshake -> anti-entropy), with
 * NO JS runtime in the loop.
 *
 * runWindow(context, maxMs): for every chain-anchored vault, listen on the
 * per-(vault,day) steady UUID (MeshDiscovery) and dial each cached peer MAC; each
 * accepted/dialed socket is wrapped in a MeshConnection and run through
 * MeshHandshake then MeshAntiEntropy, then closed. Per-(peer,vault) session dedup.
 * Bounded by maxMs.
 *
 * DARK + GATED: nothing calls this yet. It ships present-but-inert exactly like
 * the other native modules; the FGS wiring + cutover (replacing the headless-JS
 * background path) is a separate, device-test-gated step. Self-sufficient: reads
 * the device seed (KeystoreSeedStore), identity (app_meta), peers (app_meta), and
 * the ledger (MeshDb) with a plain Context — works after a swipe-kill.
 *
 * Only validatable on a 2-phone device test (Bluetooth + threading + the full
 * session); the protocol pieces it composes are all parity-proven.
 */
object MeshEngine {
  private const val TAG = "MeshEngine"
  private const val SERVICE_NAME = "kaata-steady"
  // Dial-sweep backoff bounds (exponential, Briar BackoffImpl style): start fast
  // so a present peer connects in ~2s, grow toward 30s when nobody answers so a
  // lone phone doesn't burn the radio. Reset to the floor on a successful connect.
  private const val DIAL_SWEEP_MIN_MS = 2_000L
  private const val DIAL_SWEEP_MAX_MS = 30_000L

  /** "<peerDeviceId>:<vaultId>" of sessions in flight — never two at once. */
  private val activeSessions = ConcurrentHashMap.newKeySet<String>()

  /** Is a session (accept or dial) already running for this vault? Used to skip
   *  redundant dials while a sync is in flight. */
  private fun hasActiveSessionForVault(vaultId: String): Boolean =
    activeSessions.any { it.endsWith(":$vaultId") }

  private data class Identity(
    val seed: ByteArray,
    val pubkeyB64: String,
    val deviceId: String,
    val accountId: String,
  )

  fun runWindow(context: Context, maxMs: Long) {
    // Observability (#43): every precondition logs WHY it bailed at Log.i so the
    // on-device tester (logcat tag "MeshEngine") can tell "ran and synced" from
    // "never ran" from "ran but bailed on <reason>". No behavior change.
    Log.i(TAG, "runWindow: start (maxMs=$maxMs)")
    val adapter =
      (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    if (adapter == null) {
      Log.i(TAG, "runWindow: no bluetooth adapter — bail")
      return
    }
    if (!adapter.isEnabled) {
      Log.i(TAG, "runWindow: bluetooth is OFF — bail")
      return
    }

    val setupDb =
      try {
        MeshDb.open(context)
      } catch (e: Throwable) {
        Log.w(TAG, "open db failed", e)
        return
      }
    val identity: Identity
    val vaults: List<MeshDb.Vault>
    val peersByVault: Map<String, List<String>>
    try {
      val loaded = loadIdentity(setupDb, context)
      if (loaded == null) {
        Log.i(TAG, "runWindow: no device identity (seed/pubkey/install_id) — bail")
        return
      }
      identity = loaded
      vaults = setupDb.listSyncableVaults()
      peersByVault =
        vaults.associate { v ->
          v.id to setupDb.knownPeers(v.id).map { it.mac }.filter { setupDb.isDialableMac(it) }
        }
    } finally {
      setupDb.close()
    }
    if (vaults.isEmpty()) {
      Log.i(TAG, "runWindow: no syncable vaults — bail")
      return
    }
    Log.i(TAG, "runWindow: opening accept/dial on ${vaults.size} vault(s)")

    val now = System.currentTimeMillis()
    val deadline = now + maxMs
    // MULTI-DAY rendezvous: ADVERTISE on today+tomorrow's UUIDs and DIAL across
    // yesterday/today/tomorrow, so two phones with clock skew or straddling a UTC
    // midnight still meet on a shared UUID (the helpers are parity-tested; the
    // engine just wasn't using them — it pinned a single UTC day before).
    val advertiseDays = MeshDiscovery.advertiseDays(now)
    val scanDays = MeshDiscovery.acceptableScanDays(now)
    val servers = ArrayList<BluetoothServerSocket>()

    // ACCEPT: keep a server up for the WHOLE window on each (vault, advertiseDay)
    // UUID — continuous listening means a peer's dial lands whenever it sweeps,
    // instead of needing to hit a single 60s/90s window edge.
    for (v in vaults) {
      for (d in advertiseDays) {
        try {
          val uuid = UUID.fromString(MeshDiscovery.steadyUuid(v.id, d))
          val server = adapter.listenUsingInsecureRfcommWithServiceRecord(SERVICE_NAME, uuid)
          servers.add(server)
          Thread({ acceptLoop(server, context, identity, v, deadline) }, "kaata-mesh-accept")
            .apply { isDaemon = true }
            .start()
        } catch (e: Throwable) {
          Log.w(TAG, "listen failed v=${v.id} d=$d", e)
        }
      }
    }

    // OS-level bonded devices are a cheap extra dial candidate (no radio cost to
    // enumerate) for the case where btc_known_peers is empty but the phones are
    // bonded. Insecure RFCOMM pairing doesn't bond, so this rarely helps the
    // kaata flow — cached MACs are the primary source — but it's free.
    val bonded =
      try {
        adapter.bondedDevices?.mapNotNull { it.address } ?: emptyList()
      } catch (e: Throwable) {
        emptyList()
      }

    // DIAL: one loop per vault. Each loop re-sweeps its candidate MACs across the
    // scan-day UUIDs and RETRIES on a short backoff until the deadline — so a dial
    // that misses the peer (peer momentarily busy / between accepts) is recovered
    // within seconds instead of waiting for the next 90s FGS tick.
    for (v in vaults) {
      val cached = peersByVault[v.id].orEmpty()
      Thread({ dialLoop(context, adapter, identity, v, scanDays, cached, bonded, deadline) },
        "kaata-mesh-dial")
        .apply { isDaemon = true }
        .start()
    }

    // Hold the window open; closing the servers unblocks the accept loops.
    val wait = deadline - System.currentTimeMillis()
    if (wait > 0) {
      try {
        Thread.sleep(wait)
      } catch (e: InterruptedException) {
        /* */
      }
    }
    for (s in servers) {
      try {
        s.close()
      } catch (e: Throwable) {
        /* */
      }
    }
  }

  private fun loadIdentity(db: MeshDb, ctx: Context): Identity? {
    val seed = KeystoreSeedStore.getSeed(ctx)
    if (seed == null) {
      Log.i(TAG, "loadIdentity: device seed absent from keystore (setMeshDeviceSeed never ran?)")
      return null
    }
    if (seed.size != 32) {
      Log.i(TAG, "loadIdentity: device seed wrong size ${seed.size}")
      return null
    }
    val pub = db.getAppMeta("mesh_device_ed25519_pubkey")
    if (pub == null) {
      Log.i(TAG, "loadIdentity: app_meta.mesh_device_ed25519_pubkey missing")
      return null
    }
    val deviceId = db.getAppMeta("install_id")
    if (deviceId == null) {
      Log.i(TAG, "loadIdentity: app_meta.install_id missing")
      return null
    }
    val account =
      db.getAppMeta("account_id")
        ?: try {
          MeshHandshake.buildLocalAccountId(pub)
        } catch (e: Throwable) {
          return null
        }
    return Identity(seed, pub, deviceId, account)
  }

  private fun acceptLoop(
    server: BluetoothServerSocket,
    ctx: Context,
    identity: Identity,
    vault: MeshDb.Vault,
    deadline: Long,
  ) {
    val db =
      try {
        MeshDb.open(ctx)
      } catch (e: Throwable) {
        return
      }
    try {
      while (System.currentTimeMillis() < deadline) {
        val remaining = (deadline - System.currentTimeMillis()).toInt()
        if (remaining <= 0) break
        val socket =
          try {
            server.accept(remaining)
          } catch (e: Throwable) {
            break // timeout or server closed
          }
        val peerMac = try { socket.remoteDevice?.address } catch (e: Throwable) { null }
        runSession(MeshConnection.fromBluetooth(socket, peerMac), db, identity, vault, deadline, peerMac)
      }
    } finally {
      db.close()
    }
  }

  // Sweep this vault's candidate MACs across the scan-day UUIDs, retrying on a
  // short backoff until the deadline. ONE db connection for the whole loop. A
  // single dial is a one-shot (it lands only if the peer happens to be accepting
  // at that instant); retrying turns "missed by a second" into "synced within a
  // few seconds". Cached peers are dialed FIRST each sweep (the reliable target);
  // bonded devices are a speculative fallback.
  private fun dialLoop(
    ctx: Context,
    adapter: BluetoothAdapter,
    identity: Identity,
    vault: MeshDb.Vault,
    scanDays: List<Long>,
    cached: List<String>,
    bonded: List<String>,
    deadline: Long,
  ) {
    val db =
      try {
        MeshDb.open(ctx)
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
      // Exponential backoff between sweeps (Briar's BackoffImpl pattern): fast
      // first probe so a peer that IS there connects in ~2s, but back off toward
      // 30s when nobody answers so a lone phone isn't hammering the radio every
      // 2s for the whole window. Reset to the floor on any successful connect.
      var backoff = DIAL_SWEEP_MIN_MS
      while (System.currentTimeMillis() < deadline) {
        // Already syncing this vault (we dialed it last sweep, or accepted an
        // inbound dial)? Don't pile on a redundant dial — wait out the backoff.
        if (hasActiveSessionForVault(vault.id)) {
          try {
            Thread.sleep(backoff)
          } catch (e: InterruptedException) {
            break
          }
          continue
        }
        // De-dup, cached first. Filter to dialable MACs (skip 02:00:..-style
        // placeholders the OS hands out when it hides the real address).
        val candidates = LinkedHashSet<String>()
        candidates.addAll(cached)
        candidates.addAll(bonded)
        var connectedThisSweep = false
        for (mac in candidates) {
          if (System.currentTimeMillis() >= deadline) break
          if (!db.isDialableMac(mac)) continue
          // Already syncing this vault with someone? skip the rest of the sweep.
          for (uuid in dayUuids) {
            if (System.currentTimeMillis() >= deadline) break
            if (tryDial(adapter, mac, uuid, db, identity, vault, deadline)) {
              connectedThisSweep = true
              break
            }
          }
        }
        if (System.currentTimeMillis() >= deadline) break
        backoff = if (connectedThisSweep) DIAL_SWEEP_MIN_MS else minOf(backoff * 2, DIAL_SWEEP_MAX_MS)
        try {
          Thread.sleep(backoff)
        } catch (e: InterruptedException) {
          break
        }
      }
    } finally {
      db.close()
    }
  }

  /** One dial attempt. Returns true iff the socket connected (handshake/sync then
   *  run inline); false on any failure so the caller tries the next day-UUID. */
  private fun tryDial(
    adapter: BluetoothAdapter,
    mac: String,
    uuid: UUID,
    db: MeshDb,
    identity: Identity,
    vault: MeshDb.Vault,
    deadline: Long,
  ): Boolean {
    if (System.currentTimeMillis() >= deadline) return false
    return try {
      adapter.cancelDiscovery()
      val device = adapter.getRemoteDevice(mac)
      val socket = device.createInsecureRfcommSocketToServiceRecord(uuid)
      socket.connect() // blocks; throws if peer isn't listening on this UUID
      runSession(MeshConnection.fromBluetooth(socket, mac), db, identity, vault, deadline, mac)
      true
    } catch (e: Throwable) {
      Log.d(TAG, "dial $mac failed: ${e.message}")
      false
    }
  }

  private fun runSession(
    conn: MeshConnection,
    db: MeshDb,
    identity: Identity,
    vault: MeshDb.Vault,
    deadline: Long,
    peerMac: String?,
  ) {
    val bundle = db.loadMembershipEvents(vault.id)
    val params =
      MeshHandshake.HandshakeParams(
        vaultId = vault.id,
        anchorPubkeyB64 = vault.anchorPubkeyB64,
        serverWitnessPubkeysB64 = emptyList(),
        deviceSeed = identity.seed,
        devicePubkeyB64Std = identity.pubkeyB64,
        deviceId = identity.deviceId,
        accountId = identity.accountId,
        ownBundle = bundle,
        localMembershipEvents = bundle,
        displayName = null,
        btMac = null,
      )
    val session =
      try {
        MeshHandshake.run(conn, params)
      } catch (e: Throwable) {
        Log.d(TAG, "handshake failed: ${e.message}")
        conn.close()
        return
      }

    val key = "${session.peerDeviceId}:${vault.id}"
    if (!activeSessions.add(key)) {
      conn.close() // already syncing this peer for this vault
      return
    }
    try {
      // Learn the peer's dialable MAC so future windows dial directly.
      peerMac?.let { if (db.isDialableMac(it)) db.addKnownPeer(vault.id, session.peerDeviceId, it) }
      session.peerBtMac?.let {
        if (db.isDialableMac(it)) db.addKnownPeer(vault.id, session.peerDeviceId, it)
      }
      MeshAntiEntropy.run(conn, db, vault.id, deadline)
    } catch (e: Throwable) {
      Log.d(TAG, "session failed: ${e.message}")
    } finally {
      activeSessions.remove(key)
      conn.close()
    }
  }
}
