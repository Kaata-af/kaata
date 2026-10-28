package expo.modules.kaatabtclassic.mesh

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MeshEntryCurrencyCompatibilityTest {
  private val seed = ByteArray(32) { 2 }
  private val pubkey = MeshCrypto.ed25519PublicKeyFromSeed(seed)
  private val caps = JSONArray().put("multi-currency-v1").put("entry-currency-edit-v1")

  private fun transcript(nonce: String = "nonce123") = MeshHandshake.buildPopMessageV3(
    listOf("evt-b", "evt-a", "evt-c"), nonce, ByteArray(32) { 0x33 }, ByteArray(32) { 0x44 },
  )

  @Test
  fun feature_transcript_matches_the_js_domain_and_original_pop() {
    val pop = transcript()
    val message = MeshHandshake.buildEntryCurrencyEditPopMessage(pop)
    // Shared verbatim with mesh-entry-currency-selftest.ts (Ed25519 seed 0x02).
    val expectedHex = "6b616174612d656e7472792d63757272656e63792d656469742d7631" +
      "6b616174612d706f702d76331ad368e097d0d51fd3c67d1c86d2ec65736bc07d4cb2e0afaaa0ada19051c7d3" +
      "6e6f6e6365313233" + "33".repeat(32) + "44".repeat(32)
    assertEquals(expectedHex, message.joinToString("") { "%02x".format(it) })
    assertArrayEquals(
      "kaata-entry-currency-edit-v1".toByteArray(Charsets.UTF_8) + pop,
      message,
    )
    val signature = MeshCrypto.b64UrlEncode(MeshCrypto.ed25519Sign(
      message, seed,
    ))
    assertEquals("Gc3tLgM8gLztUi-SMc_wk2DAmLMja_-1L4pzJg5sbh-PcL1YVoPey1A7jj5QYP_BRyWLZig61iEGCOcsgOxZDg", signature)
    assertTrue(MeshHandshake.verifiesEntryCurrencyEditSupport(caps, signature, pop, pubkey))
    assertFalse(MeshHandshake.verifiesEntryCurrencyEditSupport(caps, signature, transcript("new-session"), pubkey))
    assertFalse(MeshHandshake.verifiesEntryCurrencyEditSupport(caps, signature, pop,
      MeshCrypto.ed25519PublicKeyFromSeed(ByteArray(32) { 3 })))
    assertFalse(MeshHandshake.verifiesEntryCurrencyEditSupport(
      JSONArray().put("multi-currency-v1"), signature, pop, pubkey,
    ))
  }

  @Test
  fun unsigned_hello_or_original_pop_never_authorizes_currency_edits() {
    val pop = transcript()
    assertFalse(MeshHandshake.verifiesEntryCurrencyEditSupport(caps, null, pop, pubkey))
    assertFalse(MeshHandshake.verifiesEntryCurrencyEditSupport(caps, "bad-signature", pop, pubkey))
    val originalProof = MeshCrypto.b64UrlEncode(MeshCrypto.ed25519Sign(pop, seed))
    assertFalse(MeshHandshake.verifiesEntryCurrencyEditSupport(caps, originalProof, pop, pubkey))
  }

  @Test
  fun only_affected_books_require_a_supported_peer_and_feature_arrival_is_rechecked() {
    var affected = false
    MeshAntiEntropy.requireCurrencyCompatible(false) { affected }
    affected = true
    try {
      MeshAntiEntropy.requireCurrencyCompatible(false) { affected }
      fail("an older peer must be refused when the book starts using currency edits")
    } catch (error: MeshHandshake.HandshakeError) {
      assertTrue(error.message!!.contains("Update the other phone"))
    }
    MeshAntiEntropy.requireCurrencyCompatible(true) { fail("supported peers do not scan history"); true }
  }

  @Test
  fun both_delta_directions_detect_currency_amendments_without_changing_ordinary_events() {
    fun event(type: String, changes: JSONObject) = JSONObject().put("event_type", type)
      .put("payload", JSONObject().put("changes", changes))
    assertFalse(MeshAntiEntropy.batchUsesEntryCurrencyEdits(listOf(
      event("entry_amended", JSONObject().put("amount", 123)),
      event("entry_created", JSONObject().put("currency", "USD")),
    )))
    assertTrue(MeshAntiEntropy.batchUsesEntryCurrencyEdits(listOf(
      event("entry_amended", JSONObject().put("amount", 123).put("currency", "USD")),
    )))
    assertTrue(MeshAntiEntropy.batchUsesEntryCurrencyEdits(listOf(
      event("entry_amended", JSONObject().put("currency", JSONObject.NULL)),
    )))
  }
}
