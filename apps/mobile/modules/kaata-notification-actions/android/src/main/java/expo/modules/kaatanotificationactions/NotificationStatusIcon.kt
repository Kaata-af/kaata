package expo.modules.kaatanotificationactions

internal enum class NotificationStatusIcon {
  PENDING,
  ACCEPTED,
  REJECTED,
}

// Notification kinds describe events, independently of unread state. Only
// shared-tally review events replace the ordinary notification icon.
internal fun notificationStatusIcon(kind: String?): NotificationStatusIcon? = when (kind) {
  "entry_created" -> NotificationStatusIcon.PENDING
  "entry_accepted" -> NotificationStatusIcon.ACCEPTED
  "entry_rejected" -> NotificationStatusIcon.REJECTED
  else -> null
}
