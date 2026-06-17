package expo.modules.kaatabtclassic.mesh

/**
 * Native handshake — Briar-parity step 9 (in progress).
 *
 * The session bring-up: Hello exchange -> membership-chain verdict
 * (MeshTrust.verifyPeerProof) -> proof-of-possession (this transcript) -> AEAD
 * key derivation (MeshCrypto.deriveSessionAead) -> install on the MeshConnection.
 * Pure, parity-testable pieces land first; the I/O orchestration (driving a
 * MeshConnection) and device-key sourcing land with MeshEngine.
 *
 * This file currently holds the PoP-v3 transcript (buildPopMessageV3) — the exact
 * bytes both peers sign to prove they hold the private key matching the device
 * pubkey the chain vouches for. Ported byte-for-byte from anti-entropy.ts; parity-
 * tested (sha256 of the sorted bundle commitment + the domain/nonce/ephemeral
 * concatenation).
 */
object MeshHandshake {

  private const val POP_DOMAIN_V3 = "kaata-pop-v3"

  /**
   * v3 PoP transcript = POP_DOMAIN_V3 || sha256(sorted event_ids joined by '\n')
   * || pop_nonce || ownEphemeralPub || peerEphemeralPub. The signer signs this
   * with its device key; the verifier rebuilds it with the roles swapped
   * (their bundle, our nonce, their ephemeral first).
   */
  fun buildPopMessageV3(
    bundleEventIds: List<String>,
    popNonce: String,
    ownEphemeralPub: ByteArray,
    peerEphemeralPub: ByteArray,
  ): ByteArray {
    val d = POP_DOMAIN_V3.toByteArray(Charsets.UTF_8)
    val h = MeshCrypto.sha256(bundleEventIds.sorted().joinToString("\n").toByteArray(Charsets.UTF_8))
    val n = popNonce.toByteArray(Charsets.UTF_8)
    val out = ByteArray(d.size + h.size + n.size + ownEphemeralPub.size + peerEphemeralPub.size)
    var off = 0
    d.copyInto(out, off); off += d.size
    h.copyInto(out, off); off += h.size
    n.copyInto(out, off); off += n.size
    ownEphemeralPub.copyInto(out, off); off += ownEphemeralPub.size
    peerEphemeralPub.copyInto(out, off)
    return out
  }
}
