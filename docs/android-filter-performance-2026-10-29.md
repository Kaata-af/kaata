# Xiaomi profiling with animations off

## Finding

The connected Xiaomi was running the current app in Expo Go, with Account →
Preferences → Animations visibly set to Off. This confirmed the report was
about the new application setting, rather than Android's system animation
scale or the older installed release.

Disabling motion did not remove the main Home filter cost: changing the global
collect/pay direction still rebuilt the layouts and native text of every
physical currency card, including distant pages and loop copies. Disabling
the tween alone had left this work intact.

## Method and rejected alternatives

Perfetto captured reversible interactions on the same Xiaomi Mi 10T / API 31,
development ledger and six-currency carousel. The repeated Home workload used
four card taps, eight list swipes, two settings open/close cycles and two
keyboard open/close cycles. A final shorter capture repeated the eight swipes
after a gutter-intersection refinement. The original animations-Off setting
was preserved. No customer or financial records were saved, edited or deleted.

Completed positive-duration app FrameTimeline records were counted individually;
unfinished records and the graphics histogram's invalid 4,950 ms bucket were not
treated as real stalls. Main-thread frame work uses Choreographer slices;
text CPU time intersects text slices with actual scheduled thread-running time.
These are distinct from end-to-end touch latency or universal FPS.

Two useful negative checks narrowed attribution:

- Temporarily replacing Android's blur capture hosts with ordinary views did
  not establish a meaningful gain. That source variant was restored.
- Keeping `PersonRow` memo props stable through filtering removed redundant
  React work, but native text updates stayed around 628 in eight swipes. It is
  a small cleanup, not the measured native performance fix.

Temporarily holding summary card layouts constant while leaving list filtering
active reduced app deadline misses to 1 in eight swipes. Normal card behavior
was then restored before implementing and measuring the actual optimization.

## Implemented changes

- Android balance cards defer **direction-only** updates on distant pages.
  Intersecting pages and one neighbor on each side stay ready; real and
  sentinel copies of a prefetched currency both update before loop recentering.
- Page bounds intersect actual card rectangles, excluding the 12 dp gutters.
  Small native pixel-rounding offsets no longer wake an extra distant page.
- Deferred cards take their final widths when entering the prefetched range.
  Visible cards retain normal filter animations. Amounts, pending state,
  language—including Dari → Pashto—geometry, font scale, motion preference and
  interaction changes still invalidate immediately. iOS retains its prior
  rendering and effect timing.
- Stable card callbacks consult current interaction/handler refs. Hidden
  customer wrappers retain input/accessibility exclusion and live callback
  guards without forcing unchanged row text to render via a disabled-prop change.
- Shared-account cache updates read previous states only for incoming IDs,
  using bound SQL batches. Empty polls no longer copy the complete saved
  history into JavaScript. This changes no protocol or financial calculation.

## Device measurements

Animations were Off in both columns; normal card/list filtering was active.
The final column is the actual implementation, not the frozen-card diagnostic.

| Eight list swipes                       |   Before | Final implementation |
| --------------------------------------- | -------: | -------------------: |
| Native text state updates               |      619 |                  254 |
| Native text draws                       |    1,145 |                  504 |
| Native text-drawing CPU                 | 374.4 ms |             149.5 ms |
| Longest native main-thread frame        |  52.9 ms |              31.0 ms |
| Frames with application deadline misses |       14 |                    6 |
| Completed app frames                    |       45 |                   39 |

An earlier implementation with conservative page bounds measured 175.3 ms of
text-drawing CPU and 9 deadline misses; the final gutter refinement reduced
unnecessary updates further. Frame timing varies between runs, so these small
samples support reduced work and fewer hitches rather than a guaranteed speed
multiplier. Thermal status remained 0. Both baseline and final captures dropped
7 negative-timestamp events. Expo Go overhead, differing warm-cache history,
and these trace diagnostics limit comparison with production.

## Verification and release boundary

The related row, Home selection, row reuse, Home balance, shared-cache,
reconciliation, settlement and shared-history regression suites passed, along
with mobile TypeScript, formatting and whitespace checks. Tests cover skipped
far-page renders, fresh amounts/locale/access, real partial pages, empty gutters,
deferred catch-up, both loop copies, current callbacks and unchanged iOS behavior.
The cache fixture verifies zero previous-history reads for an empty poll on a
2,401-row history, bounded incoming-ID queries, full replacement/deletion,
optimistic-row survival and unchanged review/void notifications.

A physical functional check temporarily enabled normal animations, applied the
global pay filter, traversed all six currencies through a loop and confirmed
the visible card's filter remained correct. It restored Off and the unfiltered
homepage at the original currency. Temporary diagnostic source was restored;
private traces and receipts remain ignored under
`build/android-followup-20261029/`.

The final JavaScript changes are loaded in the Xiaomi's Expo Go session. The
installed Play-signed build 80 is unchanged. No new packaged app, store upload
or release was made. Release-mode confirmation is still required before
production promotion. These measurements concern Home's multi-currency filter
workload, not cold startup, all app screens or memory use on every device.
