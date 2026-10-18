# Android performance follow-up — October 18, 2026

The locally built 2.2.2/code 64 release was submitted to production and installed
in place from Google's signed APK. Source and submission details are recorded
in `2.2.2-android-release.md`. Further changes are on
`codex/android-startup-followup`; they are unreleased and do not alter the
submitted code 64 artifact or its device-check results.
Google's read-only lifecycle API confirmed production code 64 **PUBLISHED**
at `2026-10-18T02:54:38.639Z`.

## Exact release device check

Device: Xiaomi Mi 10T, Android 12. The APK signature matched the previously
installed Play app, all 11 final APK checks passed, and existing data remained
visible after the update. Home was populated in the 2.5-second cold-launch
screenshot. A cold search tap at approximately 2.58 seconds reached the search
screen and displayed query results in the subsequent captures. These are host
command/capture times, not input-to-photon measurements.

The release survived 100 rapid horizontal swipes, 10 vertical scrolling passes,
and 20 search/customer/back cycles in the same process, without a crash or
restart. Tests only navigated and searched; they did not edit ledger entries.

## Release baseline

A 115-second Perfetto recording separated cold swipes (5–24 seconds), warm
swipes (61–80 seconds) and idle time (81–113 seconds). JavaScript thread running
time was 2,700.4 ms in seconds 0–5, 926.1 ms in seconds 5–24 and 1,716.4 ms in
seconds 61–80. The first five swipe windows had median frame intervals near
20 ms on the observed display cadence; occasional 40–60 ms gaps remain. These
numbers do not establish universal FPS or touch latency.

JavaScript used 197.5 ms of CPU in the separate 32-second late idle interval
(approximately 0.62% of one core). Main-thread CPU was 1,390.2 ms (4.34%). The
trace recorded 1,596 animation callbacks and zero app FrameTimeline frames
during that interval. Non-overlapping Choreographer regions accounted for about
64.8% of main-thread CPU. Installed React Native 0.86.2 contains matching
foreground callback loops; the trace does not identify each callback's exact
implementation. No framework patch was made.

Full sorting removed 49 trace event-order warnings; one negative-timestamp
event was dropped. The queried loss/overrun statistics reported none. Launch
and gesture boundaries use host timing and the device uptime clock. Local
evidence, private screenshots and traces remain ignored under
`build/perf-xiaomi-2026-10-18-lab/release64/`.

## Unchanged credit-policy responses

Commit `af131f1` suppresses cache writes when all persisted values are equal and
only emits a policy-change notification after a changed transaction commits.
Null-safe SQL comparisons preserve timestamp ordering, pending local intent,
vault filtering and the existing session/version guards.

An integration harness using the real refresh/cache code and SQLite measured:

| Responses after cache priming              | Notifications before → after | Row changes before → after |
| ------------------------------------------ | ---------------------------- | -------------------------- |
| Two unchanged empty responses              | 2 → 0                        | 0 → 0                      |
| Three identical customer/default responses | 3 → 0                        | 6 → 0                      |

The regression verifies real insert/update/delete notifications after commit,
nullable and zero caps, restrictions, timestamps, repeated responses, rollback,
wrong-vault rows, pending intent, stale versions and account/session changes.
Credit limits, shared credit, member permissions, credit settings UI, recovery
session selftests and mobile TypeScript checking passed. This proves redundant
work was removed; a screen-latency improvement has not been measured separately.

## Remaining cold cryptography

Healthy boot validates the SecureStore seed against its public-key mirror.
The code 64 Noble 2.3 implementation initializes a large base-point table on
its first derive/sign/ordinary verify. A separate offline Hermes release app,
`af.kaata.bench`, measures fixed public synthetic fixtures in fresh processes.
It has a separate Android sandbox and no Internet permission. The submitted
Kaata package and signing identity remain intact.

V1 completed 30 fresh-process runs on the Mi 10T: five repeats of each of six
derive-first/sign-first modes, with their order interleaved. Every correctness
check passed. The following values are milliseconds, shown as median
[minimum–maximum] across the five processes. Cold totals include module load,
table configuration and the first operation; they are not full app-launch
times.

| First operation | Noble Ed25519 2.3.0    | Noble curves 1.9.7, window 4 | Noble curves 1.9.7, window 8 |
| --------------- | ---------------------- | ---------------------------- | ---------------------------- |
| Derive          | 345.98 [344.25–360.30] | 90.00 [87.36–96.96]          | 584.99 [577.29–591.92]       |
| Sign            | 350.09 [345.78–355.93] | 99.13 [92.24–103.23]         | 583.49 [578.55–597.10]       |

Window 4 trades slower warm operations for the smaller cold table. In the
derive-first runs, warm derivation changed from 3.77 [3.74–3.79] to
6.25 [6.21–6.26] ms, and warm signing from 8.21 [7.76–16.86] to
12.68 [12.57–13.10] ms. In the sign-first runs, warm signing changed from
7.80 [7.71–7.91] to 12.63 [12.59–12.76] ms. These warm values summarize each
process's warm median, with the range across those five medians; they are not
the range of every individual call. Evidence is retained in ignored
`build/perf-xiaomi-2026-10-18-lab/crypto-results-20261018T020724Z-08b19eaa/`.

The follow-up candidate uses the installed Noble curves 1.9.7 signer and
public-key derivation on Android, with its base-point window configured to 4
once per module. Both operations remain synchronous JavaScript math. The existing
signer snapshot still captures a matching seed/public-key pair before the
event transaction, and signing completes before its Promise resolves. No
new private-key native API is introduced. Key repair, SecureStore persistence,
retired-key recognition and session lifecycle retain their existing paths.
The module captures platform selection once. Non-Android builds keep the
original Noble 2.3 derive/sign functions and do not load or configure the
smaller-table helper. This prevents moving the separate Noble verification
table cost onto iOS; no iPhone performance result is claimed.

For public event and raw-signature verification, the candidate adds a lazy
Android-only synchronous single-check wrapper around the existing native
strict subset. It requires canonical standard Base64, a 64-byte signature,
a 32-byte public key and at most 16 KiB of message bytes before crossing the
bridge. Only literal native `true` is conclusive. All other results, missing
native APIs, unsupported platforms and oversized inputs retain the original
Noble verifier. Bulk/history verification retains the off-thread batch path.
The positive-result caches still hold exact mathematical checks, not roles,
membership freshness or other authority decisions.

Native eligibility additionally requires a same-realm `Uint8Array`. A
regression first demonstrated that a runtime hex string could otherwise be
coerced into different bytes by Base64 encoding. Strings, other array/view
types and foreign-realm byte arrays now take the unchanged Noble fallback;
Node Buffer byte arrays remain eligible. Raw byte inputs are normalized once
using Noble's `Uint8Array.from` semantics, and that snapshot feeds both paths.
Twelve additional host comparisons cover altered, throwing and stateful
iterators plus shadowed lengths with positive/native-fallback results. In Node,
each original iterator runs once. Arbitrary JavaScript proxies or globally modified
runtime built-ins are not a claimed security boundary.

All 83 package selftest scripts passed in a fresh run after the
iterator-snapshot fix, then again after the Android-only platform guard
(`selftests-platform-final/summary.json`). An earlier run had
stopped only on a Windows CRLF-versus-LF fixture-text comparison. Normalizing
checkout line endings in that check retains exact generated fixture content;
its targeted rerun and the final full run both passed all 17 wrapper tests and
verified the 292-fixture Noble subset corpus. Mobile TypeScript checking passed.
The native release unit-test run
passed 14 tests with zero failures or errors. Signing validation passed 743
old/new comparisons, including independent RFC 8032 known answers, canonical
events, Unicode, byte views, rare scalar/hash edges and input immutability.
Device-key regressions passed all 20 Android lifecycle cases, including captured
signers across cache clears, plus three platform-selection regressions. The
iOS/web tests prove the smaller-table helper is never required, original Noble
math is used, and captured selection/signers survive later platform mutation
and cache clears. The runtime-input regression failed before the guard and passed
afterward; the fresh V2 bundle includes that guard.

V2 completed all 23 runs: 20 interleaved fresh-process timing runs and three
canonical integrations. Wrapper-call cold medians were 9.00 ms for the 22-byte
fixture and 18.37 ms for 16 KiB, versus Noble control medians of 373.91 ms and
393.33 ms. Native timings include module loading, message Base64 conversion,
wrapper preflight, first native resolution, Expo conversion and native math.
This microbenchmark did not call the complete production raw-verification API.
Its evidence is in ignored `v2-results-20261018T023150Z-4c0a5bc4/`.

Each integration used the real SQLite/init/key/customer/tally/projection paths,
committed exactly two events and one tally, checked persisted final-HLC
signatures and deterministic signing, rejected tampering, and proved an
injected projection failure rolled back event/tally/HLC state and closed the
transaction. Foreign-key and byte-domain checks passed. The first run created
the anonymous synthetic fixture; subsequent runs reused it. These integrations
preceded the final iterator-snapshot guard; that guard's device regression is
included in the next test build. Stage 11 intentionally triggers Noble fallback,
so its cold-table cost is not a healthy-save measurement.

## Matched complete verification API

V2b called the actual candidate `verifyRawSignature` API and an exact read-only
copy of that API from release commit `e6976b7`. Both received identical message
bytes and signature/public-key Base64 strings. First module loading and the
API's own decode/snapshot/native conversion costs were timed. The 20 rotated
fresh-process timing runs all passed (five runs per mode).

| Process-cold input | Code 64 API, median [min–max] ms | Candidate API, median [min–max] ms |
| --- | --- | --- |
| 22 bytes | 374.72 [371.39–377.71] | 9.84 [9.32–10.44] |
| 16 KiB | 416.24 [415.49–419.61] | 19.32 [18.95–20.59] |

For small-first runs, the median of each process's warm small-message median
was 32.89 ms in the control and 3.70 ms in the candidate. The corresponding
large-message values were 79.95 and 11.98 ms. These are isolated API timings,
not total launch-time savings, and must not be added to the separate key-setup
measurements. Evidence: `v2b-results-20261018T024907Z-ae8dd3ce/`.

The first V2b integration stopped at an additional test which assumed Node's
custom-iterator behavior. No timing run failed. In this Hermes build,
`Uint8Array.from` ignores those custom iterators; the exact original API and
the candidate therefore needed comparison on the phone itself. The corrected
harness uses nine independent old/current input pairs and compares return
values, thrown errors, result types and iterator counts. All nine matched in
each of three fresh-process integrations; all 12 required checks, canonical
saves, final-HLC signatures, readback, injected rollback and foreign keys
passed. Both APIs invoked the custom iterators zero times on Hermes, while the
Node regressions prove matching one-call behavior there. App verification code
was unchanged during this harness correction. Original failure evidence was
retained, not overwritten; the separate successful evidence is in
`v2b-canonical-results-20261018T030031Z-4f65c5a1/`.

## Complete app with 200 synthetic tallies

The final test APK runs the actual production entry, route tree, Home and
startup workers in the separate offline benchmark package. Its four changed
application sources match the current repository in the generated source map.
The native signature/API, release Hermes, package/config, offline permission
and guarded entry checks passed. APK SHA-256:
`7a89059522ee33b24fc2f95bc3100c952d7c7ada420452efd16ba695a75ddcce`;
JavaScript SHA-256:
`6fa9e630843d9429a2c5d4867483375263e6f649e90a783ea90bdce65227b323`.

The guarded public-API fixture expansion produced exactly 12 customers and
200 tallies, with six customers on each balance side. It added 193 tallies in
10.93 seconds; repeating setup added zero customers/tallies. It never edited
the real app's ledger. Evidence: `seed-ui-results.json`.

Home was fully populated in the screenshot initiated 2.5 seconds after the
cold launch; capture/pull finished at 2.958 seconds. This is a host-timed
observation, not a measured input-to-photon startup latency.

The 115-second full-UI trace separated twelve cold swipes, twelve warm swipes
and late idle time:

| Window | JS running time | Average fraction of one core |
| --- | --- | --- |
| Startup, 0–5 s | 823.83 ms | 16.48% |
| Cold swipes, 5–24 s | 435.85 ms | 2.29% |
| Warm swipes, 61–80 s | 588.40 ms | 3.10% |
| Late idle, 81–113 s | 64.09 ms | 0.20% |

Cold and warm windows each contained 342 app FrameTimeline frames, consistent
with the native graphics totals. Android counted one cold missed frame deadline
(0.29%) and two warm misses (0.58%); native p99 frame durations were 15 ms and
17 ms. The per-swipe app-frame cadence had median intervals near 20.05 ms and
occasional 40–60.34 ms gaps. These are automated-gesture measurements on this
display cadence, not universal FPS or human touch-latency guarantees.

Late idle recorded zero app frames and main-thread CPU of 4.26% of one core;
the framework callback behavior identified in the release baseline remains.
No framework patch was made. This anonymous offline workload differs from the
signed-in release test, so its CPU/launch results are not a like-for-like
speedup comparison with code 64.

The local trace is 263,230,421 bytes. Full sorting still reported two negative
timestamp drops and six service-discarded chunks. All returned data-loss and
queried overrun/overwrite counters were zero; that does not locate or establish
the harmlessness of the discarded chunks. Perfetto distinguishes service-level
discarded chunks from buffer-overwrite statistics in its
[TraceStats definition](https://github.com/google/perfetto/blob/main/protos/perfetto/common/trace_stats.proto).
The limitation is retained alongside the timings. Detailed evidence and query
coverage are in `full-ui-v3/analysis/`.

The separate stress process (PID 14201) passed 100 rapid horizontal swipes,
ten list scroll gestures, twenty search/customer/back cycles and twenty
vertical swipes through a customer's scrollable tally history without a crash
or process restart. The navigation driver was corrected to clear the retained
query before each cycle; the original failed automation assertion remains in
the local evidence. Application source was unchanged during that correction.
The history's scrolled bottom was also visually inspected. Evidence:
`full-ui-v3/stress-events.json`, `navigation-events.json` and
`detail-scroll-result.json`.

Code commits: `af131f1` (unchanged policy refreshes) and `d49bdd9` (Android key
setup/public verification). The warm-signing trade-off remains documented;
these follow-up changes are not part of the published 2.2.2 artifact. No further
store release was submitted.
