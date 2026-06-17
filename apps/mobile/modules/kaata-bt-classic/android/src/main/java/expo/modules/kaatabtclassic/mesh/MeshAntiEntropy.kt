package expo.modules.kaatabtclassic.mesh

import android.util.Log
import org.json.JSONObject

/**
 * Native anti-entropy session — Briar-parity step 10. Port of anti-entropy.ts
 * runAntiEntropy (vector exchange) + runDeltaLoop, the BACKGROUND-receive subset.
 *
 * Runs AFTER MeshHandshake on the same connection: exchange per-author version
 * vectors (MeshDb.localFrontier), then swap deltas — each iteration concurrently
 * sends a <=500-event batch of the author_seq ranges the peer lacks
 * (MeshPlanner.planRangesToSend + MeshDb.selectRange) and receives+ingests the
 * peer's batch (MeshIngest.verifyAndIngest), until both sides signal has_more=false.
 *
 * Apply (role-gate + projection) is NOT done here — ingest durably records receipt
 * (applied_at NULL); the JS sweep applies on next app open. End-to-end behavior is
 * validated at the cutover device test.
 */
object MeshAntiEntropy {
  private const val TAG = "MeshAntiEntropy"
  private const val BATCH_SIZE = 500
  private const val MAX_BATCHES_SENT = 400
  private const val MAX_BATCHES_RECEIVED = 400
  private const val MSG_TIMEOUT_MS = 30_000L

  data class Result(val sent: Int, val received: Int, val duplicates: Int)

  fun run(conn: MeshConnection, db: MeshDb, vaultId: String, deadlineMs: Long): Result {
    // --- vector exchange ---
    val localVector = db.localFrontier(vaultId)
    val frontierJson = JSONObject()
    for ((dev, seq) in localVector) frontierJson.put(dev, seq)
    conn.sendJson(
      JSONObject().apply {
        put("type", "vector")
        put("v", 3)
        put("vault_id", vaultId)
        put("frontier", frontierJson)
      },
    )
    val peerVecMsg =
      conn.recvJson(remaining(deadlineMs)) ?: throw MeshCrypto.MeshCryptoError("no peer vector")
    if (peerVecMsg.optString("type") != "vector") {
      throw MeshCrypto.MeshCryptoError("expected vector, got ${peerVecMsg.optString("type")}")
    }
    if (peerVecMsg.optString("vault_id") != vaultId) {
      throw MeshCrypto.MeshCryptoError("peer vector vault_id mismatch")
    }
    val peerVector = HashMap<String, Int>()
    peerVecMsg.optJSONObject("frontier")?.let { fr ->
      val it = fr.keys()
      while (it.hasNext()) {
        val k = it.next()
        peerVector[k] = fr.getInt(k)
      }
    }
    Log.d(TAG, "vector exchange: ours=${localVector.size} peer=${peerVector.size}")

    return runDeltaLoop(conn, db, vaultId, localVector, peerVector, deadlineMs)
  }

  private fun runDeltaLoop(
    conn: MeshConnection,
    db: MeshDb,
    vaultId: String,
    localVector: Map<String, Int>,
    peerVector: Map<String, Int>,
    deadlineMs: Long,
  ): Result {
    var sent = 0
    var received = 0
    var duplicates = 0
    val cursor = SendCursor(MeshPlanner.planRangesToSend(localVector, peerVector))
    var localSentDone = false
    var peerSentDone = false
    var sentBatches = 0
    var receivedBatches = 0

    while (!(localSentDone && peerSentDone)) {
      if (System.currentTimeMillis() > deadlineMs) {
        throw MeshCrypto.MeshCryptoError("anti-entropy exceeded deadline")
      }
      if (sentBatches >= MAX_BATCHES_SENT || receivedBatches >= MAX_BATCHES_RECEIVED) {
        throw MeshCrypto.MeshCryptoError("anti-entropy exceeded batch budget")
      }

      val outBatch: List<JSONObject> =
        if (!localSentDone) {
          val b = cursor.next(db, vaultId, BATCH_SIZE)
          if (b.size < BATCH_SIZE) localSentDone = true
          b
        } else {
          emptyList()
        }

      val outArr = org.json.JSONArray()
      outBatch.forEach { outArr.put(it) }
      conn.sendJson(
        JSONObject().apply {
          put("type", "delta")
          put("v", 3)
          put("events", outArr)
          put("has_more", !localSentDone)
        },
      )
      val inMsg =
        conn.recvJson(remaining(deadlineMs)) ?: throw MeshCrypto.MeshCryptoError("no peer delta")
      if (inMsg.optString("type") != "delta") {
        throw MeshCrypto.MeshCryptoError("expected delta, got ${inMsg.optString("type")}")
      }

      sent += outBatch.size
      if (outBatch.isNotEmpty()) sentBatches++

      val inEvents = inMsg.optJSONArray("events")
      var inCount = 0
      if (inEvents != null) {
        val now = System.currentTimeMillis()
        // HLC order for a deterministic ingest (matches the JS sort).
        val parsed =
          (0 until inEvents.length())
            .map { MeshEvent.fromWire(inEvents.getJSONObject(it)) }
            .sortedWith(compareBy({ it.hlcPms }, { it.hlcL }, { it.hlcDid }))
        inCount = parsed.size
        for (e in parsed) {
          when (MeshIngest.verifyAndIngest(e, db, now)) {
            is MeshIngest.Verdict.Ingested -> received++
            is MeshIngest.Verdict.RefusedPreInsert ->
              // "duplicate" is the common benign case; count it.
              duplicates++
            is MeshIngest.Verdict.Tombstoned -> { /* head advances; not "received" */ }
          }
        }
      }
      if (inCount > 0) receivedBatches++

      if (!inMsg.optBoolean("has_more", false)) peerSentDone = true
    }

    // Best-effort bye.
    try {
      conn.sendJson(JSONObject().apply { put("type", "bye"); put("v", 3) })
    } catch (e: Throwable) {
      /* peer may already be gone */
    }
    Log.d(TAG, "delta done: sent=$sent received=$received dup=$duplicates")
    return Result(sent, received, duplicates)
  }

  private fun remaining(deadlineMs: Long): Long =
    minOf(MSG_TIMEOUT_MS, maxOf(1L, deadlineMs - System.currentTimeMillis()))

  /**
   * Walks the planned (contiguous) author_seq ranges in order, pulling up to
   * `size` events per call via MeshDb.selectRange. Ranges are contiguous (the
   * frontier is the highest n with 1..n present), so selectRange returns exactly
   * the requested sub-window.
   */
  private class SendCursor(private val ranges: List<MeshPlanner.SeqRange>) {
    private var ri = 0
    private var nextSeq = if (ranges.isEmpty()) 0 else ranges[0].fromSeq

    fun next(db: MeshDb, vaultId: String, size: Int): List<JSONObject> {
      val out = ArrayList<JSONObject>()
      while (out.size < size && ri < ranges.size) {
        val r = ranges[ri]
        val from = nextSeq
        val to = minOf(from + (size - out.size) - 1, r.toSeq)
        val batch = db.selectRange(vaultId, r.deviceId, from, to)
        out.addAll(batch)
        if (to >= r.toSeq || batch.isEmpty()) {
          ri++
          if (ri < ranges.size) nextSeq = ranges[ri].fromSeq
        } else {
          nextSeq = to + 1
        }
      }
      return out
    }
  }
}
