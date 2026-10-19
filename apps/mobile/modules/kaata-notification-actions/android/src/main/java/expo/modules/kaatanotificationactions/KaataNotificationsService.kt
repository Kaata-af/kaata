package expo.modules.kaatanotificationactions

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import expo.modules.notifications.service.interfaces.PresentationDelegate

class KaataNotificationsService : NotificationsService() {
  override fun getPresentationDelegate(context: Context): PresentationDelegate =
    KaataPresentationDelegate(context)

  // SDK 57 includes the designated receiver in scheduled-alarm identities.
  // Package updates preserve old alarms, so retire only those legacy identities
  // before Expo schedules/cancels the same stored requests through this receiver.
  override fun onSetupScheduledNotifications(context: Context, intent: Intent) {
    cancelLegacyAlarms(context, getSchedulingDelegate(context).getAllScheduledNotifications().map { it.identifier })
    super.onSetupScheduledNotifications(context, intent)
  }

  override fun onScheduleNotification(context: Context, intent: Intent) {
    intent.getParcelableExtra<NotificationRequest>(NOTIFICATION_REQUEST_KEY)?.let {
      cancelLegacyAlarms(context, listOf(it.identifier))
    }
    super.onScheduleNotification(context, intent)
  }

  override fun onRemoveScheduledNotifications(context: Context, intent: Intent) {
    cancelLegacyAlarms(context, intent.getStringArrayExtra(IDENTIFIERS_KEY)?.asList().orEmpty())
    super.onRemoveScheduledNotifications(context, intent)
  }

  override fun onRemoveAllScheduledNotifications(context: Context, intent: Intent) {
    cancelLegacyAlarms(context, getSchedulingDelegate(context).getAllScheduledNotifications().map { it.identifier })
    super.onRemoveAllScheduledNotifications(context, intent)
  }

  private fun cancelLegacyAlarms(context: Context, identifiers: Collection<String>) {
    val legacyReceiver = ComponentName(context, NotificationsService::class.java)
    val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    val alarms = context.getSystemService(AlarmManager::class.java)
    for (identifier in identifiers) {
      val legacyIntent = Intent(
        NOTIFICATION_EVENT_ACTION,
        Uri.parse("expo-notifications://notifications/").buildUpon()
          .appendPath("scheduled").appendPath(identifier).appendPath("trigger").build(),
      ).setComponent(legacyReceiver)
      val pending = PendingIntent.getBroadcast(
        context, legacyReceiver.className.hashCode(), legacyIntent, PendingIntent.FLAG_NO_CREATE or mutable,
      ) ?: continue
      alarms.cancel(pending)
      pending.cancel()
    }
  }
}

private class KaataPresentationDelegate(context: Context) : ExpoPresentationDelegate(context) {
  override suspend fun createNotification(
    notification: Notification,
    notificationBehavior: NotificationBehaviorRecord?,
  ): android.app.Notification {
    // Let Expo own channel selection, actions, intents, extras and behavior.
    // Recover that completed notification and change only its small icon.
    val base = super.createNotification(notification, notificationBehavior)
    val status = notificationStatusIcon(notification.notificationRequest.content.body?.optString("kind"))
      ?: return base
    val resource = when (status) {
      NotificationStatusIcon.PENDING -> R.drawable.kaata_notification_pending
      NotificationStatusIcon.ACCEPTED -> R.drawable.kaata_notification_accepted
      NotificationStatusIcon.REJECTED -> R.drawable.kaata_notification_rejected
    }
    return android.app.Notification.Builder.recoverBuilder(context, base)
      .setSmallIcon(resource)
      .build()
  }
}
