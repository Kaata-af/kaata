package expo.modules.kaatabtclassic.mesh

import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * Native handshake — Briar-parity step 9. Faithful port of anti-entropy.ts
 * handshake() + verifyPeerChain (the BACKGROUND subset: established members only,
 * NO pair-admission — pairing/two-way-scan stays in the JS foreground).
 *
 * Symmetric: both peers send Hello, both verify, both PoP. Flow:
 *   Hello exchange -> verifyPeerProof (MeshTrust, chain verdict) -> proof of
 *   possession (sign/verify the v3 transcript) -> deriveSessionAead -> install
 *   AEAD on the connection. Returns the authenticated peer session, or throws.
 *
 * ENCODING SPLIT (must match the JS exactly):
 *   - device_pubkey_b64  = STANDARD base64 (chain identity, MeshBase64.decode)
 *   - pop_nonce / ephemeral_x25519_pubkey / PoP sig = URL base64 (MeshCrypto)
 *
 * The device SEED (for PoP signing) is passed IN — the engine sources it from
 * secure storage; this module stays pure-logic + I/O over a MeshConnection.
 */
object MeshHandshake {

  private const val POP_DOMAIN_V3 = "kaata-pop-v3"
  private const val HELLO_RECV_TIMEOUT_MS = 10_000L
  private const val POP_RECV_TIMEOUT_MS = 10_000L

  private val rnd = SecureRandom()

  class HandshakeError(message: String) : Exception(message)

  data class HandshakeParams(
    val vaultId: String,
    val anchorPubkeyB64: String,
    val serverWitnessPubkeysB64: List<String>,
    /** 32-byte Ed25519 seed — for PoP signing. Sourced by the engine. */
    val deviceSeed: ByteArray,
    /** Our device pubkey, STANDARD base64 (app_meta mesh_device_ed25519_pubkey). */
    val devicePubkeyB64Std: String,
    val deviceId: String,
    val accountId: String,
    /** Our membership proof bundle (local membership events). */
    val ownBundle: List<MeshEvent>,
    /** Local membership set folded with the peer's bundle for the verdict. */
    val localMembershipEvents: List<MeshEvent>,
    val displayName: String?,
    val btMac: String?,
  )

  data class Session(
    val peerDeviceId: String,
    val peerDevicePubkeyB64: String,
    val accountId: String,
    val role: String,
    val peerBtMac: String?,
  )

  /** v3 PoP transcript (see header). */
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

  /** "local:" + base64url(pubkey)[0..16] — account-id.ts buildLocalAccountId. */
  fun buildLocalAccountId(devicePubkeyB64Std: String): String {
    val bytes = MeshBase64.decode(devicePubkeyB64Std)
    require(bytes.size == 32) { "device pubkey must be 32 bytes" }
    return "local:" + MeshBase64.encodeUrl(bytes).substring(0, 16)
  }

  fun run(conn: MeshConnection, p: HandshakeParams): Session {
    val ourNonceBytes = ByteArray(32).also { rnd.nextBytes(it) }
    val ourNonceB64 = MeshCrypto.b64UrlEncode(ourNonceBytes)
    val ourEph = MeshCrypto.generateEphemeralKeyPair()
    val ownBundleIds = p.ownBundle.map { it.eventId }

    // --- Hello exchange (send + recv; sends don't block on the peer) ---------
    val hello =
      JSONObject().apply {
        put("type", "hello")
        put("v", 3)
        put("capabilities", JSONArray().put("v1"))
        put("pop_nonce", ourNonceB64)
        put("ephemeral_x25519_pubkey", MeshCrypto.b64UrlEncode(ourEph.publicKey))
        put("device_pubkey_b64", p.devicePubkeyB64Std)
        put("device_id", p.deviceId)
        put("account_id", p.accountId)
        if (p.displayName != null) put("display_name", p.displayName)
        if (p.btMac != null) put("bt_mac", p.btMac)
        put("proof_bundle", JSONArray().also { arr -> p.ownBundle.forEach { arr.put(it.toWire()) } })
      }
    conn.sendJson(hello)
    val peerHello =
      conn.recvJson(HELLO_RECV_TIMEOUT_MS) ?: throw HandshakeError("no peer Hello (timeout/closed)")

    if (peerHello.optString("type") != "hello") {
      throw HandshakeError("expected hello, got ${peerHello.optString("type")}")
    }
    val caps = peerHello.optJSONArray("capabilities")
    var hasV1 = false
    if (caps != null) for (i in 0 until caps.length()) if (caps.optString(i) == "v1") hasV1 = true
    if (!hasV1) throw HandshakeError("no shared capability")
    val peerPopNonce = peerHello.optString("pop_nonce", "")
    if (peerPopNonce.length < 16) throw HandshakeError("peer pop_nonce missing/short")
    val peerEphB64 = peerHello.optString("ephemeral_x25519_pubkey", "")
    if (peerEphB64.isEmpty()) throw HandshakeError("peer too old (no ephemeral pubkey)")
    val peerEph = MeshCrypto.b64UrlDecode(peerEphB64)
    if (peerEph.size != MeshCrypto.X25519_PUBKEY_BYTES) {
      throw HandshakeError("peer ephemeral pubkey wrong length ${peerEph.size}")
    }
    if (peerHello.optInt("v", 0) < 3) throw HandshakeError("peer wire version < 3")

    val claimedPubkeyB64 =
      peerHello.strOrNull("device_pubkey_b64")
        ?: throw HandshakeError("peer missing device_pubkey_b64")
    val claimedPubkeyBytes =
      try {
        MeshBase64.decode(claimedPubkeyB64)
      } catch (e: Throwable) {
        throw HandshakeError("peer device_pubkey_b64 malformed")
      }
    if (claimedPubkeyBytes.size != 32) throw HandshakeError("peer device_pubkey_b64 wrong length")
    val claimedDeviceId =
      peerHello.strOrNull("device_id") ?: throw HandshakeError("peer missing device_id")

    val peerBundle = ArrayList<MeshEvent>()
    peerHello.optJSONArray("proof_bundle")?.let { pb ->
      for (i in 0 until pb.length()) peerBundle.add(MeshEvent.fromWire(pb.getJSONObject(i)))
    }
    val peerBundleIds = peerBundle.map { it.eventId }

    // --- Chain verdict (BACKGROUND: must be an already-bound member) ----------
    val verdict =
      MeshTrust.verifyPeerProof(
        p.vaultId,
        p.anchorPubkeyB64,
        p.serverWitnessPubkeysB64,
        p.localMembershipEvents,
        peerBundle,
        claimedPubkeyB64,
      )
    val ok =
      verdict as? MeshTrust.ProofVerdict.Ok
        ?: throw HandshakeError(
          "peer membership refused: ${(verdict as MeshTrust.ProofVerdict.Fail).reason}",
        )
    if (ok.deviceId != claimedDeviceId) {
      throw HandshakeError("peer device_id $claimedDeviceId != chain binding ${ok.deviceId}")
    }

    // --- Proof of possession -------------------------------------------------
    val ourSig =
      MeshCrypto.ed25519Sign(
        buildPopMessageV3(ownBundleIds, peerPopNonce, ourEph.publicKey, peerEph),
        p.deviceSeed,
      )
    conn.sendJson(
      JSONObject().apply {
        put("type", "pop_proof")
        put("v", 3)
        put("sig", MeshCrypto.b64UrlEncode(ourSig))
      },
    )
    val peerProof =
      conn.recvJson(POP_RECV_TIMEOUT_MS) ?: throw HandshakeError("no peer PoP (timeout/closed)")
    if (peerProof.optString("type") != "pop_proof") throw HandshakeError("expected pop_proof")
    val peerSig =
      try {
        MeshCrypto.b64UrlDecode(peerProof.optString("sig", ""))
      } catch (e: Throwable) {
        throw HandshakeError("peer PoP sig malformed")
      }
    if (peerSig.size != 64) throw HandshakeError("peer PoP sig wrong length ${peerSig.size}")
    // Verify against THEIR bundle ids + OUR nonce + their ephemeral first.
    val popMsg = buildPopMessageV3(peerBundleIds, ourNonceB64, peerEph, ourEph.publicKey)
    if (!MeshCrypto.ed25519Verify(peerSig, popMsg, claimedPubkeyBytes)) {
      throw HandshakeError("peer PoP verification failed")
    }

    // --- AEAD: derive + install (ledger traffic encrypted from here) ---------
    val aead =
      MeshCrypto.deriveSessionAead(
        ourEph.privateKey,
        ourEph.publicKey,
        peerEph,
        ourNonceB64,
        peerPopNonce,
      )
    conn.installAead(aead)
    conn.remoteDeviceId = claimedDeviceId

    return Session(
      peerDeviceId = claimedDeviceId,
      peerDevicePubkeyB64 = claimedPubkeyB64,
      accountId = ok.accountId,
      role = ok.role,
      peerBtMac = peerHello.strOrNull("bt_mac"),
    )
  }
}
