package expo.modules.kaatabtclassic.mesh

import android.content.Context
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * Shared mesh session machinery — Briar-port phase 1 (see docs/briar-port-plan.md).
 *
 * MeshEngine is now the TRANSPORT-AGNOSTIC core. It loads the device identity +
 * syncable vaults + cached peers (loadEngineContext) and runs ONE authenticated
 * session (MeshHandshake PoP-v3 + membership gate → MeshAntiEntropy delta) over any
 * MeshConnection, regardless of transport. The Bluetooth-specific accept/dial loops
 * moved to plugin/plugins/BtcRfcommPlugin; the LAN + hotspot plugins (later phases)
 * reuse loadEngineContext + runSession unchanged — that is the Briar plugin model.
 *
 * runWindow(context, maxMs) is a thin BACK-COMPAT shim: it runs BtcRfcommPlugin for
 * one bounded window so the existing FGS tick path is byte-for-byte unchanged.
 * Phase 2 makes the plugins resident under a PluginManager and retires the shim.
 */
object MeshEngine {
  private const val TAG = "MeshEngine"

  /** "<peerDeviceId>:<vaultId>" of sessions in flight — never two at once. */
  internal val activeSessions = ConcurrentHashMap.newKeySet<String>()

  /** Is a session (accept or dial) already running for this vault? Used by a
   *  plugin's dial loop to skip redundant dials while a sync is in flight. */
  internal fun hasActiveSessionForVault(vaultId: String): Boolean =
    activeSessions.any { it.endsWith(":$vaultId") }

  internal data class Identity(
    val seed: ByteArray,
    val pubkeyB64: String,
    val deviceId: String,
    val accountId: String,
  )

  /** Everything a transport plugin needs to run sessions: who we are, which vaults
   *  to sync, and the cached dialable peer MACs per vault. */
  internal data class EngineContext(
    val identity: Identity,
    val vaults: List<MeshDb.Vault>,
    val peersByVault: Map<String, List<String>>,
  )

  /**
   * Phase-1 shim: run the Bluetooth plugin for one bounded window (the legacy FGS
   * tick contract — KaataForegroundService still calls this). Resident operation
   * under a PluginManager arrives in phase 2.
   */
  fun runWindow(context: Context, maxMs: Long) {
    Log.i(TAG, "runWindow: start (maxMs=$maxMs)")
    val plugin =
      expo.modules.kaatabtclassic.mesh.plugin.plugins.BtcRfcommPlugin(
        context,
        expo.modules.kaatabtclassic.mesh.plugin.NoopPluginCallback,
      )
    plugin.start()
    try {
      Thread.sleep(maxMs)
    } catch (e: InterruptedException) {
      /* */
    }
    plugin.stop()
  }

  /**
   * Load identity + syncable vaults + cached peers (transport-agnostic). Returns
   * null when the device can't sync (no seed/identity, BT-independent) or has no
   * syncable vault; each null path logs WHY (logcat tag "MeshEngine") so a 2-phone
   * test can tell "ran and synced" from "bailed on <reason>".
   */
  internal fun loadEngineContext(context: Context): EngineContext? {
    val db =
      try {
        MeshDb.open(context)
      } catch (e: Throwable) {
        Log.w(TAG, "open db failed", e)
        return null
      }
    try {
      val identity =
        loadIdentity(db, context)
          ?: run {
            Log.i(TAG, "loadEngineContext: no device identity (seed/pubkey/install_id) — bail")
            return null
          }
      val vaults = db.listSyncableVaults()
      if (vaults.isEmpty()) {
        Log.i(TAG, "loadEngineContext: no syncable vaults — bail")
        return null
      }
      val peersByVault =
        vaults.associate { v ->
          v.id to db.knownPeers(v.id).map { it.mac }.filter { db.isDialableMac(it) }
        }
      return EngineContext(identity, vaults, peersByVault)
    } finally {
      db.close()
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

  /**
   * Run one authenticated session over a connected MeshConnection (ANY transport):
   * handshake (PoP-v3 + membership-chain gate) then anti-entropy delta, bounded by
   * `deadline`. De-duped per (peerDeviceId, vault). Caches the peer's dialable MAC.
   * Always closes the connection. This is the shared seam every plugin runs.
   */
  internal fun runSession(
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
      // Learn the peer's dialable MAC so future sweeps dial directly.
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
