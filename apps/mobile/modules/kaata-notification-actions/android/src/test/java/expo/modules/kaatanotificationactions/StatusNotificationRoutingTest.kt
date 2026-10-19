package expo.modules.kaatanotificationactions

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class StatusNotificationRoutingTest {
  private fun route(
    action: String? = FCM_RECEIVE_ACTION,
    messageType: String? = null,
    enabled: String? = "1",
    legacyEnabled: String? = null,
    noUi: String? = null,
    kind: String? = "entry_created",
  ) = shouldRouteStatusNotification(action, messageType, enabled, legacyEnabled, noUi, kind)

  @Test
  fun onlyTheThreeVisibleTallyEventsUseNativeRouting() {
    for (kind in listOf("entry_created", "entry_accepted", "entry_rejected")) {
      assertTrue(route(kind = kind))
      assertTrue(route(messageType = "gcm", kind = kind))
      assertTrue(route(enabled = null, legacyEnabled = "1", kind = kind))
    }
    for (kind in listOf(null, "", "entry_voided", "customer_reminder", "unknown", "ENTRY_CREATED", " entry_created")) {
      assertFalse(route(kind = kind))
    }
  }

  @Test
  fun dataOnlyMalformedAndNonMessageEventsKeepDefaultHandling() {
    for (flag in listOf(null, "", "0", "true", "garbled")) {
      assertFalse(route(enabled = flag))
    }
    assertTrue(route(enabled = "0", legacyEnabled = "1"))
    for (messageType in listOf("", "deleted_messages", "send_event", "send_error", "unknown")) {
      assertFalse(route(messageType = messageType))
    }
    for (action in listOf(null, "", "com.google.firebase.messaging.NEW_TOKEN", "com.google.firebase.messaging.RECEIVE_DIRECT_BOOT")) {
      assertFalse(route(action = action))
    }
  }

  @Test
  fun explicitNoUiRetainsFirebaseSuppression() {
    for (noUi in listOf("1", "true", "TRUE", "TrUe")) assertFalse(route(noUi = noUi))
    for (noUi in listOf(null, "", "0", "false", "garbled")) assertTrue(route(noUi = noUi))
  }

  @Test
  fun nestedOrdinaryAndRoutedMessagesRestoreTheOuterOriginal() {
    val slot = ThreadLocal<Any>()
    val previous = Any()
    val original = Any()
    val nested = Any()
    slot.set(previous)
    withScopedRoutedMessage(slot, original) {
      assertSame(original, slot.get())
      withScopedRoutedMessage(slot, null) {
        assertNull(slot.get())
        withScopedRoutedMessage(slot, nested) { assertSame(nested, slot.get()) }
        assertNull(slot.get())
      }
      assertSame(original, slot.get())
    }
    assertSame(previous, slot.get())
  }

  @Test
  fun throwingCallbacksDoNotLeakTheOriginalIntoLaterMessages() {
    val slot = ThreadLocal<Any>()
    assertThrows(IllegalStateException::class.java) {
      withScopedRoutedMessage(slot, Any()) { throw IllegalStateException("synthetic") }
    }
    assertNull(slot.get())
    val previous = Any()
    slot.set(previous)
    assertThrows(IllegalStateException::class.java) {
      withScopedRoutedMessage(slot, null) { throw IllegalStateException("synthetic") }
    }
    assertSame(previous, slot.get())
  }
}
