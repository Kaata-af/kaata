# Lightweight Home swipe experiment

**Current status: J's code, Xiaomi interaction checks and comparison are complete.
Scrolling timings remain close, with added tab CPU work and memory documented
below. This is a tested feature checkpoint, not a zero-overhead claim.** Earlier
candidates and their evidence below are retained as history.

This follow-up adds horizontal swipe switching to the tap-only Home at commit
`840cbcc0292058b609c796b1f3917d0fc0cd1b3f`. It keeps the single ScrollView,
cached direction groups, independent offsets and financial presentation from
[the active-list experiment](home-active-list-2026-10-18.md). There is no moving
page rail or React state update while the finger moves. Tabs remain available.

The runtime change is confined to `apps/mobile/app/index.tsx`, SHA256
`b557ab279ddf3a74ed74c22128382046a81925d4bebe1ed8fbeab103ae45ab0d` (J).
No dependency, native configuration, version or ledger API changed.

J's local release benchmark APK is
`a22d65bdd4a59c12878a14224e2696207be958f0fd20bc5a66ad84c9175faa65`.
Its five host checks pass (selection, search/person-find, actual worklet/native
binding, mapper/frame regression, and typecheck). The Xiaomi suite
`home-swipe-ui/runs/g-005d535fbe` passes all 23 body gestures with the same
process, including EN/FA directions, real vertical movement, short/diagonal
rejection, long-press/detail navigation, blocked sheets, fling recovery and
independent offsets. English is restored. The separate refresh check
`refresh/g-cc6fdf8e74` preserves Collect's hero and named-row geometry;
refresh callback completion itself is uninstrumented. Both use synthetic
data and send no financial editing inputs.

## Final J comparison

The prospective F5/J1/J2/F6 comparison completed with the same workload,
native payload, synthetic fixture and original review rules. The post-test
audit `after-660d9ace59ef4da5a9d4df66ddf49489.json` confirms the unchanged
`24b094c4c1a3be20fd02b528c0cbeb032fe9ebb554e4769a8c0fbb5b69c35a82`
fixture: 36 customers and 224 tallies, with no financial editing inputs.
Local reports are `home-swipe-ab/j-tap-comparison.json` and
`home-swipe-ab/j-overhead-final.json` under the existing performance lab.

| Measurement | Tap-only F5/F6 mean | Swipe J1/J2 mean |
| --- | --- | --- |
| Observed main/JS/RenderThread CPU, 0–133s | 16,968.68ms | 17,416.41ms (+2.6%) |
| Main CPU, 0–133s | 9,089.05ms | 9,450.02ms (+4.0%) |
| Cold tab JS CPU, 19s/12 taps | 291.26ms | 370.91ms (+27.3%) |
| Warm tab JS CPU, 19s/12 taps | 395.67ms | 506.17ms (+27.9%) |
| Late-idle main CPU, 32s | 1,479.37ms | 1,522.53ms (+2.9%) |
| Post-cold PSS | 187,639KiB | 191,494KiB (+3.76MiB) |
| Mean per-run completed scrolling-frame p95 | 16.53ms | 16.85ms (+0.32ms) |

The tab JS difference totals 190.15ms across 24 taps, roughly 7.92ms of
additional observed JS CPU per tap; this is not input latency. Tab JS and
PSS still trigger the original review rules. Overall CPU and completed-frame
p95/tail rules do not trigger, with no frame tail beyond F's maximum +8ms.
J preserves the single-list design and close scrolling timings, while retaining
a measurable interaction/memory cost. The context cleanup does not establish
that all added tab work is removed. Two runs per variant are descriptive only;
the full report retains thermal, clock/scheduling and trace-health caveats.
This checkpoint remains on the feature branch; no store version is changed.

## Recognition and interaction boundaries

- The installed RNGH 2.32 Pan recognizer attaches to the actual loaded Home
  body through its existing outer View. Header, tabs, search dock and modal
  surfaces are outside that detector. Web retains its existing tap-only path.
- Native activation requires horizontal movement beyond 24 points; vertical
  movement beyond 12 points fails recognition before activation. Only one
  finger is allowed, and 24-point left/right gutters preserve edge gestures.
- The successful end must finish at least 60 points horizontally from DOWN,
  no more than 24 points vertically, with at least 2:1 horizontal dominance.
  Absolute finger coordinates preserve the complete displacement because
  Android Pan translation resets at activation. Velocity alone never commits.
- A hold of 350 ms before horizontal activation belongs to row long-press,
  rather than tab switching. A swipe that activated earlier may continue
  slowly; a 700 ms continuous swipe is covered by host tests.
- All five gesture callbacks are UI-thread worklets. Only a successful,
  eligible end schedules one `scheduleOnRN` handoff with an explicit target.
  Left selects physical-right Pay; right selects physical-left Collect,
  including Persian. There is no `onUpdate`/`onChange` callback or per-move RN
  state traffic.
- The RN handoff validates a captured epoch against the live owner, account,
  vault, starting direction, search generation and overlay state. Tab taps,
  including tapping the already-selected tab, invalidate old completions.
  Scope/search/modal ABA transitions, account identity events before React
  renders, blur and unmount cannot revive a completed old stroke. Header
  touches also invalidate pending body gestures before opening the bell.
- Home sheets/search, sign-out, selection writes, refresh and unavailable
  data disable recognition. Accepted ends use the existing tab-switch path,
  including its Android fling cancellation and native scroll-event fences.
  Customer classification, balances, totals and row identity are unchanged.

The first candidate (G0) kept the core RN ScrollView and RefreshControl directly.
Its Xiaomi checks passed ordinary slow/fast swipes, vertical/diagonal input,
row tap/hold and overlay blocking, but a vertical fling followed by a horizontal
swipe failed to switch. That failed case remains required. The preserved first
candidate has Home hash `008613d9bd49ffd854d6a0ceb698db1c97215f4eb4419e94527ba40ba5d84d9a`.

The revised candidate uses public `createNativeWrapper` around an **inner**
Reanimated ScrollView and animated RefreshControl. It mirrors RNGH's native
scroll/refresh pairing: the scroll handler waits for the refresh handler, and
both allow the Pan simultaneously without greedy activation or interruption.
The original scroll host ref, commands, key and offset callbacks are retained.
There is still one list. A shared `useEvent` worklet binds native gesture and
state events at both actual hosts, keeping those native-only events on UI.
Putting Animated outside the native wrapper would lose that event route;
passing a holder to a plain native child would lack event registration. The
installed-code host proof below checks the complete supported inner ordering.
The final build passed the native fling, row interaction and refresh checks
recorded below.

The coordinated candidate (G1, Home source `717cb8c8…`) fixed the initial fling handoff, then exposed an
intermittent native restoration race. In paired diagnostic run
`restore-probes/g-94c1a959db`, final XML0038 and its screenshot both showed
Collect at its top. Numeric logs retained the correct saved target
1532.727dp and recorded both restore commands, including the content-size
callback, without a subsequent matching native scroll event. No new drag had
taken ownership. Other returns in the same process restored correctly.
The preceding diagnostic run `g-4d5fabf5be` ended deep at 1421.45dp: its final
XML0038, screenshot and native event agreed. Its earlier top-position
observations lacked paired images and surviving numeric logs. That final
successful return and the later paired `g-94c1a959db` final top are distinct
observations; the evidence does not establish a stale accessibility snapshot.

RN 0.86 Fabric emits layout events before mounting the revision
(`ShadowTree.cpp`), and its Android mount dispatcher executes view commands
before mount items (`MountItemDispatcher.kt`). A content-size callback can
therefore describe the new long layout while a command still sees the old
short native content. The final correction retains the immediate fling-abort
command and coalesces one follow-up `requestAnimationFrame` from content-size
work. Android's UI dispatch runs before timer/RAF delivery in
`ReactChoreographer` and `JavaTimerManager`, supplying the next mount boundary.
There is no retry loop or arbitrary time delay.

The completion owns its page, scope and pending-restore lifetime. A fresh drag,
new page, scope change, unmount, account notification or owner blur invalidates
stale work; identity reload and focus regain can schedule the current pending
completion. Same-tab taps, header touches and ordinary overlays retain useful
completion work for the same page. Search keeps its existing generation guard.
The first actual restore's timestamp fence is unchanged. The final physical
checks below cover this correction.

## Artifact identities and controlled comparison

The corrected H APK is
`e2107267ed3f1d31d27e6ea865a7b8e961f43c4ecc5ec57c090a4a0040e9d7f9`,
with Hermes bundle SHA256
`161e6865bd27555487e2e8bffaad4ae29a66939af7f2c2d5faab870133da222e`
and map SHA256
`5817d99aca082af41c952ecd80a02fab3a109cdc2614193f1cf0fa220eab87c7`.
Strict verification proves 1,310 unchanged payload entries, with only the
Hermes bundle replaced: native code, DEX, manifest, resources and signer are
identical to F. Home is the only changed bundled app source. Its local build
completed successfully; no store release or version increment is included.

The preserved tap-only F APK is
`6b9334183183ea442d49f5301803257c572cbca4f3aa48360e42cd22b854176c`.
Its verified baseline Home source hash is
`a593c8b19a1790eb0b4cd889e9832df97b833268a22426b08cedb1ec07ac3568`.
The functionally passing, subsequently rejected G APK is
`2150cd8e0792682e867242ed33ef10c1af06bbe4368a0b59f8cfe2c3acf1ff0e`,
with Hermes bundle SHA256
`46239b0de82becc7acc9e18941b549f3373a43598d8b40e7e55a47bbe111e0cb`.
Its verified Home source is `05d943aaa6c9ca07c88e5c585e7262680161bc1f070dced507140c48331107d2`, without diagnostic
logging. Physical interaction checks passed, but the matched F1/G1/G2/F2
comparison found repeatable background CPU overhead, so G is not accepted.

Evidence and independent helpers live under ignored
`build/perf-xiaomi-2026-10-18-lab/home-swipe-ab/`, separate from the original
active-list evidence. The root-run comparison uses the Xiaomi Mi 10T and the
offline, nondebuggable Hermes `af.kaata.bench` package. It preserves the
anonymous synthetic fixture of 36 customers and 224 tallies: 30 Collect,
6 Pay, with the original 200 entries and 12 original balances unchanged.
Production `af.kaata.app` and its ledger are outside the experiment.

Before timing, the strict APK pair must verify identical manifest, DEX,
native libraries, resources and signer, with only the verified Hermes bundle
changed. Only Home may differ among bundled app sources; host tests and the
new test script must not enter the runtime source map.

The primary performance comparison is matched **tap input**, F1/G1/G2/F2,
with identical cold/warm tab, vertical-scroll and idle windows. Separate
candidate swipe runs measure another input method and must not be folded
into the tap aggregate. Before/after read-only fixture fingerprints must
agree. Prior 12-customer/200-tally percentages are not transferable to this
36/224 comparison.

## Host validation

The actual Home/person-find suites pass with new recognition and queued-end
regressions, preserving their existing financial, selection, search, role,
scope, native offset and iOS/web fallback checks. Typecheck passes.
Their restoration regressions explicitly flush a controlled frame after a
simulated short native layout, require the saved offset to be reached, check
coalescing and absence of a frame loop, and deliver canceled callbacks after
fresh drags, page/scope changes and unmount. They also preserve pending work
through same-tab/header touches and ordinary Settings, and reject an old
content callback without canceling the new page's frame.

`npm run selftest:home-swipe-worklet` transforms the actual Home recognizer
factory with installed Worklets 0.10.1, then registers it on the actual
installed RNGH Pan class. All five callbacks have `__workletHash`, no update
or change callback exists, and the real `shouldUseReanimated` getter is true.
It also executes installed `createNativeWrapper`, `createHandler`, `useEvent`,
`WorkletEventHandler`, `NativeEventsManager`, Animated ref forwarding and
`PropsFilter`: the handler chooses `REANIMATED_WORKLET` before filtering, four
event registrations target the inner scroll and refresh hosts, detaching one
preserves the other, and native refs retain `scrollTo` and relation tags.
This host proof does not load native modules or the app database. The actual
Home suites additionally check simultaneous refs, refresh `waitFor`, the
shared event holder and preserved scroll configuration.

Additional relevant suites all passed without changes or fixture repairs:

| Suite | Result |
| --- | --- |
| `selftest:selection-gesture` | PASS; real RN Pressability, holds, cancellation and accessibility |
| `selftest:tabs` | PASS; 44 shared-tab regressions |
| `selftest:tab-settlement` | PASS; preflight, revision, retry and late-session acknowledgement |
| `selftest:sheet-backdrop` | PASS; hidden-work, motion, interrupted overlay lifetimes |
| `selftest:sheet-drag` | PASS; drag ownership, native replies and cancellation |
| `selftest:search-sheet` | PASS; search shell plus owner/modal focus lifecycle |
| `selftest:auth-redirect` | PASS; settings entry, native Back and scoped account handoff |

Their complete logs and hashed summary are in
`home-swipe-ab/host-tests-extra/summary.json` under the ignored evidence root.
Those seven additional suites were run against the first `008613d9…` source.
Final native-binding/recognizer evidence and the correction's typecheck and
worklet logs are in `home-swipe-ab/host-tests-native-binding/`.

## Physical validation and remaining limits

The rejected G APK passed these Xiaomi Mi 10T checks in the isolated synthetic
`af.kaata.bench` app. Evidence paths below are relative to ignored
`build/perf-xiaomi-2026-10-18-lab/home-swipe-ui/`.

- `runs/g-f2394a223a`: the unchanged full interaction suite passed 23 body
  gestures in English/Persian and restored English. It covered deliberate
  slow/fast swipes, physical tab order, vertical/diagonal rejection, row
  tap/hold, Search/Settings blocking, fling-to-swipe and mixed tap/swipe
  offset restoration.
- `refresh/g-58fd232681`: a 1200ms downward pull preserved the selected
  Collect tab, hero and named-row geometry after a ten-second settle. The
  refresh callback itself was uninstrumented; this proves visual gesture
  compatibility, without claiming a successful network refresh.
- `restore-stress/g-464b2182ca`: six bursts of two rapid Pay-tap/Collect-swipe
  cycles passed all 12 cycles with no named-anchor drift.
- `restore-probes/g-39fa9e7579`: all 15 paired observations completed.
  Settled tap/swipe returns preserved their original position; after the
  fling moved the list, all five fling-return, three mixed-return and final
  tap-return snapshots retained Contact04 at the same deep position.
  Captured XML and screenshots agree, including the final tap that failed
  in G1. Raw evidence and artifact provenance were independently reviewed.

The subsequent pre-matrix read-only audit
`home-swipe-ab/audit-results/before-cb68636e46ff43cfbba38298831c608c.json`
verified 36 customers, 224 tallies, 30 Collect, six Pay and no neutral
customers, with the original 200 entries and 12 original balances unchanged.
Foreign keys were valid and no transaction remained open. Its fixture
fingerprint is
`24b094c4c1a3be20fd02b528c0cbeb032fe9ebb554e4769a8c0fbb5b69c35a82`.

These are functional checks on one Android phone, and injected gestures do
not measure input latency. Multi-touch and OS-edge navigation were not
physically injected. iOS recognition is enabled with host coverage; an
iPhone device check remains outstanding.

## Rejected G performance and attribution

F1/G1/G2/F2 completed with the same tap inputs and unchanged fixture
fingerprint before and after. G's mean observed main-thread CPU over 0–133s
rose from 9,203.69ms to 10,641.56ms. Late-idle main CPU rose from about
1,504.54ms to 2,557.56ms over 32 seconds; tab-window JS CPU rose 23.0%.
Scroll completed-frame p95 remained similar (16.49ms versus 16.64ms), but
that did not justify the extra idle work. These are descriptive observations
on one phone, not whole-app CPU, input latency, FPS or energy measurements.
The raw four-run evidence and predeclared review thresholds are preserved
under `home-swipe-ab/frame-tap-comparison.*` and `frame-overhead.*`.

The extra work occurred inside the existing roughly 50Hz animation callbacks.
CPU placement and frequency were similar, and the callback count did not
increase. A separate shell-profileable diagnostic of the same G Home source
reproduced the post-scroll increase without prior tab switches. Reanimated's
native operation/event labels appeared during scrolling and were absent in
idle. A ten-second main-thread stack sample then located most sampled work
under Worklets' animation callback executing Hermes, including requeuing
callbacks. This diagnostic is attribution only and is excluded from the
quantitative F/G comparison.

Installed Reanimated 4.5.1 `core.ts` starts a recurring `runMappers` frame
waiter for each event while `global.__mapperRun` is absent. Its mapper registry
is initialized lazily by mapper hooks. Home's gesture/event handlers alone
did not initialize it, allowing scroll events to accumulate waiters. The
correction uses the supported animated-reaction hook for actual gesture
lease cancellation, while keeping the recognizer stable across tab changes.
The corrected H Home source SHA256 is
`48a209e1cdbeb2d30c1b186312dd7664bed9725bc15798f8d92c44e6693bbd3d`.
One atomic UI lease carries the epoch and source tab; DOWN reads it once.
The reaction observes only that lease, cancels a stroke with a stale epoch,
and preserves a fresh stroke already using the current epoch. The Pan no
longer closes over direction or rebuilds its callback set on a tab change.

`selftest:home-swipe-frame` executes installed Reanimated core, mapper,
animated-reaction and Worklets RAF code with Home's actual transformed hook.
Before mapper initialization, each delivered event leaves a recurring waiter.
The actual Home reaction initializes the registry, drains existing waiters on
the next frame, and 1,100 further events never regrow them. It also verifies
stale-stroke cancellation, current-stroke preservation and subscription
cleanup. This is a host algorithm/closure proof with explicit bridge stubs;
Android/Hermes timing remains a separate device measurement.

H's physical checks pass below. Its fresh F3/H1/H2/F4 comparison completed
with the original review thresholds; the rejected G measurements remain
preserved separately.

## Corrected H physical checks

The corrected H artifact passed the unchanged Xiaomi suites. Paths below are
under `home-swipe-ui/`; the helpers retain historical `g-` folder prefixes,
while their exact APK/source provenance identifies H.

| Evidence | Result |
| --- | --- |
| `refresh/g-36be5af1c8` | Pull compatibility passed; hero and named-row geometry restored. Refresh completion itself remains uninstrumented. |
| `restore-stress/g-dd75c10691` | Twelve rapid tap/swipe cycles in six bursts; Contact20 remains exactly `[47,611][1033,806]` in every XML/PNG. |
| `runs/g-0b79adb9bc` | All 23 body gestures passed; slow/fast EN/FA swipes, vertical movement, short/diagonal rejection, exact row detail/back, hold menu, blocked overlays, fling-to-swipe and mixed offsets. English restored; PID13590 unchanged. |
| `restore-probes/g-e598895712` | Fifteen paired observations completed with PID18868 unchanged. Settled returns retain Contact20 at `[47,595][1033,790]`; after the real fling, every return retains the new deep Contact05 at `[47,674][1033,869]`, including final XML0038/PNG. |

These are functional observations, separate from the timed comparison. No
financial editing inputs were sent. Multi-touch, OS-edge injection and iPhone
device coverage remain outside this Android experiment.

## H performance review

The unchanged read-only fixture fingerprint after F3/H1/H2/F4 is
`24b094c4c1a3be20fd02b528c0cbeb032fe9ebb554e4769a8c0fbb5b69c35a82`
(`audit-results/after-2e0bc8e2f59c48809c2ac771b9d9f0bc.json`). All four
strict capture/identity checks passed. The descriptive means are:

| Measurement | F3/F4 | H1/H2 |
| --- | --- | --- |
| Observed main/JS/RenderThread CPU sum, 0–133s | 16,806.14ms | 17,558.15ms (+4.5%) |
| Main-thread CPU, 0–133s | 8,933.61ms | 9,492.54ms (+6.3%) |
| Warm-tab JS CPU, 19s/12 taps | 375.2ms | 484.4ms (+29.1%) |
| Late-idle main CPU, 32s | 1,460.6ms | 1,521.5ms (+4.2%) |
| Post-cold PSS | 183,853.5KiB | 188,342.5KiB (+4.38MiB) |
| Mean per-run completed scrolling-frame p95 | 16.91ms | 16.64ms |

The large G post-scroll animation effect is gone in both H runs. Completed
frame p95/tail review rules do not trigger, but main CPU, tab JS and memory
still trigger the recorded review rules. H is therefore not yet accepted;
the remaining per-tab work needs attribution. Release scheduling slices do
not identify its JavaScript function. Separate diagnostic instrumentation
will measure bounded RN-side call counts and nested wall time; it will not
enter the quantitative comparison.

All four runs reported thermal status zero and 27.7°C before capture, with
the same nonzero CPU-frequency cooling states and no HAL live-temperature
data. Fifty-five queried other trace-health counters were zero in each;
negative timestamp drops (4/8/6/2), discarded service chunks (36/37/38/39)
and three discarded patches per run remain explicit. Those facts do not
establish identical clocks or loss-free timing. Two runs per variant cannot
establish statistical equivalence, input latency, FPS or energy savings.

## J: stable gesture surface, final comparison pending

J keeps the GestureDetector and its Animated wrapper behind a module-level
memo surface whose only prop is the stable Pan. An outer context provider
passes the complete live list props to a child consumer, so direction, data
and callbacks update without rerendering the gesture owner. There is no
custom comparator or stale callback cache. The existing noncollapsed body,
single ScrollView, refresh pairing, keys, refs, gesture guards and offset
restoration are unchanged; web keeps its tap-only path.

The completed F diagnostic and partial H capture show repeated detector and
Animated lifecycle work. The H sample is incomplete and is not a matched
40-tap comparison or a quantitative cost ratio. Warm-window frequency was
about 1% higher in H, so lower clocks do not explain its 29.1% JS CPU increase;
core placement remains a confound. Diagnostic wall time includes probe
overhead and is not clean-build CPU time.

Home-selection, person-find, installed worklet/native-binding proof,
mapper/frame regression and typecheck all pass for J. Logs and hashes are in
`home-swipe-ab/host-tests-context/summary.json`. The narrow fixtures verify
fresh context props and existing behavior, while executing memo functions
normally; the final phone run must establish native context behavior and
whether the cleanup materially reduces the measured overhead.
