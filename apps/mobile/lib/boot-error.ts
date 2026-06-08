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

// Try a true process restart via react-native-restart (in deps but never
// previously wired). If the native module is unavailable for any reason
// (Expo Go, older dev client), fall back to BackHandler.exitApp() so the
// button at least kills the JS engine and lets the user reopen.
//
// UX critique gap: previously both branches silently swallowed their
// errors. If react-native-restart is missing from the prod APK and
// BackHandler.exitApp also throws, the user is stuck on the error screen
// with zero diagnostic signal. We now log each failure at least once.
// `restartLogged` ensures repeated taps don't spam logcat.
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
