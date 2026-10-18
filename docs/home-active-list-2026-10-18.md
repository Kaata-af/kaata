# Home active-list experiment on Xiaomi

This branch tests one native Home ScrollView with the existing Collect/Pay tabs
and visual styling. Tab taps replace the horizontal page gesture. The two
financial groups retain their customer-ID keyed rows and headings, with only
the active group contributing flow height, touch and accessibility. Customers
without tallies have one shared section after the active group.

Caching is intentional: the first implementation recreated native text/views
on every tab change and was slower than the current version. Retaining rows
eliminated that creation, but changing visibility on every row still caused
property, text-state and layout work. The grouped implementation changes two
outer wrappers while reusing the exact child elements between tab taps.

## Correctness boundaries

- Existing customer classification, ordering, balances, totals, credit state,
  role checks and search-route safeguards remain authoritative.
- Home callbacks check current account, vault and direction, so a press begun
  on a row that becomes hidden cannot open the wrong customer.
- Android remembers independent offsets for both tabs. An imperative restore
  also aborts an old fling when both target offsets are numerically equal.
  Native drag timestamps fence out queued old events. The fence is set once
  at the first restore with a real native ref; later content-size callbacks
  must not reject a genuine drag already queued behind them.
- Closed search skips customer matching/ranking/sorting. Closed settings do
  not poll member counts. Summary hooks pause in the background, refresh on
  opening/resume, and reject late results after close or scope changes.
- Home imports the mesh status module and subscribes to peer updates only
  while settings is open. Closing removes the listener; queued callbacks and
  imports resolving after close cannot update the hidden sheet. Reopening
  reads a fresh snapshot and acquires one new subscription.
- An overlay that has never opened or has finished closing does not create
  exit animations when mounted or when hidden geometry/motion settings change.
  A real exit still keeps its content mounted until completion. Reopening
  cancels stale exit callbacks, and Reduce Motion still dismisses immediately.
- The native reuse and timestamp path is Android-specific. iOS/web use a
  keyed active page; they have host coverage but no physical-device profiling
  in this experiment.

## Controlled comparison

Device: Xiaomi Mi 10T, Android 12. Baseline source is
`c982e85fb892380909d1acb74f2046a9fbb42058`; its mobile UI is the current 2.2.2
implementation. The separate `af.kaata.bench` app is an offline, nondebuggable
Hermes release build with updates/Firebase disabled and no Internet permission.
It contains an anonymous synthetic ledger of 12 customers and 200 tallies.
Production `af.kaata.app` and its data are preserved.

The APK pair uses identical manifest, DEX, native libraries, resources and
signer: all 1,310 other non-signature payload entries are byte-identical; only
the verified Home JavaScript bundle differs. Source-map checks bind each bundle to its
actual source. The explicit final experiment scope contains four files:
`app/index.tsx`, `components/ProfileSettingsSheet.tsx`,
`lib/use-vault-summary.ts` and `lib/use-overlay-animation.ts`, relative to
`apps/mobile/`. Historical three-file E receipts remain separate and retain
their original scope checks. The rebuilt baseline's 1,311 non-signature
payload entries are also byte-identical to the archived original baseline;
its ZIP/signature container hash changed, not its application payload.

Each 135-second fresh-process capture has twelve alternating tab taps early,
twelve after a minute, an injected vertical-gesture phase and idle windows.
The final A8/A9/F1/F2 captures use byte-identical configurations, including
`task/task_rename` so process metadata follows the app's startup rename. Their
configuration SHA256 is
`ee8e46aaf8788057288999ab2fddecf33bb76be2add608f68b4cb4c8b6ec1737`.
The six financial rows per side fit on screen, so the vertical phase does not
establish meaningful long-list scrolling. Separate functional fixtures cover
that after every matched timing run is finished.

Local evidence and reproduction helpers are under ignored
`build/perf-xiaomi-2026-10-18-lab/home-ab/`: frozen source/APK snapshots,
verification receipts, Perfetto traces, per-run analyses, host-test logs and
functional UI evidence. This is an experiment, not a Play release or version
bump.

## Measurement interpretation

CPU values are scheduled running time for named main, JavaScript and
RenderThread threads, not total app energy use. Completed FrameTimeline
durations describe frame work, not exact touch-to-photon latency or universal
FPS. Removing the rail animation produces fewer frames; that alone is not a
smoothness improvement. Gfxinfo's 4,950 ms percentile sentinel comes from
unfinished frames and is not reported as a visible multi-second stall.

Repeated controls and OS thermal snapshots reduce obvious confounding, but
these are descriptive runs on one phone. Nonzero timestamp drops and service
chunk discards remain in trace-health evidence; zero queried overrun counters
do not prove loss-free capture. The offline synthetic comparison does not
measure signed-in maintenance or online startup on the real ledger.

## Repeated final-candidate results

The final comparison is baseline A8/A9 versus candidate F1/F2. All four pass
the standard captured-process, complete-action and exact four-source APK pair
gates. F includes the grouped active list, enabled summary hooks and both
closed-work fixes above. This comparison measures the complete candidate,
rather than isolating only the last two fixes.

A7 passed identity/action gates but lost 8,019 kernel ftrace events on CPU7
during cold-tab work. Its affected CPU totals are excluded, without repair;
A9 is the replacement control using the same capture configuration. The
separate exclusion evidence preserves its otherwise valid provenance.

| Run | Main / JS / RenderThread CPU, 0–133 s (ms) | Cold PSS (KiB) | Cold / warm maximum completed tab frame (ms) |
| --- | --- | ---: | --- |
| A8 | 9032.0 / 3996.4 / 3392.0 | 192448 | 16.29 / 24.59 |
| A9 | 9086.3 / 4029.1 / 3489.2 | 191866 | 16.60 / 24.59 |
| F1 | 8009.1 / 2640.0 / 1797.5 | 186304 | 26.24 / 20.37 |
| F2 | 7762.6 / 2344.7 / 1637.0 | 186675 | 19.37 / 30.45 |

Descriptive means across two runs per version:

| Window | Main CPU, baseline → F | JS CPU, baseline → F | RenderThread CPU, baseline → F |
| --- | --- | --- | --- |
| Full 0–133 s | 9059.1 → 7885.9 ms (−13.0%) | 4012.7 → 2492.4 ms (−37.9%) | 3440.6 → 1717.3 ms (−50.1%) |
| Cold 5–24 s + warm 61–80 s | 3307.2 → 2194.8 ms (−33.6%) | 1302.8 → 585.1 ms (−55.1%) | 1627.7 → 122.7 ms (−92.5%) |

Removing the rail animation contributes to lower rendering work. These
percentages describe selected-thread CPU, not faster tap latency or battery
savings. Cold PSS was 191,866–192,448 KiB (187.4–187.9 MiB) for the baseline
and 186,304–186,675 KiB (181.9–182.3 MiB) for F. The descriptive mean reduction
was 5,667.5 KiB (5.5 MiB), measured at the cold-window snapshot rather than peak
memory.

Completed tab-frame durations are not uniformly shorter for F. Neither
version had a finite completed tab frame over 33 ms in these four runs, but
the denominators differ: baseline A8/A9 have 364/369 completed tab frames,
while F1/F2 have 31/26. Three incomplete cold-tab frames in F are excluded.
Many F actions have only one app frame, so interval statistics are unavailable
and these counts must not be presented as equivalent FPS samples.

Compared with intermediate row-level hiding, regular native update batches
fell from 27 property / 5 state / 36 layout instructions to 6 / 2 / 4 per tap.
Both the baseline and final candidate have zero instrumented native
`createViewUnsafe` slices during tab switches; 124 startup slices in each run
show that the signal was present. Two text-state updates remain. Batch
instruction counts are not unique native-view counts, and nested wall slices
must not be added as CPU.

OS thermal status was 0 before/after every primary run. Battery temperature
snapshots before each run were 28.2 C, with the same reported nonzero cooling
states (`thermal-cpufreq-4=2`, `thermal-cpufreq-7=1`). No live HAL temperature
readings were available, so equal CPU frequency is not established.

| Run | Negative timestamp drops | Service chunks / patches discarded | Queried zero loss/overrun/overwrite counters |
| --- | ---: | --- | ---: |
| A8 | 2 | 29 / 3 | 55 |
| A9 | 1 | 30 / 3 | 55 |
| F1 | 1 | 27 / 3 | 55 |
| F2 | 2 | 28 / 3 | 55 |

The final four have zero queried kernel ftrace loss/overrun counters, but the
remaining drops/discards prevent a claim that every trace event was retained.
The full table, phase CPU, frame counts, hashes and caveats are in ignored
`home-ab/fifth-candidate-findings.json` and `.md` beneath the evidence root.

## Final artifact identity

The candidate source-map contents match these exact source SHA256 values:

| File under `apps/mobile/` | Final F source SHA256 |
| --- | --- |
| `app/index.tsx` | `a593c8b19a1790eb0b4cd889e9832df97b833268a22426b08cedb1ec07ac3568` |
| `components/ProfileSettingsSheet.tsx` | `27ea9be949a98e0aa432dcf07902cf9d4311a24b1b3f2e383b75847baf6dcaba` |
| `lib/use-vault-summary.ts` | `dd13e80f42b83d1c6d9bd3c9f2ea1bc4db7d54304f82b46e5cde9d5b84efad7f` |
| `lib/use-overlay-animation.ts` | `266de3dc3e7c1e7661581a1dfee65748d0f7df89a63f684fa1e91c20b231a5f1` |

Final F test APK SHA256:
`6b9334183183ea442d49f5301803257c572cbca4f3aa48360e42cd22b854176c`.
Final F JavaScript bundle SHA256:
`105b97ed835410802297e9554169c544f729b3a6d21c71de9c5da3a48da9b4c9`.
Final F source map SHA256:
`850df630f974fe8dbf7fbfd27ba61e5928c11859ce7ad02fead2bd4145340ad9`.
Matched rebuilt baseline APK SHA256:
`307aa2e75692ddf0841562e8d5851c357ecb02a0301c2b680f2242b67d42af3b`.

## Historical E comparison

Earlier A4/A6 versus E2/E4 runs showed lower selected-thread work with the
grouped list. Those three-source captures use a different trace configuration
and remain in `home-ab/fourth-candidate-findings.json` and `.md`; they are not
used to isolate the last two F changes. E1/A5 were rejected for stale
preinitialization process metadata. E3 was incomplete after an injected input
command failed; its cause remains unproven, and available app-specific
crash/ANR/exit records showed no app crash or ANR. None contributes to final F
numbers.

## Validation status

All 12 targeted F host checks passed, including typecheck, Home selection,
person find, summary-hook visibility, overlay/backdrop lifecycle, sheet drag
and search suites (`home-ab/host-tests-f/summary.json`). The new regressions
failed before the fixes: initially closed overlays constructed three animation
objects, and Home imported mesh once with settings closed. They now verify
zero hidden animation construction/import/subscription, preserved real exits,
late-import and stale-callback rejection, fresh reopen snapshots and cleanup.

Historical E phone checks passed 100 tab transitions, five settings cycles,
five vault-picker cycles and ten search/customer/back cycles in the same
process (`home-ab/functional/b-en-cca53c2130`). This does not substitute for
final F device validation.

Final F passed these separate, untimed checks on the connected Xiaomi:

- With the original 12 customers / 200 tallies: 20 verified tab transitions,
  five settings open/back cycles, five vault-picker open/back cycles and ten
  exact-search/customer-detail/back cycles, five from each side. Both ordinary
  customer action sheets opened and dismissed with Back. The process stayed
  alive throughout (`functional/b-en-be5ccc3990`). No financial action was
  submitted (`functional/b-actions-443cfcdab6` for the action sheets).
- English -> Dari -> English: both sides had the correct selected label and
  customer names; inactive-side customers were absent from the entire
  accessibility dump, including zero-bounds nodes. English was restored in
  the same process (`functional/b-rtl-9bc2e60fbf`). English and Dari screenshots
  were visually inspected for layout and card geometry.
- With 36 customers / 200 tallies, including 24 no-tally contacts shared below
  the financial groups: real drags established distinct Collect/Pay offsets.
  Three restoration pairs, a 100 ms fling followed by a cached Pay tap,
  three rapid ABA sequences, and search open/close on each side preserved
  named-row bounds within three pixels (`functional-scroll/b-b7e4c19abe`).
  The measured gap from fling-command completion through tab-command
  completion was 236.846 ms; no accessibility dump intervened.
- With 36 customers / 224 tallies (30 Collect, six Pay): two distinct long
  Collect offsets, the first Pay restoration to its top, three long/short
  restoration pairs, four bounded Pay drag checks, a fling-to-Pay check and
  three rapid ABA sequences passed. All six Pay rows remained fully visible;
  actual Pay displacement was zero, within its measured 153 px initial footer
  blank room. The corresponding fling-to-tab command gap was 237.525 ms.
  Saved row positions remained stable after the fling settled
  (`functional-asymmetric/b-416978000e`).

All matched timing runs finished before the fixture grew. Guarded, offline
seed builds used only public APIs in `af.kaata.bench`, ran twice to prove a
no-op rerun, and verified that the original 200 entries and original customer
balances were unchanged. The second fixture appended 24 synthetic one-AFN
tallies to the 24 new contacts. The exact verified final F APK was restored
before each UI suite. The UI helpers themselves submitted no ledger edits.

Two initial long-list helper failures remain preserved. One counted Android's
root accessibility ScrollView ancestor as an extra customer list; the other
expected mixed-case hero text and an inset above a heading actually rendered
in uppercase at the viewport edge. Both stopped before their first gesture.
Only the helpers changed: viewport ownership, geometry and heading checks
now have actual-XML and refusal tests. No application change or timing rerun
was needed. The short-list check allows existing footer padding rather than
assuming that any six-row list must have exactly zero scroll range.

The final fresh-process smoke also passed with the same verified F APK:
Collect at its top, one downward pull gesture, a ten-second settle, unchanged
hero amount and named-row bounds, Pay at its top with all six rows visible,
and a return to Collect ready for manual testing. Its screenshots were
visually inspected (`final-smoke/adf0fee71ce344a9ac2c1a34a8950911`). This verifies
the UI after the gesture; refresh callback/network completion was not
instrumented. Available benchmark-only diagnostics retained zero crash/ANR
events and 16 exit records, all marked USER REQUESTED from the deliberate
installs/force-stops. Retained OS records are not a complete lifetime history.

All 21 owned recording files, including the incomplete excluded E3 recording,
were preserved locally and SHA256 matched before individual device deletion.
No app data or shared user files were removed. The phone is left in the
separate final F benchmark app on English Collect; the production package was
never a target of these install, seed, gesture or cleanup helpers.

## Separate existing follow-up

Independent host review also reproduced an existing ordinary customer-removal
dialog scope gap: if the account/vault changes externally while its confirmation
is open, the callback can use the new scope. The ordinary action/dialog block
is identical to the frozen baseline; this performance patch does not change
it. A follow-up should invalidate ordinary dialogs on scope/role changes and
pass the captured scope to `archivePerson`. The reproduction and proposed
regressions are preserved locally in `home-ab/ordinary-action-scope-followup.md`;
no removal was exercised on phone data.
