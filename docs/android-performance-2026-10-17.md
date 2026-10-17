# Android startup responsiveness investigation

Device: Xiaomi Mi 10T, Android 12. Release-mode builds use the existing Play
app signature and update in place; no ledger data is cleared or edited.

## Cause

`fullBackupSweep` calls `healMissingServerAnchors`, which inspects joined
kaatas through `queueIncompleteJoinedVault`. Every eligible history was
folded locally and again with published events, including unchanged histories.
The pure fold synchronously verified Ed25519 event and witness signatures on
the JavaScript thread. The home rail also ran every pan update and spring on
that thread, so it stopped following the finger while maintenance ran.

Numeric instrumentation on the device attributed about 10.15 seconds of one
maintenance pass to signature verification: three histories (3, 30 and 49
events) were each folded twice. Perfetto independently showed near-continuous
JavaScript CPU during startup and another long burst around 80 seconds. GPU
frame rendering was quick and Android reported thermal status 0. Tally count was
not the determining workload.

## Changes and invariants

- The Collect/Pay rail follows the gesture and settles on Reanimated's UI
  runtime. React receives the selected side afterward. Sequence, search and
  width guards reject stale callbacks. An explicit initial transform and
  non-collapsible native view preserve the Xiaomi first-paint safeguard.
- A bounded LRU stores successful mathematical signature checks over exact
  message bytes, signature text and public key text. It stores no roles,
  membership state, witness freshness, anchors or authorization decisions.
- Android prewarms that cache through the existing native module's background
  Expo `AsyncFunction`, using the existing BouncyCastle dependency. JavaScript
  preparation yields real tasks and sends at most 32 checks/128 KiB of message
  bytes per batch. Native and wrapper limits additionally bound bridge input.
- Native acceptance is a strict subset of installed Noble 2.3: canonical
  standard Base64, canonical points/scalars, nonzero prime-order public key,
  nonidentity R and successful BouncyCastle verification. False, unavailable,
  failed or malformed native results retain the original Noble path. Unusual
  signatures that Noble accepts are not rejected merely by the optimization.
- Proof loading reloads current database inputs after asynchronous warming,
  then uses the original pure fold. Removals, tombstones, publication changes,
  rotated anchors/pins and ownership receipts remain authoritative.
- Runtime cache bounds are 2,048 entries, 16 KiB/message and 4 MiB of retained
  key storage. Test helpers retain their smaller default limits.

## Verification

All 81 mobile `selftest:*` scripts and TypeScript checking pass. Native unit
tests pass (14 tests). Seven bridge-wrapper tests and 292 deterministic
fixtures against the exact installed Noble version cover canonical and
unusual signatures, malformed input, torsion/mixed-order points, identity R,
Base64, tampering and scalar bounds. Integration tests exercise real SQLite,
current authority changes during awaits, exact witness/grant constructors,
fallback behavior, cache eviction and mutable-input races.

Final diagnostic 63 completed the full 95-second device capture. The following
comparison uses diagnostic 61 (original signature work plus UI-runtime rail)
and 63 (the complete fix), with the same device, data and swipe schedule:

| Measurement | Before | After |
| --- | ---: | ---: |
| JS CPU time during early swipes, 5–24 s | 8,474.6 ms | 574.7 ms |
| Approximate JS CPU time in the recurring 80–90 s window | 9,270 ms | 105 ms |
| JS CPU time during the first 5 s, including boot | 3,522.8 ms | 2,052.2 ms |
| Median active frame interval during swipes | about 20 ms | about 20 ms |

Early-swipe JavaScript CPU work fell 93.2%; later saturation was absent in this capture.
The active frame cadence matches the observed 50 Hz display mode. This is not
a universal FPS or input-latency guarantee; a few longer frame intervals
remain. Native frame-deadline misses were 3/342 cold and 0/342 warm. Thermal
status stayed 0. The first home screenshot, taken before any swipe at about
2.5 s, was fully populated with the correct rail visible.

A separate fresh launch opened search with a tap at 2.6 s, displayed the
search route by the 3.25 s screenshot, and displayed the typed query/results
by 4.73 s. An earlier test injected a tap at 1.4 s while initial data scope was
not ready; the existing guard ignored it. These host-timed screenshots bound
observed behavior and do not measure exact touch-to-photon latency.

The same application process then survived 100 rapid alternating swipes,
10 vertical scrolling gestures and 20 search → customer → back cycles. Each
customer route was checked through its rendered UI, and Android's crash
buffer contained no failure for that process. The navigation harness was
corrected for Windows UTF-8 decoding and for the app's intentionally retained
query; those harness interruptions were not application crashes. The final
home screenshot retained the correct Collect page and populated ledger.

## Reproduction and release boundaries

Local ignored evidence is under `build/perf-xiaomi-2026-10-17/`: Perfetto traces,
numeric timing records, build/signature checks and selftest logs. The 95-second
comparison cold-starts the app, performs twelve identical alternating swipes
at 5–22 seconds and again at 61–78 seconds, then records the next maintenance
window. Compare CPU occupancy and active animation cadence; rendered frame
counts across different spring settling durations are not equivalent FPS.

Diagnostic 62's later comparison was interrupted by Xiaomi `SwipeUpClean`;
its warm/late measurements are invalid. The exit record attributes that stop
to the system cleaner rather than an application crash.

Diagnostic version codes 61–63 are reserved artifacts, saved only as internal
drafts to obtain Google's existing app signature. Published production and
internal release 60 and store metadata are preserved. These diagnostics do
not change tracked app version configuration and are not a public release.
They contain only arm64 native libraries for this device. Rebuild a subsequent
public release for its configured production ABIs and version, using an unused
higher version code; do not promote a diagnostic draft directly.

Re-run the native fixtures when changing Noble or BouncyCastle acceptance
behavior. Do not replace the mathematical cache with cached authority state,
or make a native false result authoritative without an explicit protocol
compatibility decision.
