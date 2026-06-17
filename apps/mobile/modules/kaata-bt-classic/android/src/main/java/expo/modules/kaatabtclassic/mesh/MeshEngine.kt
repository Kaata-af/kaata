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

  /** "<peerDeviceId>:<vaultId>" of sessions in flight — never two at once. */
  private val activeSessions = ConcurrentHashMap.newKeySet<String>()

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

    val deadline = System.currentTimeMillis() + maxMs
    val day = MeshDiscovery.dayNumber(System.currentTimeMillis())
    val servers = ArrayList<BluetoothServerSocket>()

    for (v in vaults) {
      val uuid =
        try {
          UUID.fromString(MeshDiscovery.steadyUuid(v.id, day))
        } catch (e: Throwable) {
          continue
        }
      // accept loop
      try {
        val server = adapter.listenUsingInsecureRfcommWithServiceRecord(SERVICE_NAME, uuid)
        servers.add(server)
        Thread({ acceptLoop(server, context, identity, v, deadline) }, "kaata-mesh-accept")
          .apply { isDaemon = true }
          .start()
      } catch (e: Throwable) {
        Log.w(TAG, "listen failed for vault ${v.id}", e)
      }
      // dial cached peers
      for (mac in peersByVault[v.id].orEmpty()) {
        Thread({ dialPeer(context, adapter, mac, uuid, identity, v, deadline) }, "kaata-mesh-dial")
          .apply { isDaemon = true }
          .start()
      }
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
        runSession(socket.let { MeshConnection(it, peerMac) }, db, identity, vault, deadline, peerMac)
      }
    } finally {
      db.close()
    }
  }

  private fun dialPeer(
    ctx: Context,
    adapter: BluetoothAdapter,
    mac: String,
    uuid: UUID,
    identity: Identity,
    vault: MeshDb.Vault,
    deadline: Long,
  ) {
    if (System.currentTimeMillis() >= deadline) return
    val db =
      try {
        MeshDb.open(ctx)
      } catch (e: Throwable) {
        return
      }
    try {
      adapter.cancelDiscovery()
      val device = adapter.getRemoteDevice(mac)
      val socket = device.createInsecureRfcommSocketToServiceRecord(uuid)
      socket.connect() // blocks; throws if peer isn't listening on this UUID
      runSession(MeshConnection(socket, mac), db, identity, vault, deadline, mac)
    } catch (e: Throwable) {
      Log.d(TAG, "dial $mac failed: ${e.message}")
    } finally {
      db.close()
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
