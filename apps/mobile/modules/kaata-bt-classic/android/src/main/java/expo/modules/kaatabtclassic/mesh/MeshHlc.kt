package expo.modules.kaatabtclassic.mesh

import org.json.JSONObject

/**
 * Hybrid Logical Clock — Briar-parity step 6 (pure port of lib/hlc.ts).
 *
 * The native ingest bumps the HLC frontier (HLC_LAST_KEY in app_meta) on every
 * received event exactly like the JS path (tickReceive), and orders a batch by
 * compareHLC before applying. Pure functions — parity-tested against JS vectors.
 */
object MeshHlc {
  const val MAX_FORWARD_DRIFT_MS = 60_000L

  data class Hlc(val pms: Long, val l: Long, val did: String)

  private fun initial(deviceId: String) = Hlc(0L, 0L, deviceId)

  /** Local-event tick (authoring). Native v1 only ingests, but kept for parity. */
  fun tickLocal(prev: Hlc?, nowMs: Long, deviceId: String): Hlc {
    val last = prev ?: initial(deviceId)
    return if (nowMs > last.pms) Hlc(nowMs, 0L, deviceId)
    else Hlc(last.pms, last.l + 1L, deviceId)
  }

  /** Received-event tick — merges a remote HLC into our frontier (hlc.ts). */
  fun tickReceive(prev: Hlc?, remote: Hlc, nowMs: Long, deviceId: String): Hlc {
    val last = prev ?: initial(deviceId)
    // Forward-drift clamp — a peer whose clock is wildly ahead is treated as
    // arriving "now" rather than its claimed timestamp.
    val remotePms = if (remote.pms - nowMs > MAX_FORWARD_DRIFT_MS) nowMs else remote.pms
    val maxPms = maxOf(nowMs, last.pms, remotePms)

    if (maxPms > last.pms && maxPms > remotePms) {
      return Hlc(maxPms, 0L, deviceId)
    }
    if (maxPms == last.pms && maxPms == remotePms) {
      return Hlc(maxPms, maxOf(last.l, remote.l) + 1L, deviceId)
    }
    if (maxPms == last.pms) {
      return Hlc(last.pms, last.l + 1L, deviceId)
    }
    // maxPms === remotePms > last.pms
    return Hlc(remotePms, remote.l + 1L, deviceId)
  }

  /** Total ordering: physical, then logical, then device-id lexicographic. */
  fun compareHLC(a: Hlc, b: Hlc): Int {
    if (a.pms != b.pms) return a.pms.compareTo(b.pms)
    if (a.l != b.l) return a.l.compareTo(b.l)
    return a.did.compareTo(b.did)
  }

  fun serialize(hlc: Hlc): String =
    JSONObject().apply {
      put("pms", hlc.pms)
      put("l", hlc.l)
      put("did", hlc.did)
    }.toString()

  fun deserialize(raw: String): Hlc? =
    try {
      val o = JSONObject(raw)
      if (o.has("pms") && o.has("l") && o.has("did")) {
        Hlc(o.getLong("pms"), o.getLong("l"), o.getString("did"))
      } else {
        null
      }
    } catch (e: Throwable) {
      null
    }
}
