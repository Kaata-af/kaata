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
 *     it for a cohort. NOTE: the mirror only updates on a FOREGROUND check-in, so
 *     a flip reaches a device on its next foreground launch — a SWIPE-KILLED
 *     device keeps running its last-known setting, bounded by the local breaker +
 *     the bounded windows, until reopened. A hard fleet-wide stop still uses
 *     min_supported_version force-update.
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
  // Cutover flag (DEFAULT OFF): when true, the background path runs the NATIVE
  // MeshEngine (resident JVM, Briar-model) instead of spawning a headless-JS
  // window. Mirrored from the check-in response like bg_mesh_enabled, so the
  // cutover can be staged per-cohort from the backend. Off => current behavior.
  private const val KEY_NATIVE_ENGINE = "native_engine_enabled"
  // Set true while a QR pair is in progress (any phone). The native engine MUST
  // NOT touch the radio during a pair — RFCOMM accept/dial contention makes the
  // owner drop the joiner's socket (the "read ret -1" pairing failure). Pairing
  // already pauses the JS steady loop; this gives the native engine the same
  // pause, deterministically (not dependent on the 10s liveness heartbeat).
  private const val KEY_PAIRING_ACTIVE = "mesh_pairing_active"
  private const val MAX_FAILS = 3
  // Cross-VM heartbeat: the FOREGROUND JS (MeshController) stamps this every ~10s
  // while its mesh is live. The headless background entry reads it to know whether
  // a live JS mesh already owns the radio+DB — the single-mesh guard. AppState
  // can't do this (it's per-JS-context: a headless VM is always "background" and
  // never sees the foreground app). Stale (> STALE) => foreground JS is gone
  // (swipe-killed) => the background path may run.
  private const val KEY_JS_ALIVE_AT = "bg_mesh_js_alive_at"
  // The foreground stamps every ~10s. Stale window = 4.5x that, so Doze /
  // OEM throttling of the JS timer (even under the FGS wakelock) can't make a
  // backgrounded-but-ALIVE mesh look dead and trigger a 2nd headless mesh on the
  // one radio. The cost is only that a truly-killed phone's first headless window
  // starts ~45-135s after the kill (stale window + the 90s FGS tick) — fine for
  // background catch-up.
  private const val JS_ALIVE_STALE_MS = 45_000L

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

  /** Mirror of the remote kill-switch; written from JS (foreground) on check-in.
   *  commit() (synchronous), not apply(): this is a low-frequency toggle/check-in
   *  write, and the FGS — possibly in a sticky-restart that already re-read prefs
   *  — must see the new value immediately, with no apply() flush race. */
  fun setEnabled(ctx: Context, enabled: Boolean) {
    try {
      prefs(ctx).edit().putBoolean(KEY_ENABLED, enabled).commit()
    } catch (e: Throwable) {
      Log.w(TAG, "setEnabled failed", e)
    }
  }

  /** Cutover flag: run the native MeshEngine instead of the headless-JS window.
   *  Fail-closed (default false on any error) so the legacy path stays the
   *  default until the cutover is explicitly enabled. */
  fun isNativeEngineEnabled(ctx: Context): Boolean =
    try {
      prefs(ctx).getBoolean(KEY_NATIVE_ENGINE, false)
    } catch (e: Throwable) {
      false
    }

  /** Mirror of the cutover flag; written from JS (foreground) on check-in.
   *  commit() for the same reason as setEnabled — the FGS must read it without
   *  an apply() race, or the native window silently no-ops on KEY_NATIVE_ENGINE
   *  defaulting false right after the toggle. */
  fun setNativeEngineEnabled(ctx: Context, enabled: Boolean) {
    try {
      prefs(ctx).edit().putBoolean(KEY_NATIVE_ENGINE, enabled).commit()
    } catch (e: Throwable) {
      Log.w(TAG, "setNativeEngineEnabled failed", e)
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

  /** Is a QR pair in progress? The native engine must yield the radio if so. */
  fun isPairingActive(ctx: Context): Boolean =
    try {
      prefs(ctx).getBoolean(KEY_PAIRING_ACTIVE, false)
    } catch (e: Throwable) {
      false
    }

  /** Mark a pair in progress (true on pause, false on resume). commit() so the
   *  resident engine sees it immediately — a pair starting must stop the engine
   *  from racing the radio THIS instant, not after an async flush. */
  fun setPairingActive(ctx: Context, active: Boolean) {
    try {
      prefs(ctx).edit().putBoolean(KEY_PAIRING_ACTIVE, active).commit()
    } catch (e: Throwable) {
      Log.w(TAG, "setPairingActive failed", e)
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
   * Clear the heartbeat so isForegroundAlive() reads false immediately. Called
   * from KaataForegroundService.onTaskRemoved (a swipe-kill — the JS context dies
   * with the task, so it will NOT re-stamp): without this, the post-revival native
   * window is blocked for up to JS_ALIVE_STALE_MS (45s) waiting for the last
   * heartbeat to age out, even though JS is already gone. commit() so the revived
   * window — which may run within ~1s — sees it. NOT load-bearing for safety (the
   * staleness window still fails safe), only for promptness after a swipe.
   */
  fun clearJsAlive(ctx: Context) {
    try {
      prefs(ctx).edit().putLong(KEY_JS_ALIVE_AT, 0L).commit()
    } catch (e: Throwable) {
      Log.w(TAG, "clearJsAlive failed", e)
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
