package expo.modules.kaatanotificationactions

internal const val FCM_RECEIVE_ACTION = "com.google.android.c2dm.intent.RECEIVE"

// Match Firebase 25's notification-enable aliases. Other message types and
// intentional no-UI messages retain Firebase's ordinary handling.
internal fun shouldRouteStatusNotification(
  action: String?,
  messageType: String?,
  notificationEnabled: String?,
  legacyNotificationEnabled: String?,
  noUi: String?,
  kind: String?,
): Boolean =
  action == FCM_RECEIVE_ACTION &&
    (messageType == null || messageType == "gcm") &&
    (notificationEnabled == "1" || legacyNotificationEnabled == "1") &&
    noUi != "1" && !noUi.equals("true", ignoreCase = true) &&
    notificationStatusIcon(kind) != null

internal inline fun <T, R> withScopedRoutedMessage(
  slot: ThreadLocal<T>,
  message: T?,
  block: () -> R,
): R {
  val previous = slot.get()
  if (message == null) slot.remove() else slot.set(message)
  try {
    return block()
  } finally {
    if (previous == null) slot.remove() else slot.set(previous)
  }
}
