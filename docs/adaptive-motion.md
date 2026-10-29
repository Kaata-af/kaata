# Adaptive motion

Kaata keeps the existing interface on capable phones and can remove decorative
motion on phones with less memory. This is a conservative capability heuristic,
not a speed benchmark. It does not claim that every phone above the threshold
will animate smoothly.

## User control

Account → Preferences → Animations offers **Automatic**, **On**, and **Off** in
English, Dari, and Pashto. Automatic is the default. The choice is stored in
device app metadata (`motion_pref`), outside signed ledger events. It does not
change balances, permissions, financial records, or the recording protocol.

- **Automatic:** reduce motion when Android reports a low-RAM device, Android
  physical memory is at most 3 GiB, or iOS physical memory is at most 2 GiB.
- **On:** use normal visual effects regardless of the memory heuristic.
- **Off:** reduce motion regardless of hardware.

System Reduce Motion takes precedence over all three choices. Unknown system
accessibility state stays reduced until a successful read or accessibility
event. No hardware identifiers, model blacklist, network request, additional
permission, recurring benchmark, or dependency is needed.

Motion initialization uses a 750 ms timeout for each check in parallel without
blocking screen rendering. Eventual hardware, accessibility, and saved-setting
responses can still apply afterward; stale responses cannot replace a newer
system event or a saved user choice.

The hardware lookup uses the existing cross-platform KaataSaveFile native
module. Missing methods in an older app or Expo Go are supported: Automatic
falls back to normal motion, subject to system accessibility settings. Manual
Off still works there. A fresh native app build is needed for hardware detection.

## Scope

Reduced motion disables card autoplay and decorative card resizing, page and
sheet transitions, animated search controls, automatic scroll animation,
toast movement, error shaking, highlight fading, background blur, and progress
shimmer. Changes made while an animation is running also stop that animation.

Direct finger scrolling, carousel paging, swipe filters, sheet dragging,
keyboard positioning, and static progress/error/notification feedback remain
available. Disabling animation must not suppress an action, clear navigation,
remount the backdrop target, hide a toast, or remove the space reserved for it.
The OS keyboard and native scrolling physics retain their normal behavior.

One shared motion store replaces independent system-motion queries across
consumers. Its context value changes only when an effective policy or backdrop
capability changes. The indeterminate restore animation in normal mode now uses
a native transform rather than a JavaScript animation loop.

## Verification and limits

Regression coverage includes hardware thresholds and missing native methods,
saved choices and failed-write rollback, startup and subscription races,
accessibility precedence, live animation cancellation, finger ownership,
carousel looping, route identity, keyboard/focus scroll targets, toast spacing,
and localized settings. Run the new policy/settings/consumer/navigation cases
with `bun run --cwd apps/mobile selftest:motion`; existing component suites also
cover the integration points.

The 27 related regression suites passed through Node/tsx, along with mobile
TypeScript and formatting checks.

The Android hardware module compiled locally with
`:kaata-save-file:compileDebugKotlin`. This checks the native getter, not a newly
packaged app. Swift compilation and fresh release-device measurements remain
part of the next testing-build validation. Installed Android build 80 does not
contain these changes. No new store build, distribution, or production release
was performed for this change.

This work reduces optional rendering and recurring animation work. It does not
establish a measured FPS or memory-use improvement, replace list profiling or
virtualization work, or change the supported OS floor. In particular, the app
requires iOS 16.4 or later; iPhone 5s cannot run it.
