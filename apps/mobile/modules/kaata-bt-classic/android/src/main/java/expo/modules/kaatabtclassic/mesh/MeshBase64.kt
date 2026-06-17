package expo.modules.kaatabtclassic.mesh

/**
 * Pure-Kotlin base64 — standard (with padding, == JS btoa / event-sig.ts) and
 * URL-safe no-padding (== aead.ts bytesToB64Url). Pure so the mesh crypto is
 * unit-testable on a plain JVM (android.util.Base64 is stubbed in unit tests)
 * AND works on every API level (java.util.Base64 is API 26+). decode() accepts
 * BOTH alphabets and optional padding.
 */
object MeshBase64 {
  private const val STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  private const val URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

  fun encodeStd(data: ByteArray): String = encode(data, STD, true)

  fun encodeUrl(data: ByteArray): String = encode(data, URL, false)

  private fun encode(data: ByteArray, alphabet: String, pad: Boolean): String {
    val sb = StringBuilder((data.size + 2) / 3 * 4)
    var i = 0
    while (i + 3 <= data.size) {
      val n =
        ((data[i].toInt() and 0xff) shl 16) or
          ((data[i + 1].toInt() and 0xff) shl 8) or
          (data[i + 2].toInt() and 0xff)
      sb.append(alphabet[(n ushr 18) and 63])
      sb.append(alphabet[(n ushr 12) and 63])
      sb.append(alphabet[(n ushr 6) and 63])
      sb.append(alphabet[n and 63])
      i += 3
    }
    when (data.size - i) {
      1 -> {
        val n = (data[i].toInt() and 0xff) shl 16
        sb.append(alphabet[(n ushr 18) and 63])
        sb.append(alphabet[(n ushr 12) and 63])
        if (pad) sb.append("==")
      }
      2 -> {
        val n = ((data[i].toInt() and 0xff) shl 16) or ((data[i + 1].toInt() and 0xff) shl 8)
        sb.append(alphabet[(n ushr 18) and 63])
        sb.append(alphabet[(n ushr 12) and 63])
        sb.append(alphabet[(n ushr 6) and 63])
        if (pad) sb.append("=")
      }
    }
    return sb.toString()
  }

  fun decode(s: String): ByteArray {
    val out = java.io.ByteArrayOutputStream(s.length * 3 / 4 + 3)
    var buf = 0
    var bits = 0
    for (ch in s) {
      if (ch == '=' || ch == '\n' || ch == '\r' || ch == ' ') continue
      val v =
        when (ch) {
          in 'A'..'Z' -> ch - 'A'
          in 'a'..'z' -> ch - 'a' + 26
          in '0'..'9' -> ch - '0' + 52
          '+', '-' -> 62
          '/', '_' -> 63
          else -> throw IllegalArgumentException("invalid base64 char: $ch")
        }
      buf = (buf shl 6) or v
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out.write((buf ushr bits) and 0xff)
      }
    }
    return out.toByteArray()
  }
}
