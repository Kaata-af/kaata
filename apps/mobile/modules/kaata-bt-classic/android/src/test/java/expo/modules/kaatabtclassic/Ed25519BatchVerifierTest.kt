package expo.modules.kaatabtclassic

import expo.modules.kaatabtclassic.mesh.MeshBase64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class Ed25519BatchVerifierTest {
  private fun fixture(): JSONObject {
    val stream = javaClass.classLoader!!.getResourceAsStream("ed25519-noble-2.3.0.json")!!
    return stream.bufferedReader().use { JSONObject(it.readText()) }
  }

  private fun request(vector: JSONObject): Map<String, String> = mapOf(
    "messageBase64" to vector.getString("messageBase64"),
    "signatureBase64" to vector.getString("signatureBase64"),
    "publicKeyBase64" to vector.getString("publicKeyBase64"),
  )

  @Test
  fun every_native_acceptance_is_accepted_by_the_installed_noble_policy() {
    val root = fixture()
    assertEquals("2.3.0", root.getString("nobleVersion"))
    val json = root.getJSONArray("vectors")
    val vectors = (0 until json.length()).map { json.getJSONObject(it) }
    var nativeSuccesses = 0
    var nobleOnlySuccesses = 0
    val covered = mutableSetOf<String>()
    for (batch in vectors.chunked(32)) {
      val results = Ed25519BatchVerifier.verify(batch.map { request(it) })
      assertEquals(batch.size, results.size)
      for ((index, vector) in batch.withIndex()) {
        val actual = results[index]
        val expectedNoble = vector.getBoolean("noble")
        covered.add(vector.getString("category"))
        assertFalse("Native must never widen Noble acceptance: ${vector.getString("name")}", actual && !expectedNoble)
        if (!vector.isNull("requiredNative")) {
          assertEquals(vector.getString("name"), vector.getBoolean("requiredNative"), actual)
        }
        if (actual) nativeSuccesses++
        if (!actual && expectedNoble) nobleOnlySuccesses++
      }
    }
    assertTrue("ordinary and random signatures must actually use native acceleration", nativeSuccesses >= 32)
    assertTrue("ZIP215-only signatures must remain available through JS fallback", nobleOnlySuccesses >= 64)
    assertEquals(setOf("canonical", "random-valid", "tampered", "malformed", "scalar", "torsion", "noncanonical", "sign-zero", "identity-R", "mixed-order", "base64"), covered)
  }

  @Test
  fun malformed_rows_do_not_change_the_position_or_outcome_of_valid_neighbors() {
    val good = request(fixture().getJSONArray("vectors").getJSONObject(0))
    val rows = listOf(good, emptyMap(), good + ("signatureBase64" to "!".repeat(88)), good)
    assertEquals(listOf(true, false, false, true), Ed25519BatchVerifier.verify(rows))
    assertEquals(emptyList<Boolean>(), Ed25519BatchVerifier.verify(emptyList()))
  }

  @Test
  fun batch_and_message_memory_limits_are_enforced() {
    val good = request(fixture().getJSONArray("vectors").getJSONObject(0))
    assertEquals(List(64) { true }, Ed25519BatchVerifier.verify(List(64) { good }))
    assertThrows(IllegalArgumentException::class.java) { Ed25519BatchVerifier.verify(List(65) { good }) }
    val oversized = good + ("messageBase64" to MeshBase64.encodeStd(ByteArray(Ed25519BatchVerifier.MAX_MESSAGE_BYTES + 4)))
    assertThrows(IllegalArgumentException::class.java) { Ed25519BatchVerifier.verify(listOf(oversized)) }
    val large = good + ("messageBase64" to MeshBase64.encodeStd(ByteArray(Ed25519BatchVerifier.MAX_MESSAGE_BYTES)))
    assertThrows(IllegalArgumentException::class.java) { Ed25519BatchVerifier.verify(List(17) { large }) }
  }
}
