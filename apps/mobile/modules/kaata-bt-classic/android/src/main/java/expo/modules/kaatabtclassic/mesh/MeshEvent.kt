package expo.modules.kaatabtclassic.mesh

import org.json.JSONObject

/**
 * A parsed wire/ledger event — the native counterpart of WireMeshEvent /
 * MembershipEventLike. Built from the wire JSON (fromWire) or a DB row; carries
 * everything the fold, the ingest, and signature verification need.
 */
data class MeshEvent(
  val eventId: String,
  val eventType: String,
  val vaultId: String?,
  val targetId: String,
  val relationshipId: String?,
  val hlcPms: Long,
  val hlcL: Long,
  val hlcDid: String,
  val deviceId: String,
  val actorAccountId: String?,
  val payload: JSONObject,
  val payloadSchema: Int,
  val eventSigB64: String?,
  val signerDevicePubkey: String?,
  val authorSeq: Int?,
) {
  /** Canonical bytes the author signed (event-sig.ts canonicalizeEvent). */
  fun canonicalBytes(): ByteArray =
    MeshEventSig.canonicalizeEvent(
      eventId = eventId,
      eventType = eventType,
      vaultId = vaultId,
      targetId = targetId,
      relationshipId = relationshipId,
      hlcDid = hlcDid,
      hlcL = hlcL,
      hlcPms = hlcPms,
      deviceId = deviceId,
      actorAccountId = actorAccountId,
      payload = payload,
      payloadSchema = payloadSchema,
    )

  /** Serialize back to the wire shape (WireMeshEvent) — inverse of fromWire.
   *  Used to put our membership proof bundle into the Hello. */
  fun toWire(): JSONObject =
    JSONObject().apply {
      put("event_id", eventId)
      put("event_type", eventType)
      put("vault_id", vaultId ?: JSONObject.NULL)
      put("target_id", targetId)
      put("relationship_id", relationshipId ?: JSONObject.NULL)
      put("hlc", JSONObject().apply {
        put("pms", hlcPms)
        put("l", hlcL)
        put("did", hlcDid)
      })
      put("device_id", deviceId)
      put("author_seq", authorSeq ?: JSONObject.NULL)
      put("actor_account_id", actorAccountId ?: JSONObject.NULL)
      put("payload", payload)
      put("schema_version", payloadSchema)
      put("event_sig_b64", eventSigB64 ?: JSONObject.NULL)
      put("signer_device_pubkey", signerDevicePubkey ?: JSONObject.NULL)
    }

  companion object {
    fun fromWire(o: JSONObject): MeshEvent {
      val hlc = o.getJSONObject("hlc")
      return MeshEvent(
        eventId = o.getString("event_id"),
        eventType = o.getString("event_type"),
        vaultId = o.strOrNull("vault_id"),
        targetId = if (o.isNull("target_id")) "" else o.optString("target_id", ""),
        relationshipId = o.strOrNull("relationship_id"),
        hlcPms = hlc.getLong("pms"),
        hlcL = hlc.getLong("l"),
        hlcDid = hlc.getString("did"),
        deviceId = o.getString("device_id"),
        actorAccountId = o.strOrNull("actor_account_id"),
        payload = o.optJSONObject("payload") ?: JSONObject(),
        // Wire field is schema_version; event_log column is payload_schema.
        payloadSchema =
          when {
            o.has("schema_version") && !o.isNull("schema_version") -> o.getInt("schema_version")
            o.has("payload_schema") && !o.isNull("payload_schema") -> o.getInt("payload_schema")
            else -> 1
          },
        eventSigB64 = o.strOrNull("event_sig_b64"),
        signerDevicePubkey = o.strOrNull("signer_device_pubkey"),
        authorSeq = if (o.has("author_seq") && !o.isNull("author_seq")) o.getInt("author_seq") else null,
      )
    }
  }
}

internal fun JSONObject.strOrNull(k: String): String? =
  if (!has(k) || isNull(k)) null else getString(k)
