# Android animation investigation — October 29, 2026

## Installed testing release

Tested the user's Play-installed Kaata 2.3.0 / Android code 79 on the connected
Xiaomi Mi 10T (M2007J3SY), Android 12 / API 31. The installed package is a
non-debuggable release. Its runtime source is the previously delivered testing
candidate `52cf872478c75d9b4b2ed25df74e914c427f6887`.

Two 110-second Perfetto captures exercised existing data with reversible card
filters, list swipes, carousel swipes, profile settings, the search keyboard and
the inline filter popup. No tally, customer or financial record was saved,
edited, settled or deleted. Screen recording was not running during profiling.
The device selected its 50 Hz display mode; thermal status remained 0.

Completed application FrameTimeline frames for the first Home capture,
recomputed by excluding every unfinished/nonpositive-duration record before
aggregation:

| Interaction                       | Completed frames | App deadline misses | Longest completed frame |
| --------------------------------- | ---------------: | ------------------: | ----------------------: |
| Home card taps                    |               50 |                   2 |                118.8 ms |
| Home list swipes / filters        |              180 |                  22 |                129.2 ms |
| Profile settings open / close     |              126 |                   6 |                 44.3 ms |
| Home search keyboard open / close |               31 |                   0 |                 19.9 ms |

The second capture's longest positive-duration frames were 115.9 ms for
customer card taps, 29.9 ms for the customer currency carousel, 110.3 ms for
customer list filtering and 97.7 ms for Home filter popup/search cycles.

These are small, controlled workloads on one phone, not universal FPS or touch
latency measurements. The popup workload also includes opening search and
dismissing the keyboard. Numerous Buffer Stuffing events indicate presentation
pacing issues separately from application deadline misses. The graphics
histogram's apparent 4950 ms outliers come from invalid unfinished records and
are not evidence of five-second animations. The captures contain 19 and 16
dropped negative-timestamp events respectively; the results are not lossless.

## Where the hitch occurs

Home's 17.5-second swipe phase used about 3.34 seconds of native main-thread CPU
and 1.32 seconds of JavaScript CPU. Native text drawing used 644 ms exclusive
CPU; creating 492 text views used another 197 ms, and text-state updates 171 ms.

Approximate windows around the eight swipe markers separate finger tracking
from release/filter updates. Tracking accumulated 23 text draws / 12.7 ms and
had a longest main frame of 25.6 ms. Release accumulated 1,822 text draws /
597.9 ms and had a longest main frame of 119.9 ms. All four 114–120 ms main
frames occurred when the repeated swipe restored “All,” coinciding with large
Fabric view mounting batches. ADB dispatch introduces uncertainty in these
sub-windows, so they establish the pattern rather than exact input latency.

The customer list exhibits the same expensive filter-update pattern, while its
native currency carousel is substantially steadier. Keyboard rendering did not
miss an application deadline in the first workload. This supports reducing
repeated native view creation and card layout work instead of disabling all
Android motion or changing the iPhone presentation. Native trace labels do not
identify individual React components, so they cannot isolate each card's share
of the cost from the list's share.

## Targeted implementation

- Android keeps already displayed active list rows mounted while filtering,
  hiding excluded rows without layout space, touch targets or accessibility
  exposure. Returning to “All” can reuse their native text views. It does not
  eagerly mount an unseen complete list. Current authoritative records determine
  membership and data; deleted or newly settled records leave the active cache.
- Row handlers resolve current visible records and reject hidden, busy,
  obsolete-scope and unmounted interactions. Scope changes retire old leases.
- Android width transitions run only for physical currency pages intersecting
  the carousel viewport, including partially visible neighbors and either loop
  copy. Offscreen pages immediately adopt the final layout. Observed scroll
  position is tracked separately from a requested animation destination.
- Width effects compare requested layout targets on JavaScript instead of
  synchronously reading shared animation values from the UI runtime.
- iOS retains the existing list filtering and card-animation presentation.

The implementation changes no financial calculations, records, sync protocol,
notification policy or permissions. Existing reduced-motion behavior remains.

## Verification and release boundary

Validation passed mobile TypeScript and 15 focused selftests covering row
retention, both screens, carousels, selection, settled history, gestures, search
controls and keyboard behavior. The row checks cover current
sort order, zero matches, hidden input/accessibility, updated and removed
records, settled membership, currency projections, role changes and stale
account/book callbacks. Carousel checks cover sentinel copies, partial pages,
rotation, stale geometry and unchanged automatic scrolling behavior.

The table above measures the installed release before these changes. It is not
a before/after claim for the patch. Expo Go failed to download the local update
over both USB and LAN, before the app could load, so the patched physical-device
functional check remains unverified. Its logs reported `UpdateFailedToLoad`;
the existing local server did return the Android bundle successfully to a host
request. No Expo Go data was cleared or reinstalled. The phone was returned to
the installed Kaata homepage with no temporary filters or keyboard open.

A fresh release-mode testing build must be measured on the Xiaomi before
production promotion. Expo Go does not establish release performance even when
it loads successfully.

Private screenshots, traces and offline query outputs remain ignored under
`build/android-motion79-20261029/`. No store build or production release was
started during the initial investigation.

## Requested Xiaomi update

The user subsequently requested a fresh build installed on the Xiaomi. A new
read-only Play preflight on October 29 found Android code 80 unused, with code
79 still on internal testing and production unchanged at 2.2.4/code 73.
Android code 80 reserves this local testing candidate; iOS remains build 46.

The phone's Google Play signing certificate differs from the local upload-key
certificate. A locally signed APK cannot update the installed app in place.
The build will therefore require a matching Google-signed generated APK before
installation. No uninstall, data clear, signing replacement or production
promotion is part of this request.

### Completed local installation — Android 80

Built from committed source `73750940a0a3671fcd3800916cf22ccac943565d`, including
the Android optimizations in `05ae256`. Fresh release constants and Hermes
compilation passed, followed by incremental Android release packaging with the
existing native compilation outputs and upload signer. All **74 AAB checks**,
**14 local APK checks** and **10 Google-signed APK checks** passed. The 18 cached
native tests were bound to their unchanged tested source and passing output.

After explicit authorization for Google signing, the verified bundle was
uploaded once and saved as an **unassigned artifact**. Google required an
artifact save before exposing the generated APK. The save used
`changesInReviewBehavior=ERROR_IF_IN_REVIEW`, with no track or release writes.
The initial unsupported optional save parameter was refused before any commit;
its intent and receipt were retained before the reviewed corrective request.
Independent readback verified that all tracks, details, listings, images and
tester configuration remained unchanged. No build-80 testing or production
release was created: internal testing remains 79 and production remains 73.

| Artifact                             | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| AAB, 95,128,986 bytes                | `662e0c26f7757abaead3be61e20ad5ffa11b653637602d8022c1af5aaa5aab60` |
| Local APK, 142,892,456 bytes         | `6099706720793fb97c3c3551296484133f4866ed5709f04e4bb391de3c1577fa` |
| Google-signed APK, 142,969,503 bytes | `6f1e97f29aea76ddec36f71441c19c6188546508d49eb1f1a32d53ceb8332368` |

The final APK's actual certificate matched a freshly pulled installed APK.
`adb install -r --no-incremental` returned success. Android code 80 retained the
original application UID and first-install time; no uninstall, data clear,
permission grant, downgrade or replacement signing identity was used. Cold
startup succeeded, and the existing signed-in Kaata and multi-currency customer
history were visible. These checks establish an in-place update and retained
visible history, not a full database checksum comparison.

Private installation, signing and artifact receipts remain ignored under
`build/release-2.3.0-80/`. Code 80 is now a saved Play artifact and an installed
local candidate; future testing updates must use a higher code. iOS build 46
and all public mobile releases remain unchanged.

### Installed build 80 animation check

The repeated Home workload completed on the physical phone without a process
restart. Home returned to its unfiltered list with the keyboard and settings
closed. Existing multi-currency customer history was also inspected after the
update without saving any records.

Home swipes produced 251 completed app frames, 22 application deadline misses
and a longest completed frame of 70.0 ms. Main-thread frame work peaked at
43.3 ms, compared with 119.9 ms in the earlier code-79 capture. Native text-view
creation during swipes fell from 492 to 58, and text measurements from 1,426 to 658. This supports removal of the large repeated mounting cost, while remaining
missed deadlines show that the work is not complete.

These runs are not an exact controlled A/B: visible list content differed
slightly, and the fresh session's early idle/card phase had substantial extra
rendering. The code-80 card phase had 276 completed frames and 26 application
deadline misses, with a longest frame of 243.8 ms; it does not establish a card
performance improvement. A warm card-only comparison is needed before changing
the remaining visible-card width animation. Settings produced 129 completed
frames / 6 app deadline misses and keyboard 32 / 1. Baseline and final display
snapshots showed 50 Hz, but the actual build-80 swipe phase switched to a
16.667 ms frame budget (60 Hz), compared with build 79's 20 ms (50 Hz). These
cadence differences also prevent a controlled FPS or miss-rate comparison.
The trace dropped 13 negative-timestamp events and is not lossless.

Private post-install traces and query results remain ignored under
`build/android-motion80-20261029/`. The app is left open on the Xiaomi homepage
for the user's own testing; no public release or production promotion occurred.
