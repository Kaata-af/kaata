package expo.modules.kaatabtclassic

import android.content.Context
import android.util.Log

/**
 * Fail-closed gate for killed-app background mesh sync (#43 P2).
 *
 * Reads/writes the SAME SharedPrefs the foreground service uses
 * (KaataForegroundService.PREFS = "kaata_fgs_prefs") so it is readable with a
 * plain Service Context AFTER a swipe-kill — i.e. when appContext.reactContext is
 * dead (KaataBtClassicModule.appCtx throws then). The background entry MUST read
 * this with the Service context, never the module's appCtx.
 *
 * Two independent controls, both fail-closed:
 *   - bg_mesh_enabled: the REMOTE kill-switch. Mirrored here from the /v1/check-in
 *     response (see app-meta-context.applyCheckIn). DEFAULT ABSENT => OFF, so the
 *     already-live 0.6.0 fleet sees ZERO behavior change until the backend flips
 *     it for a cohort; a bad rollout is reverted server-side with no APK push.
 *   - bg_mesh_fail_count: the LOCAL crash-loop breaker. The background entry calls
 *     markWindowOpen() BEFORE spawning a JS window; the JS clears it (markWindowOk)
 *     only after a CLEAN completion. A window that dies mid-boot (OOM on a low-end
 *     device, crash) leaves the count incremented; at >= MAX_FAILS the path
 *     self-disables. resetFailures() runs on EVERY foreground launch (not gated on
 *     a successful boot), so a device that tripped the breaker self-heals the
 *     instant the user opens the app — the breaker NEVER blocks the foreground app,
 *     only the background path.
 *
 * Every method is wrapped so a SharedPrefs failure can never throw into the
 * Service / onStartCommand path; isEnabled() returns false (fail-closed) on error.
 */
object KaataBgMeshGate {
  private const val TAG = "KaataBgMeshGate"
  // MUST match KaataForegroundService.PREFS — one prefs file, readable from the
  // service with a plain Context post-kill.
  private const val PREFS = "kaata_fgs_prefs"
  private const val KEY_ENABLED = "bg_mesh_enabled"
  private const val KEY_FAIL_COUNT = "bg_mesh_fail_count"
  private const val MAX_FAILS = 3
  // Cross-VM heartbeat: the FOREGROUND JS (MeshController) stamps this every ~10s
  // while its mesh is live. The headless background entry reads it to know whether
  // a live JS mesh already owns the radio+DB — the single-mesh guard. AppState
  // can't do this (it's per-JS-context: a headless VM is always "background" and
  // never sees the foreground app). Stale (> STALE) => foreground JS is gone
  // (swipe-killed) => the background path may run.
  private const val KEY_JS_ALIVE_AT = "bg_mesh_js_alive_at"
  private const val JS_ALIVE_STALE_MS = 25_000L

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /**
   * The ONLY question a background entry asks before doing anything. Fail-closed:
   * any error, or the flag unset, or the breaker tripped => false (no background
   * execution, app still opens normally).
   */
  fun isEnabled(ctx: Context): Boolean =
    try {
      val p = prefs(ctx)
      p.getBoolean(KEY_ENABLED, false) && p.getInt(KEY_FAIL_COUNT, 0) < MAX_FAILS
    } catch (e: Throwable) {
      Log.w(TAG, "isEnabled failed — fail-closed", e)
      false
    }

  /** Mirror of the remote kill-switch; written from JS (foreground) on check-in. */
  fun setEnabled(ctx: Context, enabled: Boolean) {
    try {
      prefs(ctx).edit().putBoolean(KEY_ENABLED, enabled).apply()
    } catch (e: Throwable) {
      Log.w(TAG, "setEnabled failed", e)
    }
  }

  /**
   * Increment the breaker BEFORE spawning a JS window. A window that never reports
   * success leaves this incremented, tripping the breaker after MAX_FAILS.
   */
  fun markWindowOpen(ctx: Context) {
    try {
      val p = prefs(ctx)
      p.edit().putInt(KEY_FAIL_COUNT, p.getInt(KEY_FAIL_COUNT, 0) + 1).apply()
    } catch (e: Throwable) {
      Log.w(TAG, "markWindowOpen failed", e)
    }
  }

  /** JS calls this after a CLEAN background window (clears the breaker). */
  fun markWindowOk(ctx: Context) = resetFailures(ctx)

  /**
   * Reset the breaker. Called on EVERY foreground launch (unconditionally, not
   * gated on a successful boot) so a device that tripped the breaker self-heals.
   */
  fun resetFailures(ctx: Context) {
    try {
      prefs(ctx).edit().putInt(KEY_FAIL_COUNT, 0).apply()
    } catch (e: Throwable) {
      Log.w(TAG, "resetFailures failed", e)
    }
  }

  /** Foreground JS heartbeat — call ~every 10s while the live mesh is running. */
  fun markJsAlive(ctx: Context, nowMs: Long) {
    try {
      prefs(ctx).edit().putLong(KEY_JS_ALIVE_AT, nowMs).apply()
    } catch (e: Throwable) {
      Log.w(TAG, "markJsAlive failed", e)
    }
  }

  /**
   * Is a foreground JS mesh probably alive right now? The single-mesh guard: the
   * background entry MUST NOT run a second mesh while the foreground one is live.
   * Fail-SAFE here means returning TRUE on error (assume the foreground is alive →
   * background stays out), since two meshes on one radio is the harm we avoid.
   */
  fun isForegroundAlive(ctx: Context, nowMs: Long): Boolean =
    try {
      val last = prefs(ctx).getLong(KEY_JS_ALIVE_AT, 0L)
      last > 0L && (nowMs - last) < JS_ALIVE_STALE_MS
    } catch (e: Throwable) {
      Log.w(TAG, "isForegroundAlive failed — assume alive (stay out)", e)
      true
    }
}
