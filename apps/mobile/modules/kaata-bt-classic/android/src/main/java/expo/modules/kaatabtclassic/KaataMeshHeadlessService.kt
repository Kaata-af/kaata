package expo.modules.kaatabtclassic

import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * #43 P2 — runs the JS mesh in a HEADLESS ReactContext after a swipe-kill, so a
 * killed phone keeps syncing in real time. Started on a tick by
 * KaataForegroundService (which is already resident post-kill via START_STICKY).
 *
 * CRASH-LOOP-PROOF + fail-closed (the app is LIVE; a user who can't open the app
 * is the unacceptable worst case):
 *  - Reads KaataBgMeshGate.isEnabled(this) FIRST, with the SERVICE Context (the
 *    module's appContext is dead post-kill). Off / breaker-tripped => stopSelf +
 *    START_NOT_STICKY (nothing runs; the app still opens normally).
 *  - Increments the crash-loop breaker BEFORE spawning the JS window; the JS task
 *    clears it (markBgMeshWindowOk) only on a CLEAN window. A window that dies
 *    mid-boot leaves it incremented; at >= MAX_FAILS the gate self-disables until a
 *    foreground launch resets it.
 *  - OVERRIDES onStartCommand wholesale to return START_NOT_STICKY on EVERY branch.
 *    The base HeadlessJsTaskService.onStartCommand returns START_REDELIVER_INTENT —
 *    a redelivery crash-loop vector — so we must NOT fall through to it. Default
 *    retryPolicy is NoRetryPolicy (no JS-task retry storm either).
 *  - NEVER calls startForeground; declared as a PLAIN <service> (no
 *    foregroundServiceType) so MIUI cannot mistake it for an FGS start and 5s-kill
 *    the process. The existing connectedDevice FGS already owns foreground + the
 *    wakelock; this rides inside that resident process.
 */
class KaataMeshHeadlessService : HeadlessJsTaskService() {

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    return try {
      if (!KaataBgMeshGate.isEnabled(this)) {
        stopSelf()
        START_NOT_STICKY
      } else {
        KaataBgMeshGate.markWindowOpen(this)
        // Spins the headless ReactContext + runs the registered "KaataMeshBg" task.
        startTask(buildConfig())
        START_NOT_STICKY
      }
    } catch (e: Throwable) {
      // Never loop on failure.
      Log.w(TAG, "headless onStartCommand failed — bailing", e)
      try {
        stopSelf()
      } catch (_: Throwable) {
        /* */
      }
      START_NOT_STICKY
    }
  }

  // Clear the crash-loop breaker NATIVELY when the JS task finishes cleanly — the
  // Service Context is always valid here, unlike the JS markBgMeshWindowOk() which
  // routes through appContext.reactContext and can be null at task-finish. Only a
  // clean FINISH (the headless-entry task always resolves — it swallows its own
  // errors) clears it; a VM crash/OOM that never finishes leaves the breaker
  // incremented, which is exactly the catastrophic case the breaker guards.
  override fun onHeadlessJsTaskFinish(taskId: Int) {
    try {
      KaataBgMeshGate.resetFailures(this)
    } catch (e: Throwable) {
      Log.w(TAG, "resetFailures on finish failed", e)
    }
    super.onHeadlessJsTaskFinish(taskId)
  }

  // Not used by our overridden onStartCommand (we build the config inline), but
  // provided for completeness / the base class contract.
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig = buildConfig()

  private fun buildConfig(): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(
      TASK_NAME,
      Arguments.createMap(),
      TASK_TIMEOUT_MS,
      // isAllowedInForeground = TRUE: do NOT let RN's foreground check fire. On
      // old-arch, startTask posts that check to the UI thread (UiThreadUtil always
      // posts), and when the app is RESUMED it throws an IllegalStateException
      // OUTSIDE our onStartCommand try/catch -> uncatchable main-thread crash of
      // the LIVE process. With true, RN never throws; the JS single-mesh guard
      // (runBackgroundCatchup -> isForegroundMeshAlive bail) makes the task a
      // harmless no-op if a foreground mesh is already up.
      true,
    )

  companion object {
    private const val TAG = "KaataMeshHeadless"
    // MUST match AppRegistry.registerHeadlessTask(...) in lib/mesh/headless-entry.ts.
    private const val TASK_NAME = "KaataMeshBg"
    // > the JS window (runBackgroundCatchup maxMs) + boot grace; the task resolves
    // itself well before this and onHeadlessJsTaskFinish stopSelf()s.
    private const val TASK_TIMEOUT_MS = 60_000L
  }
}
