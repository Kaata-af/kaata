# Biometric app lock

## User control

**Account → Privacy & data → App lock** is available in English, Dari and Pashto.
It is **Off by default** and applies to this phone, across all accounts and
kaatas. Reading Settings or completing biometric enrollment never enables it.

The device-only flag lives in SecureStore as `kaata.app_lock.enabled.v1`, outside
ledger events, database backups and account sync. Enabling requires supported,
enrolled strong biometrics and successful native authentication before saving.
Disabling also requires native authentication. Kaata does not collect biometric
templates or store a separate app PIN.

## Locking and recovery

An enabled lock covers the app on launch and after a real background transition.
Inactive/background privacy covers protect content while retaining navigation and
draft state. Authentication's own inactive transition must not cause a prompt
loop. Cancellation or failure leaves the lock in place; another attempt is
available from the unlock screen. A genuine background transition invalidates
an in-flight success. Unreadable or stalled lock storage stays covered and
offers retry rather than silently disabling the lock.

On iOS, the lock uses the existing `react-native-screens` full-window overlay,
which covers native-stack modal screens without a competing UIKit presentation.
Existing native sheets retain their presentation underneath it with private
children removed; newly requested sheets wait until unlock. Android hides native
sheet windows and consumes Back while the opaque root cover is shown. Navigation
and controlled drafts remain mounted.

- **Android API 30+ and iOS:** native authentication permits the phone's
  PIN/passcode fallback. It also provides recovery if biometric enrollment is
  removed after the app lock was enabled.
- **Android below API 30, or unknown Android API:** authentication is biometric
  only. The older native API cannot safely combine strong biometrics with
  device-credential fallback. Recovery uses the phone's security settings to
  add a fingerprint with the phone PIN; the app offers a settings shortcut and
  does not claim direct in-app PIN fallback.

The gate protects the app interface. It does not add database encryption or
change financial calculations, membership, sync or notification-preview policy.
Names and amounts on OS notifications remain controlled separately in
notification settings.

## Screen privacy and native configuration

While enabled, Android's native secure-window flag blocks screenshots,
recordings and recent-app previews, including when the app is unlocked. The
setting discloses this before activation. iOS uses app-switcher privacy
protection while preserving normal screenshots of the unlocked app. These
protections do not request photo-library permissions.

SDK 58 uses `expo-local-authentication` and `expo-screen-capture`. The Expo config
includes the authentication plugin and localized `NSFaceIDUsageDescription`.
A fresh native build is required for the installed app to contain these changes.
[Face ID cannot be tested in Expo Go](https://docs.expo.dev/versions/v58.0.0/sdk/local-authentication/);
Android fingerprint authentication is available there.

## Verification

`selftest:app-lock` covers the core preference/authentication lifecycle, localized
settings, lock gate, protected modals and screen-privacy adapter. Coverage
includes default Off, authentication before enable/disable, cancellation,
single-flight prompts, storage failures/timeouts, native lifecycle races,
foreground retries, stale settings callbacks, capability changes and legacy
Android recovery copy. Startup, email-auth, notification-routing and profile
settings suites check surrounding behavior.

On the USB-connected Xiaomi/API 31 in Expo Go, capability checks, the native
fingerprint prompt, phone-PIN prompt, cancellation and the unchanged Off setting
were checked. Successful fingerprint/PIN authentication was not available to
the agent and is not claimed as a physical-device pass. No saved customer or
financial records were changed. An owner-assisted successful unlock remains
unverified; Android can be checked in Expo Go. Face ID requires a native
development/testing build.

No app build, store upload or release was made as part of this feature work.
