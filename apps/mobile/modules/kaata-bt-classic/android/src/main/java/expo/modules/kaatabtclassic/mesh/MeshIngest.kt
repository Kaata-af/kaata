package expo.modules.kaatabtclassic.mesh

/**
 * Remote-event ingest verdict — Briar-parity step 8 (port of lib/ingest-types.ts
 * verifyAndIngest).
 *
 * Called on every event arriving in a DeltaMessage. The native engine durably
 * ACKNOWLEDGES receipt (so the version-vector head advances and the peer never
 * re-sends) but does NOT apply — the role-gate + projection apply runs later in
 * the JS sweep when the app is next opened (ingest != apply; the whole point of
 * the data-loss fix). So this layer is just: required-fields -> signature ->
 * dedup -> flood cap -> durable insert.
 */
object MeshIngest {
  const val UNKNOWN_ACTOR_CAP_PER_PEER = 64

  sealed class Verdict {
    object Ingested : Verdict()
    data class Tombstoned(val reason: String) : Verdict()
    data class RefusedPreInsert(val reason: String) : Verdict()
  }

  fun verifyAndIngest(event: MeshEvent, db: MeshDb, nowMs: Long): Verdict {
    // 1. Required wire fields — need an embedded pubkey + signature to bind the
    //    event to any identity. Refuse pre-insert (head must NOT advance).
    val signer = event.signerDevicePubkey
    val sig = event.eventSigB64
    if (signer.isNullOrEmpty() || sig.isNullOrEmpty()) {
      return Verdict.RefusedPreInsert("missing_signer_pubkey")
    }

    // 2. Signature verify against the EMBEDDED pubkey (self-consistency, NOT
    //    membership — that's the sweep's role-gate). Fail -> tombstone so the
    //    head advances and the peer stops re-sending, but it's never relayed.
    if (!MeshEventSig.verifyEventSignature(event.canonicalBytes(), sig, signer)) {
      db.insertTombstoned(event, "bad_signature", nowMs)
      return Verdict.Tombstoned("bad_signature")
    }

    // 3. Duplicate (event_id PK). Surface it so the caller can count.
    if (db.hasEvent(event.eventId)) {
      return Verdict.RefusedPreInsert("duplicate")
    }

    // 4. unknown_actor flood cap per (vault, device). Refusing pre-insert does
    //    NOT advance the head, so the peer re-sends once the credential lands.
    val vaultId = event.vaultId
    if (vaultId != null &&
      db.countUnknownActorQuarantine(vaultId, event.deviceId) >= UNKNOWN_ACTOR_CAP_PER_PEER
    ) {
      return Verdict.RefusedPreInsert("quarantine_cap_hit")
    }

    // 5. Durable ingest (applied_at NULL — apply deferred to the JS sweep).
    db.insertIngested(event, nowMs)
    return Verdict.Ingested
  }
}
