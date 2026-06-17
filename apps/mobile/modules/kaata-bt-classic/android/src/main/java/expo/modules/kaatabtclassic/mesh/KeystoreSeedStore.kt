package expo.modules.kaatabtclassic.mesh

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypted-at-rest store for the device Ed25519 SEED the native background
 * engine needs to sign proof-of-possession after a swipe-kill — Briar-parity
 * step 12 (the one device-key integration).
 *
 * The seed lives in expo-secure-store (JS-managed, AndroidKeyStore-encrypted). To
 * make the resident native engine self-sufficient (Briar's worker holds its keys),
 * JS injects the seed at foreground via KaataBtClassicModule.setMeshDeviceSeed,
 * and we store it here encrypted with an AndroidKeyStore AES-256-GCM key — same
 * security class as expo-secure-store, but readable by the post-kill engine with a
 * plain Context. NOT plaintext (a bare SharedPrefs private key would be a
 * regression). Never throws into the engine path; all errors -> null/no-op.
 */
object KeystoreSeedStore {
  private const val TAG = "KeystoreSeedStore"
  private const val ALIAS = "kaata_mesh_seed_aes"
  private const val PREFS = "kaata_mesh_seed"
  private const val KEY = "seed" // base64(iv || ciphertext+tag)
  private const val GCM_IV_LEN = 12
  private const val GCM_TAG_BITS = 128

  private fun getOrCreateKey(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    kg.init(
      KeyGenParameterSpec.Builder(
        ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return kg.generateKey()
  }

  /** Store the seed encrypted (called from JS at foreground). */
  fun setSeed(ctx: Context, seed: ByteArray): Boolean =
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
      val iv = cipher.iv
      val ct = cipher.doFinal(seed)
      val combined = iv + ct
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY, Base64.encodeToString(combined, Base64.NO_WRAP))
        .apply()
      true
    } catch (e: Throwable) {
      Log.w(TAG, "setSeed failed", e)
      false
    }

  /** Read + decrypt the seed (called by the engine). null if absent/unreadable. */
  fun getSeed(ctx: Context): ByteArray? =
    try {
      val s = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
      if (s == null) {
        null
      } else {
        val combined = Base64.decode(s, Base64.NO_WRAP)
        if (combined.size <= GCM_IV_LEN) {
          null
        } else {
          val iv = combined.copyOfRange(0, GCM_IV_LEN)
          val ct = combined.copyOfRange(GCM_IV_LEN, combined.size)
          val cipher = Cipher.getInstance("AES/GCM/NoPadding")
          cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
          cipher.doFinal(ct)
        }
      }
    } catch (e: Throwable) {
      Log.w(TAG, "getSeed failed", e)
      null
    }
}
