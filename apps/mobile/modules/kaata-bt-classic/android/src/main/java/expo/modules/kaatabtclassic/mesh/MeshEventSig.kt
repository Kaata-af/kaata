package expo.modules.kaatabtclassic.mesh

import org.json.JSONArray
import org.json.JSONObject

/**
 * Native event canonicalization + signature verification — Briar-parity step 3.
 *
 * Byte-faithful Kotlin port of lib/event-sig.ts. The native engine must rebuild
 * the EXACT canonical bytes the JS author signed, or every remote event fails
 * verification and nothing syncs. Two fidelity-critical pieces:
 *
 *   1. canonicalize(): deterministic JSON with keys sorted lexicographically,
 *      arrays positional, scalars via the SAME escaping JS `JSON.stringify` uses.
 *      We implement the string escaping BY HAND via char-code comparisons
 *      (org.json.JSONObject.quote escapes '/', 0x7f-0x9f etc. differently from JS
 *      and would diverge).
 *   2. canonicalizeEvent(): the fixed envelope key order
 *      (actor_account_id, device_id, event_id, event_type, hlc{did,l,pms},
 *      payload, payload_schema, relationship_id, target_id, vault_id) — already
 *      alphabetical, matching event-sig.ts.
 *
 * Signatures use STANDARD base64 (NOT url-safe) — matches event-sig.ts bytesToB64
 * / b64ToBytes. (The mesh AEAD/handshake layer uses base64URL; do not confuse.)
 *
 * NUMBERS: ledger payloads + HLC fields are integers, which JSON.stringify and
 * Long.toString render identically. A non-integer (float) payload value would
 * need JS's shortest-round-trip formatting to match — flagged; not present today.
 */
object MeshEventSig {

  // --- standard base64 (matches event-sig.ts btoa/atob) ----------------------
  fun b64StdEncode(bytes: ByteArray): String = MeshBase64.encodeStd(bytes)

  fun b64StdDecode(s: String): ByteArray = MeshBase64.decode(s)

  // --- canonical JSON (matches event-sig.ts canonicalize) --------------------

  /**
   * Canonicalize an org.json value (JSONObject / JSONArray / String / Int / Long
   * / Double / Boolean / JSONObject.NULL / null) into the same string JS's
   * canonicalize() produces.
   */
  fun canonicalizeValue(v: Any?): String {
    if (v == null || v === JSONObject.NULL) return "null"
    return when (v) {
      is String -> jsonQuote(v)
      is Boolean -> if (v) "true" else "false"
      is Int -> v.toString()
      is Long -> v.toString()
      is Short, is Byte -> v.toString()
      is Double -> formatNumber(v)
      is Float -> formatNumber(v.toDouble())
      is JSONArray -> {
        val sb = StringBuilder("[")
        for (i in 0 until v.length()) {
          if (i > 0) sb.append(',')
          sb.append(canonicalizeValue(v.get(i)))
        }
        sb.append(']')
        sb.toString()
      }
      is JSONObject -> {
        val keys = ArrayList<String>()
        val it = v.keys()
        while (it.hasNext()) keys.add(it.next())
        keys.sort()
        val sb = StringBuilder("{")
        var first = true
        for (k in keys) {
          if (!first) sb.append(',')
          first = false
          sb.append(jsonQuote(k)).append(':').append(canonicalizeValue(v.get(k)))
        }
        sb.append('}')
        sb.toString()
      }
      else -> jsonQuote(v.toString())
    }
  }

  /**
   * Build the canonical bytes for an event envelope+payload — matches
   * event-sig.ts canonicalizeEvent. `payload` is an org.json value already
   * parsed from the wire's payload field.
   */
  fun canonicalizeEvent(
    eventId: String,
    eventType: String,
    vaultId: String?,
    targetId: String,
    relationshipId: String?,
    hlcDid: String,
    hlcL: Long,
    hlcPms: Long,
    deviceId: String,
    actorAccountId: String?,
    payload: Any?,
    payloadSchema: Int,
  ): ByteArray {
    // Keys emitted in alphabetical order (canonicalize() sorts; this set is
    // already sorted): actor_account_id, device_id, event_id, event_type, hlc,
    // payload, payload_schema, relationship_id, target_id, vault_id.
    val hlc =
      "{" +
        jsonQuote("did") + ":" + jsonQuote(hlcDid) + "," +
        jsonQuote("l") + ":" + hlcL.toString() + "," +
        jsonQuote("pms") + ":" + hlcPms.toString() +
        "}"
    val canonical =
      "{" +
        jsonQuote("actor_account_id") + ":" + nullableStr(actorAccountId) + "," +
        jsonQuote("device_id") + ":" + jsonQuote(deviceId) + "," +
        jsonQuote("event_id") + ":" + jsonQuote(eventId) + "," +
        jsonQuote("event_type") + ":" + jsonQuote(eventType) + "," +
        jsonQuote("hlc") + ":" + hlc + "," +
        jsonQuote("payload") + ":" + canonicalizeValue(payload) + "," +
        jsonQuote("payload_schema") + ":" + payloadSchema.toString() + "," +
        jsonQuote("relationship_id") + ":" + nullableStr(relationshipId) + "," +
        jsonQuote("target_id") + ":" + jsonQuote(targetId) + "," +
        jsonQuote("vault_id") + ":" + nullableStr(vaultId) +
        "}"
    return canonical.toByteArray(Charsets.UTF_8)
  }

  /** Verify an event signature (standard-base64 sig + pubkey). Never throws. */
  fun verifyEventSignature(
    canonicalBytes: ByteArray,
    sigB64Std: String,
    pubkeyB64Std: String,
  ): Boolean {
    return try {
      val sig = b64StdDecode(sigB64Std)
      val pub = b64StdDecode(pubkeyB64Std)
      if (sig.size != 64 || pub.size != 32) return false
      MeshCrypto.ed25519Verify(sig, canonicalBytes, pub)
    } catch (e: Throwable) {
      false
    }
  }

  /** Raw Ed25519 verify over arbitrary bytes (witness attestations). */
  fun verifyRawSignature(msg: ByteArray, sigB64Std: String, pubkeyB64Std: String): Boolean {
    return try {
      val sig = b64StdDecode(sigB64Std)
      val pub = b64StdDecode(pubkeyB64Std)
      if (sig.size != 64 || pub.size != 32) return false
      MeshCrypto.ed25519Verify(sig, msg, pub)
    } catch (e: Throwable) {
      false
    }
  }

  // --- helpers ---------------------------------------------------------------

  private fun nullableStr(s: String?): String = if (s == null) "null" else jsonQuote(s)

  /** Match JS JSON.stringify for an integral double; flag otherwise. */
  private fun formatNumber(d: Double): String {
    if (d.isNaN() || d.isInfinite()) return "null" // JSON.stringify -> null
    if (d == Math.floor(d) && Math.abs(d) < 9.007199254740992E15) {
      return d.toLong().toString()
    }
    // Non-integer: JS uses shortest round-trip; Double.toString is a close but
    // not guaranteed match. Ledger values are integers, so this path is unused.
    return d.toString()
  }

  /**
   * Emit a JSON string literal exactly like ECMAScript JSON.stringify, using
   * char-code comparisons only (no literal control chars in source): escape
   * " \ and the control chars 0x08 0x0C 0x0A 0x0D 0x09 as \b \f \n \r \t, other
   * <0x20 as \u00xx (lowercase hex), and pass everything else (incl. '/', 0x7f,
   * non-ASCII) through verbatim. The final string is UTF-8 encoded by the caller.
   */
  private fun jsonQuote(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (c in s) {
      val code = c.code
      when {
        c == '"' -> sb.append("\\\"")
        c == '\\' -> sb.append("\\\\")
        code == 0x08 -> sb.append("\\b")
        code == 0x0C -> sb.append("\\f")
        code == 0x0A -> sb.append("\\n")
        code == 0x0D -> sb.append("\\r")
        code == 0x09 -> sb.append("\\t")
        code < 0x20 -> {
          sb.append("\\u")
          val hex = Integer.toHexString(code)
          for (i in hex.length until 4) sb.append('0')
          sb.append(hex)
        }
        else -> sb.append(c)
      }
    }
    sb.append('"')
    return sb.toString()
  }
}
