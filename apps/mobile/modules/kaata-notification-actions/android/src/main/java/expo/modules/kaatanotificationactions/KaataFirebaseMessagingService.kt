package expo.modules.kaatanotificationactions

import android.content.Context
import android.content.Intent
import android.os.Bundle
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.service.delegates.ExpoHandlingDelegate
import expo.modules.notifications.service.delegates.FirebaseMessagingDelegate as ExpoFirebaseMessagingDelegate
import expo.modules.notifications.service.interfaces.FirebaseMessagingDelegate
import org.json.JSONObject

class KaataFirebaseMessagingService : ExpoFirebaseMessagingService() {
  private val routedMessage = ThreadLocal<RemoteMessage>()
  private val kaataDelegate by lazy { KaataFirebaseMessagingDelegate(this) }

  override val firebaseMessagingDelegate: FirebaseMessagingDelegate
    get() = kaataDelegate

  override fun handleIntent(intent: Intent) {
    val extras = intent.extras
    val body = extras?.getString("body")
    val kind = if (body != null && body.length <= 16_384) {
      runCatching { JSONObject(body).optString("kind") }.getOrNull()
    } else {
      null
    }
    // Firebase prefers the current no-UI key whenever it is present.
    val noUi = if (extras?.containsKey("gcm.n.noui") == true) {
      extras.getString("gcm.n.noui")
    } else {
      extras?.getString("gcm.notification.noui")
    }
    val shouldRoute = shouldRouteStatusNotification(
      intent.action,
      extras?.getString("message_type"),
      extras?.getString("gcm.n.e"),
      extras?.getString("gcm.notification.e"),
      noUi,
      kind,
    )
    val original = if (shouldRoute) RemoteMessage(Bundle(extras)) else null
    val routed = if (original == null) {
      intent
    } else {
      Intent(intent).apply {
        replaceExtras(Bundle(extras))
        // Suppress Firebase's automatic drawer rendering, not its delivery
        // pipeline. The superclass still owns duplicate IDs and acknowledgement.
        putExtra("gcm.n.e", "0")
        putExtra("gcm.notification.e", "0")
      }
    }
    // A nested ordinary message must not inherit an outer routed message.
    withScopedRoutedMessage(routedMessage, original) {
      super.handleIntent(routed)
    }
  }

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val original = routedMessage.get()
    if (original == null) {
      super.onMessageReceived(remoteMessage)
    } else {
      kaataDelegate.onRoutedNotification(original)
    }
  }
}

private class KaataFirebaseMessagingDelegate(context: Context) : ExpoFirebaseMessagingDelegate(context) {
  fun onRoutedNotification(message: RemoteMessage) {
    if (ExpoHandlingDelegate(context).isAppInForeground()) {
      // Preserve foreground listeners, behavior decisions and background tasks.
      super.onMessageReceived(message)
    } else {
      // Visible notifications previously rendered directly in Firebase. Keep
      // them native while reusing Expo's original request, category and intents;
      // do not start a headless JS runtime merely to draw the local large icon.
      NotificationsService.receive(context, createNotification(message))
    }
  }
}
