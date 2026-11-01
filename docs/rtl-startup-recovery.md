# Language restart loop — November 1, 2026

## Report and scope

Users reported repeated **Almost ready** screens asking them to close Kaata
for language settings. Clearing app data and recovering from the cloud appeared
to resolve it. The screenshot matches `MigrationPrompt` in
`apps/mobile/app/_layout.tsx`, which renders before database initialization.
It does not establish that a user's ledger is damaged.

The released Android 2.3.0/code 82 source is `4057d982`. Its lockfile already
includes `expo-localization` 58.0.5. The restart gate predates SDK 58 and remained
in place during the SDK upgrade. Affected users' exact versions still need
confirmation; the mechanism below is present in release 82.

## Failure mechanism

1. Kaata handles Dari/Pashto layout explicitly through `lib/direction.ts` while
   keeping the native layout left-to-right. The localization plugin previously
   declared only the supported languages, leaving native `supportsRTL=true`.
2. Expo Localization 58.0.5 applies its default RTL preference once when its
   configuration marker is missing. On an RTL system/per-app locale, this can
   make the native root RTL before JavaScript neutralizes the preferences.
3. React Native 0.88 caches `I18nManager` constants for the JavaScript runtime.
   Kaata captures that initial `isRTL` in `NEEDS_RESTART_FOR_LTR` and blocks boot
   to avoid reversing physical buttons and gestures.
4. The old **Close Kaata** button calls `forceRestart()`. Its removed restart
   dependency falls back to `BackHandler.exitApp()`, which performs Android's
   Back action rather than terminating the process. Reopening a retained
   process can show the same gate again.

Clearing app data also kills the process and clears preferences. That explains
why it can remove this screen, but it unnecessarily risks unsynced entries.
The gate also precedes normal check-in and diagnostic initialization, so these
blocked boots can be missing from normal startup telemetry.

## Data-preserving support steps

On Android: **Settings → Apps → Kaata → Force stop**, then open Kaata again.
This ends the retained process without clearing app storage. Do not ask users
to clear app data, uninstall, or restore the cloud merely to address this screen.
If the gate persists after Force stop, collect the installed app version and
system/per-app language before changing anything else.

## Repair

- Configure `expo-localization` with `supportsRTL:false` and `forcesRTL:false`,
  retaining English, Dari and Pashto. Android's generated manifest then disables
  native automatic RTL, including when an old forced-RTL preference exists.
- Explicitly retain `ios.infoPlist.ExpoLocalization_forcesRTL:false`. The plugin
  omits its default `forcesRTL:false`, and iOS otherwise gives an old forced
  preference precedence over `allowRTL:false`.
- Keep the runtime guard for old hosts/Expo Go, with Android recovery that opens
  app settings and explains Force stop. It does not reset storage or sign out.

This changes native configuration and needs a new app binary. A source push or
website deployment does not update an installed mobile binary. No store release
is authorized or performed as part of this investigation.

## Verification

The native config regression test runs the installed Expo plugin and introspects
its Android/iOS output. It checks the manifest, Android resource, iOS Info.plist
and retained locales. Its negative control reproduces the previous permissive
native configuration. Recovery-screen tests exercise the real screen functions
without opening SQLite or contacting a server.

Native reproduction and build evidence is retained in the ignored
`build/rtl-incident-20261101/` folder. Use only its new isolated emulator,
with networking disabled; never seed RTL flags, clear data or install test APKs
on a user's production phone.

The retained release-82 APK reproduced the reported screen on an isolated API 34
emulator with the app language set to Dari before first launch. Networking was
disabled and verified before every phase. Tapping **Close Kaata** and relaunching
retained the same process and the same prompt. A genuine **Force stop** ended
that process; reopening reached normal onboarding. No app-data clear, uninstall,
account sign-in or cloud recovery was used. The command and screenshot receipt
is `build/rtl-incident-20261101/release82-repro.json`.

A fictional offline ledger was then created through the released app's UI:
**RTL Demo → Offline Customer → I gave 750 AFN**. A further Force stop and
reopen retained the customer and balance without sign-in or cloud recovery.
Its receipt is `build/rtl-incident-20261101/fictional-ledger-baseline.json`.

The local patched x86_64 APK compiled successfully. Its packaged manifest has
`supportsRtl=false` and its packaged localization support resource is `false`.
The retained release-82 APK instead has `supportsRtl=true` and unset RTL
resources. The local test APK uses the same package and certificate as the
retained local release APK, with unchanged version/code; it is not a store
release candidate. Build inputs, hashes and certificate checks are in
`build/rtl-incident-20261101/local-apk-receipt.json`. Original release artifacts
were not overwritten.

Installing that patched APK in place over the offline ledger passed. The app's
UID remained `10190`, its per-app locale remained `fa-AF`, and **Offline
Customer → one I gave 750 AFN tally** remained visible. A further Force stop
and cold launch reached the normal home screen with the same ledger. No data
clear, uninstall, sign-in, cloud recovery or network access was involved. See
`build/rtl-incident-20261101/inplace-update-receipt.json` and its screenshots.
The isolated emulator and its separate ADB server were then stopped with
ownership checks; evidence and emulator data were retained. See
`build/rtl-incident-20261101/cleanup-receipt.json`.

The full mobile type check and combined language/native-configuration/recovery
test suite passed. iOS configuration and native initialization ordering were
checked, but an iOS device upgrade test remains outstanding.

Native device coverage was Android API 34 x86_64, with a Dari per-app locale,
first launch, Close-button/warm reopen versus a true Force stop, and a patched
in-place upgrade preserving an unsynced ledger. Remaining device cases include
Pashto/system-wide RTL locale and historical explicit forced-RTL preferences.
iOS must additionally cover an old forced-RTL preference on a current native
build. English/Dari/Pashto recovery UI and both native configurations are
covered by the automated tests.

## Primary references

- [Expo SDK 58 localization configuration](https://docs.expo.dev/versions/v58.0.0/sdk/localization/)
- [Expo's runtime RTL preference fix, including first-launch default behavior](https://github.com/expo/expo/pull/51800)
- Installed React Native sources: `Libraries/ReactNative/I18nManager.js`,
  Android `I18nUtil.kt` / `I18nManagerModule.kt`, and iOS `RCTI18nUtil.m`.
