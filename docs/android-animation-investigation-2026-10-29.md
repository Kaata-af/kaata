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

Completed application FrameTimeline frames, excluding unfinished `dur=-1`
records:

| Interaction                       | Completed frames | App deadline misses | Longest completed frame |
| --------------------------------- | ---------------: | ------------------: | ----------------------: |
| Home card taps                    |               51 |                   3 |                118.8 ms |
| Home list swipes / filters        |              182 |                  24 |                129.2 ms |
| Profile settings open / close     |              126 |                   6 |                 44.3 ms |
| Home search keyboard open / close |               31 |                   0 |                 19.9 ms |
| Customer card taps                |               55 |                   3 |                115.9 ms |
| Customer currency carousel swipes |              107 |                   4 |                 29.9 ms |
| Customer list swipes / filters    |               78 |                  28 |                110.3 ms |
| Home filter popup / search cycles |               78 |                   4 |                 97.7 ms |

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
promotion is part of this request. Build, signing and installation verification
are pending; the version reservation is not a delivery claim.
