package expo.modules.kaatabtclassic.mesh

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.digests.SHA512Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.SecureRandom

/**
 * Native mesh crypto — Briar-parity rewrite, step 1.
 *
 * A byte-for-byte Kotlin port of the JS crypto the mesh protocol uses, so the
 * native engine speaks the EXACT same wire crypto as lib/mesh/{device-key,aead}.ts:
 *   - Ed25519 identity sign/verify           (device-key.ts, @noble/ed25519, RFC 8032)
 *   - X25519 ECDH (ephemeral, per session)   (aead.ts, @noble/curves)
 *   - HKDF-SHA512 session-key derivation     (aead.ts, @noble/hashes/hkdf)
 *   - ChaCha20-Poly1305 IETF frame AEAD       (aead.ts, @noble/ciphers, 12-byte nonce)
 *
 * Implemented on BouncyCastle's lightweight low-level API (no JCE provider
 * registration → no clash with Android's bundled BC). Every constant + the
 * salt/nonce layout MUST stay identical to aead.ts or native<->native sessions
 * (and any future native<->JS interop) silently fail to decrypt.
 *
 * Correctness vs the JS reference is verified by parity test vectors before
 * cutover (the JS emits known input->output; Kotlin must reproduce them).
 */
object MeshCrypto {

  // --- constants (MUST match aead.ts) ---------------------------------------
  const val AEAD_KEY_BYTES = 32
  const val X25519_PUBKEY_BYTES = 32
  const val NONCE_BYTES = 12
  const val TAG_BYTES = 16
  const val ED25519_SEED_BYTES = 32
  const val ED25519_PUBKEY_BYTES = 32
  const val ED25519_SIG_BYTES = 64

  // aead.ts HKDF_INFO = TextEncoder().encode("kaata-mesh-aead-v2")
  private val HKDF_INFO = "kaata-mesh-aead-v2".toByteArray(Charsets.UTF_8)

  private val secureRandom = SecureRandom()

  class MeshCryptoError(message: String) : Exception(message)

  // --- base64url (matches aead.ts bytesToB64Url / b64UrlToBytes) -------------
  fun b64UrlEncode(bytes: ByteArray): String = MeshBase64.encodeUrl(bytes)

  fun b64UrlDecode(s: String): ByteArray = MeshBase64.decode(s)

  // --- hashes ---------------------------------------------------------------
  fun sha256(data: ByteArray): ByteArray {
    val d = SHA256Digest()
    d.update(data, 0, data.size)
    val out = ByteArray(d.digestSize)
    d.doFinal(out, 0)
    return out
  }

  fun sha512(data: ByteArray): ByteArray {
    val d = SHA512Digest()
    d.update(data, 0, data.size)
    val out = ByteArray(d.digestSize)
    d.doFinal(out, 0)
    return out
  }

  // --- Ed25519 identity (device-key.ts) -------------------------------------
  /** 32-byte Ed25519 public key from a 32-byte seed (== @noble getPublicKey). */
  fun ed25519PublicKeyFromSeed(seed: ByteArray): ByteArray {
    require(seed.size == ED25519_SEED_BYTES) { "ed25519 seed must be 32 bytes" }
    return Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
  }

  /** 64-byte Ed25519 signature (== @noble ed25519.sign(message, seed)). */
  fun ed25519Sign(message: ByteArray, seed: ByteArray): ByteArray {
    require(seed.size == ED25519_SEED_BYTES) { "ed25519 seed must be 32 bytes" }
    val signer = Ed25519Signer()
    signer.init(true, Ed25519PrivateKeyParameters(seed, 0))
    signer.update(message, 0, message.size)
    return signer.generateSignature()
  }

  /** Verify a 64-byte Ed25519 signature against a 32-byte pubkey. Never throws. */
  fun ed25519Verify(sig: ByteArray, message: ByteArray, pubkey: ByteArray): Boolean {
    if (sig.size != ED25519_SIG_BYTES || pubkey.size != ED25519_PUBKEY_BYTES) return false
    return try {
      val verifier = Ed25519Signer()
      verifier.init(false, Ed25519PublicKeyParameters(pubkey, 0))
      verifier.update(message, 0, message.size)
      verifier.verifySignature(sig)
    } catch (e: Throwable) {
      false
    }
  }

  // --- X25519 ephemeral key agreement (aead.ts) -----------------------------
  data class EphemeralKeyPair(val privateKey: ByteArray, val publicKey: ByteArray)

  /** Fresh per-session X25519 keypair (== aead.ts generateEphemeralKeyPair). */
  fun generateEphemeralKeyPair(): EphemeralKeyPair {
    val priv = ByteArray(32)
    secureRandom.nextBytes(priv)
    val params = X25519PrivateKeyParameters(priv, 0)
    return EphemeralKeyPair(params.encoded, params.generatePublicKey().encoded)
  }

  fun x25519PublicKey(priv: ByteArray): ByteArray =
    X25519PrivateKeyParameters(priv, 0).generatePublicKey().encoded

  /** Raw X25519 shared secret (== @noble x25519.getSharedSecret). Throws on the
   *  all-zero contributory-behaviour result, matching @noble. */
  fun x25519SharedSecret(priv: ByteArray, peerPub: ByteArray): ByteArray {
    val agreement = X25519Agreement()
    agreement.init(X25519PrivateKeyParameters(priv, 0))
    val out = ByteArray(agreement.agreementSize)
    // BC throws IllegalStateException on an all-zero (illegal) result.
    agreement.calculateAgreement(X25519PublicKeyParameters(peerPub, 0), out, 0)
    return out
  }

  // --- HKDF-SHA512 (aead.ts) ------------------------------------------------
  fun hkdfSha512(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
    val gen = HKDFBytesGenerator(SHA512Digest())
    gen.init(HKDFParameters(ikm, salt, info))
    val out = ByteArray(length)
    gen.generateBytes(out, 0, length)
    return out
  }

  // --- ChaCha20-Poly1305 IETF (aead.ts) -------------------------------------
  fun chacha20poly1305Encrypt(
    key: ByteArray,
    nonce: ByteArray,
    aad: ByteArray,
    plaintext: ByteArray,
  ): ByteArray {
    val cipher = ChaCha20Poly1305()
    cipher.init(true, AEADParameters(KeyParameter(key), TAG_BYTES * 8, nonce, aad))
    val out = ByteArray(cipher.getOutputSize(plaintext.size))
    var len = cipher.processBytes(plaintext, 0, plaintext.size, out, 0)
    len += cipher.doFinal(out, len)
    return if (len == out.size) out else out.copyOf(len)
  }

  /** Throws MeshCryptoError on auth failure. */
  fun chacha20poly1305Decrypt(
    key: ByteArray,
    nonce: ByteArray,
    aad: ByteArray,
    ciphertext: ByteArray,
  ): ByteArray {
    val cipher = ChaCha20Poly1305()
    cipher.init(false, AEADParameters(KeyParameter(key), TAG_BYTES * 8, nonce, aad))
    val out = ByteArray(cipher.getOutputSize(ciphertext.size))
    return try {
      var len = cipher.processBytes(ciphertext, 0, ciphertext.size, out, 0)
      len += cipher.doFinal(out, len)
      if (len == out.size) out else out.copyOf(len)
    } catch (e: Throwable) {
      throw MeshCryptoError("ChaCha20-Poly1305 decrypt/verify failed: ${e.message}")
    }
  }

  // --- per-session AEAD context (aead.ts deriveSessionAead / seal / open) ----
  class AeadContext(
    val key: ByteArray,
    val sendDirectionTag: Int,
    val recvDirectionTag: Int,
    var sendCounter: Long,
    var recvLastCounter: Long,
  )

  /**
   * Derive the session ChaCha20-Poly1305 key + per-direction nonce prefixes.
   * Exact port of aead.ts deriveSessionAead — the salt is
   * initiatorNonce || responderNonce || initiatorPub || responderPub, ordered by
   * lexicographic comparison of the two ephemeral pubkeys, info="kaata-mesh-aead-v2".
   */
  fun deriveSessionAead(
    ownPriv: ByteArray,
    ownPub: ByteArray,
    peerPub: ByteArray,
    ownNonceB64: String,
    peerNonceB64: String,
  ): AeadContext {
    if (peerPub.size != X25519_PUBKEY_BYTES) {
      throw MeshCryptoError("peer X25519 pubkey wrong length ${peerPub.size}")
    }
    if (peerPub.all { it.toInt() == 0 }) {
      throw MeshCryptoError("peer X25519 pubkey is all zero (illegal)")
    }
    if (ownPub.size == peerPub.size && ownPub.contentEquals(peerPub)) {
      throw MeshCryptoError("peer X25519 pubkey identical to ours (would force nonce reuse)")
    }

    val sharedSecret = x25519SharedSecret(ownPriv, peerPub)

    val ownNonceRaw = b64UrlDecode(ownNonceB64)
    val peerNonceRaw = b64UrlDecode(peerNonceB64)
    val initiatorIsUs = lexLess(ownPub, peerPub)
    val initiatorNonce = if (initiatorIsUs) ownNonceRaw else peerNonceRaw
    val responderNonce = if (initiatorIsUs) peerNonceRaw else ownNonceRaw
    val initiatorPub = if (initiatorIsUs) ownPub else peerPub
    val responderPub = if (initiatorIsUs) peerPub else ownPub

    val salt = ByteArray(
      initiatorNonce.size + responderNonce.size + initiatorPub.size + responderPub.size
    )
    var off = 0
    initiatorNonce.copyInto(salt, off); off += initiatorNonce.size
    responderNonce.copyInto(salt, off); off += responderNonce.size
    initiatorPub.copyInto(salt, off); off += initiatorPub.size
    responderPub.copyInto(salt, off)

    val key = hkdfSha512(sharedSecret, salt, HKDF_INFO, AEAD_KEY_BYTES)

    return AeadContext(
      key = key,
      sendDirectionTag = if (initiatorIsUs) 0x00000000 else 0x00000001,
      recvDirectionTag = if (initiatorIsUs) 0x00000001 else 0x00000000,
      sendCounter = 0L,
      recvLastCounter = -1L,
    )
  }

  /** Seal one chunk; advances sendCounter. aad = the frame header. */
  fun sealChunk(plaintext: ByteArray, aad: ByteArray, aead: AeadContext): ByteArray {
    val nonce = buildNonce(aead.sendDirectionTag, aead.sendCounter)
    val ct = chacha20poly1305Encrypt(aead.key, nonce, aad, plaintext)
    aead.sendCounter += 1L
    return ct
  }

  /** Open one chunk with strict monotonic replay protection; advances recvLastCounter. */
  fun openChunk(ciphertext: ByteArray, aad: ByteArray, aead: AeadContext): ByteArray {
    val expected = aead.recvLastCounter + 1L
    val nonce = buildNonce(aead.recvDirectionTag, expected)
    val pt = chacha20poly1305Decrypt(aead.key, nonce, aad, ciphertext)
    aead.recvLastCounter = expected
    return pt
  }

  /** 12-byte nonce: 4-byte BE direction tag, 8-byte BE u64 counter (aead.ts buildNonce). */
  fun buildNonce(directionTag: Int, counter: Long): ByteArray {
    val n = ByteArray(NONCE_BYTES)
    n[0] = ((directionTag ushr 24) and 0xff).toByte()
    n[1] = ((directionTag ushr 16) and 0xff).toByte()
    n[2] = ((directionTag ushr 8) and 0xff).toByte()
    n[3] = (directionTag and 0xff).toByte()
    var v = counter
    for (i in 11 downTo 4) {
      n[i] = (v and 0xff).toByte()
      v = v ushr 8
    }
    return n
  }

  /** Lexicographic comparison of unsigned bytes: true iff a < b (aead.ts lexLess). */
  private fun lexLess(a: ByteArray, b: ByteArray): Boolean {
    val n = minOf(a.size, b.size)
    for (i in 0 until n) {
      val ai = a[i].toInt() and 0xff
      val bi = b[i].toInt() and 0xff
      if (ai != bi) return ai < bi
    }
    return a.size < b.size
  }
}
