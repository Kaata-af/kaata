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

On an updated installed iOS app, **Use phone passcode** is also available as a
separate action below Unlock. Expo's normal device-owner policy allows a passcode
but still starts with enrolled Face ID; repeating that call is not a
passcode-only action. The local `KaataDeviceAuth` module instead reads a fresh,
random, device-only Keychain sentinel constrained by `.devicePasscode`. Only a
successful protected read matching that random value authenticates. Creation
alone never authenticates, and the sentinel is removed after the request.
Kaata never receives or stores the phone passcode or introduces an app PIN.

The explicit route shares the original single-flight, foreground and stale-result
guards. Backgrounding cancels the exact native request; stale cancellations cannot
cancel a newer request. The button is absent from Expo Go and older native builds
that lack the module; they retain the existing native authentication route.

The gate protects the app interface. It does not add database encryption or
change financial calculations, membership, sync or notification-preview policy.
Names and amounts on OS notifications remain controlled separately in
notification settings.

## Lock screen presentation

The light frosted card uses the balance cards' decorative glass and soft colors,
inside the existing opaque privacy cover. It never blurs or previews ledger
content. A locked-device status and hidden-until-unlock message appear only
after the enabled lock is confirmed. Initialization uses neutral wording.

Headings and body text occupy the available width, remain centered in every
language and use the font's natural line height. Text and action labels wrap for
narrow screens and larger system text; the page remains scrollable. Unlocking
keeps its label beside the spinner. Native authentication and recovery behavior
are unchanged.

The lock-screen wordmark is always the literal LTR **kaata.** in all languages;
the remaining lock and recovery text stays localized.

The decorative glass drifts gently on a 20-second cycle, using native-driven
transforms with stationary text, controls and card border. It pauses without
resetting when inactive or backgrounded, and stops on unmount. OS Reduce Motion
and Reduce Transparency use a static surface; older Android's opaque fallback
also avoids an unnecessary loop. The lock reads these OS preferences directly
because its privacy cover sits outside the normal sheet provider. Balance cards
elsewhere retain their existing static appearance.

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
The explicit iOS passcode route requires the new local `kaata-device-auth` module
and therefore a fresh native iOS build. The lightweight Mac compiler workflow
checks its security helper against the real iOS SDK without signing or submitting
an app; the Expo adapter and actual system prompt still need the installed build.

## Verification

`selftest:app-lock` covers the core preference/authentication lifecycle, localized
settings, lock gate, protected modals and screen-privacy adapter. Coverage
includes default Off, authentication before enable/disable, cancellation,
single-flight prompts, storage failures/timeouts, native lifecycle races,
foreground retries, stale settings callbacks, capability changes and legacy
Android recovery copy. Startup, email-auth, notification-routing and profile
settings suites check surrounding behavior.
Passcode tests additionally cover unavailable modules, strict native results,
scoped cancellation, foreground waiting, preserved preferences and independence
from Android's working biometric/credential path.

On the USB-connected Xiaomi/API 31 in Expo Go, capability checks, the native
fingerprint prompt, phone-PIN prompt, cancellation and the unchanged Off setting
were checked. Successful fingerprint/PIN authentication was not available to
the agent and is not claimed as a physical-device pass. No saved customer or
financial records were changed. An owner-assisted successful unlock remains
unverified; Android can be checked in Expo Go. Face ID requires a native
development/testing build.

No app build, store upload or release was made as part of this feature work.
