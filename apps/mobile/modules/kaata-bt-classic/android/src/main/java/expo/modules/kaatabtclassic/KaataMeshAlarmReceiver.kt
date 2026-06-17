package expo.modules.kaatabtclassic

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Doze-exempt revival alarm receiver — Briar-parity P1b (port of Briar's
 * AndroidTaskScheduler 15-min setAndAllowWhileIdle backstop).
 *
 * KaataForegroundService arms a `setAndAllowWhileIdle` alarm (~15 min) while
 * Nearby sync is on. If the OS HARD-kills the process despite the foreground
 * service + renewable wakelock (the residency layer that should normally prevent
 * it — see KaataForegroundService), this alarm still fires: the OS starts a fresh
 * process to deliver the broadcast and grants a brief allowlist window during
 * which starting a foreground service from the background IS permitted. We use
 * that window to bring the service back, then re-arm the next alarm.
 *
 * Unlike Briar (which deliberately does NOT auto-revive — it needs the user's DB
 * key and stays down for privacy), kaata has no such gate, so we DO revive — but
 * only when the user actually opted into background sync:
 *   - KEY_FGS_SHOULD_RUN (set by the FGS while Nearby sync is on) AND
 *   - KaataBgMeshGate.isEnabled (the bg-mesh kill-switch + crash-loop breaker).
 *
 * Fail-closed + never throws: any error is swallowed (a crashing alarm receiver
 * would be a terrible background citizen). Both prefs are read with this plain
 * BroadcastReceiver Context — readable post-kill, when the JS DB + the module's
 * appContext are gone.
 */
class KaataMeshAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    try {
      val prefs =
        context.getSharedPreferences(KaataForegroundService.PREFS, Context.MODE_PRIVATE)
      val shouldRun = prefs.getBoolean(KaataForegroundService.KEY_FGS_SHOULD_RUN, false)
      if (!shouldRun) {
        // Nearby sync is off — let the alarm chain die (the FGS also cancels it
        // on STOP; this is belt-and-suspenders after an unclean teardown).
        return
      }
      // Re-arm regardless so the heartbeat continues while Nearby sync is on,
      // even if the bg-mesh switch is currently off (so toggling it on later
      // takes effect without the user reopening the app).
      KaataForegroundService.scheduleRevivalAlarm(context)
      // Only actually revive when the user opted into background sync.
      if (KaataBgMeshGate.isEnabled(context)) {
        KaataForegroundService.ensureRunning(context)
      }
    } catch (e: Throwable) {
      Log.w("KaataMeshAlarm", "onReceive failed", e)
    }
  }
}
