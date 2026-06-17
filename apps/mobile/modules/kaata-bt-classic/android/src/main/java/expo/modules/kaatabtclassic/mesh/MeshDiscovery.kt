package expo.modules.kaatabtclassic.mesh

/**
 * RFCOMM UUID + daily vault digest — Briar-parity step 11 (pure, parity-tested).
 *
 * Port of transport-btc.ts deriveRfcommUuid + vault-digest.ts. The native engine
 * derives the SAME per-(vault,day) RFCOMM service UUID every member computes, so
 * accept/dial rendezvous works without any central coordination. The digest is
 * HMAC-SHA256 keyed on the vault_id (members share it, outsiders don't) and
 * rotates daily for unlinkability.
 *
 *   steadyUuid(vault, day) = deriveRfcommUuid("steady:" + vaultDigest(vault, day))
 */
object MeshDiscovery {
  private const val MS_PER_DAY = 86_400_000L
  private const val DIGEST_BYTES = 8
  private const val DOMAIN = "kaata-mesh-day:"

  /** UTC day number for a wall-clock ms (vault-digest.ts dayNumber). */
  fun dayNumber(nowMs: Long): Long = Math.floorDiv(nowMs, MS_PER_DAY)

  /** 8-byte daily digest for (vault_id, day), base64url (vault-digest.ts). */
  fun vaultDigest(vaultId: String, day: Long): String {
    val key = vaultId.toByteArray(Charsets.UTF_8)
    val msg = (DOMAIN + day.toString()).toByteArray(Charsets.UTF_8)
    val mac = MeshCrypto.hmacSha256(key, msg)
    return MeshBase64.encodeUrl(mac.copyOf(DIGEST_BYTES))
  }

  /** Days a publisher advertises: today + tomorrow. */
  fun advertiseDays(nowMs: Long): List<Long> {
    val d = dayNumber(nowMs)
    return listOf(d, d + 1)
  }

  /** Days a scanner accepts: yesterday, today, tomorrow. */
  fun acceptableScanDays(nowMs: Long): List<Long> {
    val d = dayNumber(nowMs)
    return listOf(d - 1, d, d + 1)
  }

  /** Derive a UUID from a secret (transport-btc.ts deriveRfcommUuid). */
  fun deriveRfcommUuid(secret: String): String {
    val h = MeshCrypto.sha256(("kaata-rfcomm-uuid:" + secret).toByteArray(Charsets.UTF_8))
    val hex = h.copyOf(16).joinToString("") { "%02x".format(it) }
    return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-" +
      "${hex.substring(16, 20)}-${hex.substring(20, 32)}"
  }

  /** The steady-sync RFCOMM UUID for a vault on a given day. */
  fun steadyUuid(vaultId: String, day: Long): String =
    deriveRfcommUuid("steady:" + vaultDigest(vaultId, day))
}
