package expo.modules.kaatabtclassic.mesh

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File

/**
 * Native access to the shared SQLite ledger — Briar-parity step 5 (read side).
 *
 * Opens the SAME database file expo-sqlite uses on the JS side
 * (<filesDir>/SQLite/kaata.db — see expo-sqlite SQLiteModule.defaultDatabaseDirectory)
 * so the resident native engine reads/writes the one event-log, no IPC. WAL is
 * already enabled on the file by the JS connection; we set a busy_timeout so the
 * rare overlap with a live JS connection blocks-and-retries rather than failing.
 * In practice the single-mesh heartbeat guard (KaataBgMeshGate) keeps the native
 * engine from running heavy DB work while a foreground JS mesh is live, so true
 * concurrent access is minimal.
 *
 * This file is the READ side (the SEND half of anti-entropy): the version-vector
 * frontier, the delta range selection, signer-pubkey lookup. The WRITE/ingest
 * side (slot pre-check + HLC merge + role-gate) lands with MeshTrust/MeshIngest.
 */
class MeshDb private constructor(private val db: SQLiteDatabase) {

  companion object {
    private const val TAG = "MeshDb"

    fun open(context: Context): MeshDb {
      val path = File(context.filesDir, "SQLite/kaata.db").absolutePath
      val db =
        SQLiteDatabase.openDatabase(path, null, SQLiteDatabase.OPEN_READWRITE)
      try {
        db.rawQuery("PRAGMA busy_timeout=5000", null).use { it.moveToFirst() }
        db.execSQL("PRAGMA foreign_keys=ON")
      } catch (e: Throwable) {
        Log.w(TAG, "pragma setup failed", e)
      }
      return MeshDb(db)
    }
  }

  fun close() {
    try {
      db.close()
    } catch (e: Throwable) {
      /* ignore */
    }
  }

  /**
   * Per-author version-vector frontier for a vault: device_id -> highest
   * CONTIGUOUS author_seq held. Mirrors replication/store.ts localFrontierReport
   * (one scan, JS-side aggregation via MeshPlanner.computeContiguous). Rows with
   * NULL author_seq are invisible to the vector by definition.
   */
  fun localFrontier(vaultId: String): MutableMap<String, Int> {
    val perDevice = HashMap<String, ArrayList<Int>>()
    db.rawQuery(
      "SELECT device_id, author_seq FROM event_log " +
        "WHERE vault_id = ? AND author_seq IS NOT NULL " +
        "ORDER BY device_id ASC, author_seq ASC",
      arrayOf(vaultId),
    ).use { c ->
      while (c.moveToNext()) {
        val device = c.getString(0)
        val seq = c.getInt(1)
        perDevice.getOrPut(device) { ArrayList() }.add(seq)
      }
    }
    val vector = HashMap<String, Int>()
    for ((device, seqs) in perDevice) {
      vector[device] = MeshPlanner.computeContiguous(seqs).frontier
    }
    return vector
  }

  /**
   * Select the events for one author range (inclusive) as wire events, ordered
   * by author_seq so the receiver's frontier advances contiguously. Only rows
   * with a real author_seq are relayable (matches the DELTA path's
   * `author_seq IS NOT NULL`).
   */
  fun selectRange(vaultId: String, deviceId: String, fromSeq: Int, toSeq: Int): List<JSONObject> {
    val out = ArrayList<JSONObject>()
    db.rawQuery(
      "SELECT event_id, event_type, vault_id, target_id, relationship_id, " +
        "hlc_physical_ms, hlc_logical, hlc_device_id, device_id, author_seq, " +
        "actor_account_id, payload_json, payload_schema, event_sig_b64, signer_device_pubkey " +
        "FROM event_log " +
        "WHERE vault_id = ? AND device_id = ? AND author_seq IS NOT NULL " +
        "AND author_seq >= ? AND author_seq <= ? " +
        "ORDER BY author_seq ASC",
      arrayOf(vaultId, deviceId, fromSeq.toString(), toSeq.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        out.add(rowToWireEvent(c))
      }
    }
    return out
  }

  /**
   * The signing device's pubkey (standard base64), from vault_credentials —
   * the same lookup the role-gate uses to authenticate an event's author.
   */
  fun signerPubkey(vaultId: String, deviceId: String): String? {
    db.rawQuery(
      "SELECT device_pubkey FROM vault_credentials WHERE vault_id = ? AND device_id = ? LIMIT 1",
      arrayOf(vaultId, deviceId),
    ).use { c ->
      return if (c.moveToFirst()) c.getString(0) else null
    }
  }

  fun hasEvent(eventId: String): Boolean {
    db.rawQuery("SELECT 1 FROM event_log WHERE event_id = ? LIMIT 1", arrayOf(eventId)).use { c ->
      return c.moveToFirst()
    }
  }

  /** The vault's trust anchor pubkey (owner device key, std base64). */
  fun vaultAnchor(vaultId: String): String? {
    db.rawQuery(
      "SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ? LIMIT 1",
      arrayOf(vaultId),
    ).use { c ->
      return if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
    }
  }

  /** Local membership events for a vault, HLC-ordered — the proof bundle we
   *  present + the local set folded for verifyPeerProof (proof.ts
   *  loadLocalMembershipEvents / buildOwnProofBundle). */
  fun loadMembershipEvents(vaultId: String): List<MeshEvent> {
    val out = ArrayList<MeshEvent>()
    db.rawQuery(
      "SELECT event_id, event_type, vault_id, target_id, relationship_id, " +
        "hlc_physical_ms, hlc_logical, hlc_device_id, device_id, author_seq, " +
        "actor_account_id, payload_json, payload_schema, event_sig_b64, signer_device_pubkey " +
        "FROM event_log " +
        "WHERE vault_id = ? AND event_type IN " +
        "('vault_member_added','vault_member_role_changed','vault_member_removed'," +
        "'vault_device_added','vault_device_removed') " +
        "ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC, event_id ASC",
      arrayOf(vaultId),
    ).use { c ->
      while (c.moveToNext()) out.add(MeshEvent.fromWire(rowToWireEvent(c)))
    }
    return out
  }

  // --- write / ingest side (mirrors anti-entropy.ts applyIncomingBatch) -------

  fun getAppMeta(key: String): String? {
    db.rawQuery("SELECT value FROM app_meta WHERE key = ? LIMIT 1", arrayOf(key)).use { c ->
      return if (c.moveToFirst()) c.getString(0) else null
    }
  }

  fun installId(): String? = getAppMeta("install_id")

  fun countUnknownActorQuarantine(vaultId: String, deviceId: String): Int {
    db.rawQuery(
      "SELECT COUNT(*) FROM event_log WHERE vault_id = ? AND device_id = ? " +
        "AND quarantine_reason = 'unknown_actor'",
      arrayOf(vaultId, deviceId),
    ).use { c ->
      return if (c.moveToFirst()) c.getInt(0) else 0
    }
  }

  /**
   * Slot pre-check (anti-entropy.ts resolveMeshAuthorSeq): if a DIFFERENT
   * event_id already holds this (vault, device, author_seq) slot, sacrifice the
   * SEQ (return null) — never the event. The (vault,device,author_seq) UNIQUE
   * index would otherwise reject the insert.
   */
  private fun resolveAuthorSeq(event: MeshEvent): Int? {
    val seq = event.authorSeq ?: return null
    val vaultId = event.vaultId ?: return null
    db.rawQuery(
      "SELECT event_id FROM event_log WHERE vault_id = ? AND device_id = ? AND author_seq = ?",
      arrayOf(vaultId, event.deviceId, seq.toString()),
    ).use { c ->
      if (c.moveToFirst() && c.getString(0) != event.eventId) return null
    }
    return seq
  }

  /** Durably ingest a signature-verified remote event (applied_at NULL — the JS
   *  sweep applies it later via the role-gate). */
  fun insertIngested(event: MeshEvent, ingestedAtMs: Long) {
    insertRow(event, ingestedAtMs, resolveAuthorSeq(event), null)
  }

  /** Insert a bad-sig event tombstoned (author_seq NULL — never relayable). */
  fun insertTombstoned(event: MeshEvent, tombstoneReason: String, ingestedAtMs: Long) {
    insertRow(event, ingestedAtMs, null, tombstoneReason)
  }

  private fun insertRow(
    event: MeshEvent,
    ingestedAtMs: Long,
    authorSeq: Int?,
    tombstoneReason: String?,
  ) {
    db.beginTransaction()
    try {
      db.execSQL(
        "INSERT OR IGNORE INTO event_log (" +
          "event_id, event_type, vault_id, target_id, relationship_id, " +
          "hlc_physical_ms, hlc_logical, hlc_device_id, " +
          "device_id, author_user_id_local_only, actor_account_id, " +
          "payload_json, payload_schema, " +
          "appended_at, server_acked_at, rejected_at, origin, " +
          "event_sig_b64, signer_device_pubkey, " +
          "ingested_at, applied_at, quarantine_reason, tombstone_reason, author_seq" +
          ") VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?, NULL, NULL, 'remote',  ?, ?,  ?, NULL, NULL, ?, ?)",
        arrayOf<Any?>(
          event.eventId,
          event.eventType,
          event.vaultId,
          event.targetId,
          event.relationshipId,
          event.hlcPms,
          event.hlcL,
          event.hlcDid,
          event.deviceId,
          "", // author_user_id_local_only — local-only, "" for remote (matches JS)
          event.actorAccountId,
          event.payload.toString(),
          event.payloadSchema.toLong(),
          ingestedAtMs, // appended_at
          event.eventSigB64,
          event.signerDevicePubkey,
          ingestedAtMs, // ingested_at
          tombstoneReason,
          authorSeq?.toLong(),
        ),
      )
      bumpHlcFrontier(event)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  /** Merge the event's HLC into our frontier (hlc_last), like the JS ingest. */
  private fun bumpHlcFrontier(event: MeshEvent) {
    val did = installId() ?: return
    val prev = getAppMeta("hlc_last")?.let { MeshHlc.deserialize(it) }
    val merged =
      MeshHlc.tickReceive(prev, MeshHlc.Hlc(event.hlcPms, event.hlcL, event.hlcDid), nowMs(), did)
    db.execSQL(
      "INSERT INTO app_meta (key, value) VALUES ('hlc_last', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      arrayOf<Any?>(MeshHlc.serialize(merged)),
    )
  }

  private fun nowMs(): Long = System.currentTimeMillis()

  // --- helpers ---------------------------------------------------------------

  private fun rowToWireEvent(c: android.database.Cursor): JSONObject {
    val payloadJson = c.getString(11)
    val payload: Any =
      try {
        JSONTokener(payloadJson).nextValue()
      } catch (e: Throwable) {
        JSONObject()
      }
    val hlc =
      JSONObject().apply {
        put("did", c.getString(7))
        put("l", c.getLong(6))
        put("pms", c.getLong(5))
      }
    return JSONObject().apply {
      put("event_id", c.getString(0))
      put("event_type", c.getString(1))
      put("vault_id", c.getString(2))
      put("target_id", orNull(c, 3))
      put("relationship_id", orNull(c, 4))
      put("hlc", hlc)
      put("device_id", c.getString(8))
      put("author_seq", c.getInt(9))
      put("actor_account_id", orNull(c, 10))
      put("payload", payload)
      put("schema_version", c.getInt(12))
      put("event_sig_b64", orNull(c, 13))
      put("signer_device_pubkey", orNull(c, 14))
    }
  }

  /** Returns the string or JSONObject.NULL (so the wire carries explicit null). */
  private fun orNull(c: android.database.Cursor, col: Int): Any =
    if (c.isNull(col)) JSONObject.NULL else c.getString(col)
}
