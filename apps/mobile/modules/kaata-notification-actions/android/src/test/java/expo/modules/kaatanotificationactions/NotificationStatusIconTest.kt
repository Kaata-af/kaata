package expo.modules.kaatanotificationactions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationStatusIconTest {
  @Test
  fun eachSharedTallyReviewEventHasItsOwnIcon() {
    assertEquals(NotificationStatusIcon.PENDING, notificationStatusIcon("entry_created"))
    assertEquals(NotificationStatusIcon.ACCEPTED, notificationStatusIcon("entry_accepted"))
    assertEquals(NotificationStatusIcon.REJECTED, notificationStatusIcon("entry_rejected"))
  }

  @Test
  fun cancelledAndUnrelatedNoticesKeepTheirExistingIcon() {
    for (kind in listOf(null, "", "entry_voided", "reminder", "customer_reminder", "action_failed", "unknown")) {
      assertNull("No review icon for $kind", notificationStatusIcon(kind))
    }
  }

  @Test
  fun onlyExactEventKindsAreRecognized() {
    // Do not infer acceptance from a read/handled flag or confuse the wire
    // tally status 'disputed' with the notification event 'entry_rejected'.
    for (kind in listOf("read", "handled", "pending", "accepted", "disputed", "ENTRY_CREATED", " entry_accepted", "entry_rejected ")) {
      assertNull("No inferred review icon for $kind", notificationStatusIcon(kind))
    }
  }
}
