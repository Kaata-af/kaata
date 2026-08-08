// D-BOOT-CRASH-DEFENSE: small structured error type + restart helper, kept
// out of _layout.tsx so the boot-error surface can be reused by future
// non-root components (e.g. a backup-restore failure screen).
//
// Stage is a coarse-grained boot phase, used only for support diagnosis on
// the error screen. NOT used to drive any retry logic — the user's only
// recovery is a process restart.

export type BootErrorStage =
  | "install_id"
  | "init_db"
  | "prime_caches"
  | "user_prefs"
  | "google_signin"
  | "self_lookup"
  | "device_locale"
  | "notif_channel"
  | "fonts"
  | "unknown";

export type BootError = {
  stage: BootErrorStage;
  name: string;
  // First 240 chars of the error.message — enough for support, short
  // enough that a screenshot remains legible. NEVER include the stack:
  // it can contain bundler-mangled paths plus, in pathological cases,
  // leaked user-provided strings from query errors.
  message: string;
};

export function toBootError(stage: BootErrorStage, err: unknown): BootError {
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === "string" && e.name ? e.name : "Error";
  const raw = typeof e?.message === "string" ? e.message : String(err ?? "");
  const message = raw.length > 240 ? raw.slice(0, 240) + "…" : raw;
  return { stage, name, message };
}

// Kill the app so the user can reopen it into a clean process.
//
// react-native-restart was REMOVED from dependencies (2026-08-08): it was an
// unmaintained 0.0.x legacy-bridge module carried for this one call, and the
// exitApp fallback below already covers the case. The optional require is kept
// deliberately — it costs nothing, and if the package is ever reinstated this
// path upgrades itself from "exit" to "true restart" with no edit.
//
// Both branches log once (`restartLogged`) so a user stuck on the error screen
// isn't left without a diagnostic signal, while repeated taps don't spam
// logcat.
let restartLogged = false;
export function forceRestart(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-restart");
    const RNRestart = mod?.default ?? mod;
    if (RNRestart && typeof RNRestart.Restart === "function") {
      RNRestart.Restart();
      return;
    }
    if (!restartLogged) {
      restartLogged = true;
      // eslint-disable-next-line no-console
      console.warn("[boot-error] react-native-restart loaded but Restart() is not a function");
    }
  } catch (err) {
    if (!restartLogged) {
      restartLogged = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[boot-error] react-native-restart require failed, falling back to exitApp",
        err,
      );
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BackHandler, Platform } = require("react-native");
    if (Platform.OS === "android" && BackHandler?.exitApp) {
      BackHandler.exitApp();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[boot-error] both restart and exitApp failed — user is stuck", err);
  }
}
