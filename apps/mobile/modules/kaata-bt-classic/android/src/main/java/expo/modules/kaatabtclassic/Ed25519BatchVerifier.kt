package expo.modules.kaatabtclassic

import expo.modules.kaatabtclassic.mesh.MeshBase64
import expo.modules.kaatabtclassic.mesh.MeshCrypto
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** Optional acceleration of public, exact-message signature checks only.
 *
 * A true result is deliberately stricter than the app's Noble 2.3 ZIP215
 * verifier: standard canonical base64, canonical points/scalar (enforced by
 * BouncyCastle), a nonzero prime-order public key, and nonidentity R. On this subset Noble
 * hashes the same A/R encodings, and the native verification equation implies
 * Noble's cofactored equation. False is NOT an authoritative rejection: callers
 * must still use their original verifier. No membership or freshness policy
 * belongs here, and no private keys or persistent state are used.
 */
object Ed25519BatchVerifier {
  const val MAX_ITEMS = 64
  const val MAX_MESSAGE_BYTES = 16 * 1024
  const val MAX_TOTAL_MESSAGE_BYTES = 256 * 1024
  private const val MAX_MESSAGE_BASE64 = ((MAX_MESSAGE_BYTES + 2) / 3) * 4

  private data class Request(val message: ByteArray, val signature: ByteArray, val publicKey: ByteArray)

  fun verify(items: List<Map<String, String>>): List<Boolean> {
    require(items.size <= MAX_ITEMS) { "Too many signature checks" }
    // Check encoded sizes before allocating decoded messages or doing crypto.
    var encodedBytes = 0
    for (item in items) {
      val size = item["messageBase64"]?.length ?: 0
      require(size <= MAX_MESSAGE_BASE64) { "Signature message is too large" }
      encodedBytes += size
    }
    require(encodedBytes <= ((MAX_TOTAL_MESSAGE_BYTES + 2) / 3) * 4 + MAX_ITEMS * 4) {
      "Signature batch is too large"
    }
    val requests = items.map { decode(it) }
    require(requests.sumOf { it?.message?.size ?: 0 } <= MAX_TOTAL_MESSAGE_BYTES) {
      "Signature batch is too large"
    }
    // Repeated events commonly share a device key. The subgroup check is pure
    // but costly; reuse it within this one bounded request, never globally.
    val primeOrderKeys = mutableMapOf<String, Boolean>()
    return requests.mapIndexed { index, request ->
      if (request == null) false
      else try {
        val key = items[index].getValue("publicKeyBase64")
        val primeOrder = primeOrderKeys.getOrPut(key) {
          Ed25519.validatePublicKeyFull(request.publicKey, 0)
        }
        primeOrder && MeshCrypto.ed25519Verify(request.signature, request.message, request.publicKey)
      } catch (_: Exception) {
        false
      }
    }
  }

  private fun decode(item: Map<String, String>): Request? {
    val messageText = item["messageBase64"] ?: return null
    val signatureText = item["signatureBase64"] ?: return null
    val publicKeyText = item["publicKeyBase64"] ?: return null
    // Exact canonical encodings also prevent the mesh decoder's permissive
    // padding/URL alphabet rules from accepting text that JS atob rejects.
    if (signatureText.length != 88 || publicKeyText.length != 44) return null
    return try {
      val message = decodeCanonical(messageText) ?: return null
      require(message.size <= MAX_MESSAGE_BYTES) { "Signature message is too large" }
      val signature = decodeCanonical(signatureText) ?: return null
      val publicKey = decodeCanonical(publicKeyText) ?: return null
      if (signature.size != 64 || publicKey.size != 32) return null
      // Noble 2.3 serializes decoded R before hashing. Its Point.toBytes rejects
      // identity, whereas an ordinary RFC8032 verifier can accept nonce-zero
      // signatures. Leave this implementation-specific edge to Noble too.
      if (signature[0] == 1.toByte() && (1 until 32).all { signature[it] == 0.toByte() }) return null
      Request(message, signature, publicKey)
    } catch (_: IllegalArgumentException) {
      null
    }
  }

  private fun decodeCanonical(text: String): ByteArray? {
    val decoded = MeshBase64.decode(text)
    return if (MeshBase64.encodeStd(decoded) == text) decoded else null
  }
}
