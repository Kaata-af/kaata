# Why background sync works in Briar and not (yet) in kaata

Status: **findings + recommendations** · Researched 2026-06-17 against Briar's
real source (GitLab `briar/briar` + `briar/dont-kill-me-lib`, branch `master`)
and kaata's `apps/mobile` source.

## TL;DR

> **Briar's sync engine _is_ the background service — plain JVM threads living in
> the same always-on process the foreground notification protects. Kaata's sync
> engine is JavaScript owned by the app's UI; when you swipe the app away, the JS
> world dies, and the native service that survives has no sync code to run.**

So two things are actually broken, at two different layers:

1. **The notification vanishes on swipe** because our foreground service is a
   _faithful but incomplete_ port of Briar's — it's missing the tricks that keep
   the process resident (renewable wake lock, OEM tag-spoofing, an alarm
   backstop). On a cooperative OEM (your Galaxy A17) Briar's process stays alive;
   ours gets reaped.
2. **Even if it survived, nothing would sync**, because the sync loop is JS tied
   to the Activity. After a swipe we can only cold-start a throwaway JS context
   every ~90s (`HeadlessJsTaskService`) — and I disabled even that on your
   Xiaomi.

Briar needs none of this gymnastics: its Bluetooth accept-loop and sync sessions
are pure-Java `Runnable`s on a thread pool, started by the service and alive
exactly as long as the service is.

## How Briar actually does it (from its source)

Briar is **one process**, not multi-process. Survival is a stack of mechanisms:

| Mechanism                             | What Briar does                                                                                                                                                                                                                                                                                                                                                                           | Source                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Foreground service**                | `BriarService` calls `startForeground()` in `onCreate` with an ongoing `IMPORTANCE_LOW` notification, type `connectedDevice` (not `dataSync` — avoids Android 14's ~6h/day cap). A process hosting an FGS is user-visible: exempt from background limits, last to be reaped.                                                                                                              | `briar-android/.../BriarService.java`                                                                                         |
| **Sync runs in-process, in pure JVM** | `onCreate` → `lifecycleManager.startServices(dbKey)` → `PluginManager` starts each transport on a wake-locked JVM thread pool. `AndroidBluetoothPlugin` runs `while(true){ acceptConnection() }` on the `IoExecutor`; each connection is handed to a `DuplexOutgoingSession` — all `java.util.concurrent`, **no UI, no second runtime, no bridge.** Lives exactly as long as the service. | `bramble-android/.../AndroidBluetoothPlugin.java`, `bramble-core/.../DuplexOutgoingSession.java`, `LifecycleManagerImpl.java` |
| **Renewable wake lock**               | Not one long-held lock — a `PARTIAL_WAKE_LOCK` acquired with a 1-min timeout + 30s margin, **swapped for a fresh one every 60s** (acquire-new-then-release-old, zero gap). OEM "wake lock held too long" killers (Huawei PowerGenie) never see a long-held lock to kill.                                                                                                                  | `dont-kill-me-lib/.../RenewableWakeLock.java`, `AndroidWakeLockManagerImpl.java`                                              |
| **OEM wake-lock-tag spoofing**        | The lock's _tag_ is disguised as a system service the OEM killer whitelists: `"LocationManagerService"` if Huawei PowerGenie is installed, `"AudioIn"` for Evenwell/Asus, else the package name. It literally masquerades as a system service.                                                                                                                                            | `AndroidWakeLockManagerImpl.getWakeLockTag()`                                                                                 |
| **Doze-proof alarm backstop**         | A self-rescheduling `setAndAllowWhileIdle(ELAPSED_REALTIME_WAKEUP, 15min)` alarm that re-arms itself on every fire and carries the PID (ignores alarms from a dead process). Guarantees a wake at least every ~15 min even in deep Doze — and can bring the stack back after a kill.                                                                                                      | `bramble-android/.../AndroidTaskScheduler.java`, `AlarmReceiver.java`                                                         |
| **Guided OEM settings**               | In-app flows to the Doze battery-optimization whitelist _and_ the Xiaomi/MIUI Security-Center "Lock apps"/autostart screens (version-detected). Briar concedes code alone can't win on MIUI — it coaches the user.                                                                                                                                                                        | `dont-kill-me-lib/.../DozeUtils.kt`, `XiaomiUtils.kt`                                                                         |
| **Return code**                       | `START_NOT_STICKY` — Briar _doesn't_ rely on auto-restart. Liveness comes from the FGS+wakelock+alarm making the process expensive to kill and quick to wake, not from respawning.                                                                                                                                                                                                        | `BriarService.java`                                                                                                           |

The load-bearing insight: **all of Briar's reliability tricks protect a process
whose worker is already inside it.** The wake lock keeps the _sync threads_
warm. There's nothing to "revive."

## What kaata does (from our source)

We ported the _shape_ of Briar's service but the engine lives elsewhere:

| Mechanism              | What kaata does                                                                                                                                                                                                                                                                | Source                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Foreground service** | `KaataForegroundService` — native `START_STICKY`, `connectedDevice`, `stopWithTask=false`, notification persisted to SharedPrefs so a sticky restart can re-post it without JS. Good, and genuinely Briar-shaped.                                                              | `KaataForegroundService.kt:174-309`, `withKaataForegroundService.js`                                     |
| **Wake lock**          | One `PARTIAL_WAKE_LOCK` (`"kaata:mesh-fgs"`) held for the whole lifetime. **No rotation, no OEM tag-spoofing** → more exposed to Huawei/Asus tag killers.                                                                                                                      | `KaataForegroundService.kt:92-115`                                                                       |
| **Sync locus**         | **JavaScript.** Handshake, anti-entropy, the dial loop are all TS. The dial loop is a JS `setInterval` (`btc-steady.ts`) driven by the `MeshController` React **component**. The FGS holds a wakelock that keeps the JS VM _unfrozen_ — but the FGS does **not** run the mesh. | `anti-entropy.ts`, `btc-steady.ts:391`, `MeshController.tsx`                                             |
| **After swipe-kill**   | JS VM dies with the Activity. A 90s `Handler` tick in the FGS cold-spawns a **brand-new** headless JS context (`KaataMeshHeadlessService` → `HeadlessJsTaskService`) that runs a bounded ~30–60s catch-up, then spins down.                                                    | `KaataForegroundService.kt:117-170`, `KaataMeshHeadlessService.kt`, `headless-entry.ts`, `bg-catchup.ts` |
| **Alarm backstop**     | **None.** The 90s tick is an in-process `Handler` that dies with the process; only `START_STICKY` brings the FGS back, and on Android 12+ restarting an FGS from the background is _blocked_ (`if (!entered) stopSelf()`), so a real process kill = silence until reopen.      | `KaataForegroundService.kt:198-208`                                                                      |
| **OEM handling**       | `isHostileOem()` returns true for **xiaomi/redmi/poco and skips the headless path entirely** (MIUI 5s-crashed it once). No guided OEM-settings flow.                                                                                                                           | `KaataForegroundService.kt:148-170`                                                                      |

## So why does the notification die on the Samsung A17?

The A17 is a cooperative OEM — a correct FGS should survive a swipe there. Ours
doesn't, which means the FGS isn't keeping the process resident the way Briar's
does. The contributing causes, in order of likelihood:

1. **No renewable wake lock + no system-tag spoof.** Our single long-held lock
   is exactly what aggressive power managers flag and drop; once the lock is
   dropped the process loses its "keep me alive" anchor and becomes reapable on
   swipe. Briar's rotated, system-tagged lock stays effective.
2. **RN's heavier process is a fatter target.** A React Native process (JS VM +
   native + RN bridge) is far larger than Briar's lean JVM; under the same
   pressure the OS reaps it sooner.
3. **No alarm backstop.** Once the process _is_ gone, Briar's `setAndAllowWhileIdle`
   alarm wakes it back within ~15 min; we have nothing — `START_STICKY`'s restart
   is blocked by the Android-12+ background-FGS-start rule, so the service stays
   down and the notification never comes back until you reopen the app.

(Confirming the exact reaper on each device needs `logcat` during a swipe; the
_direction_ — our residency stack is strictly weaker than Briar's — is certain
from the source.)

## The honest ceiling

- On **MIUI/Huawei**, app-killing is undocumented OEM policy with "no APIs and no
  documentation" (dontkillmyapp.com). Even a flawless native FGS + renewable
  wakelock is overridable. The real fix is the **user** enabling Autostart /
  "No restrictions" / Lock-in-recents — which no code can grant. Briar ships
  guided flows for exactly this and _still_ tells MIUI users to flip those
  switches.
- Even **Briar accepts it can be killed** (`START_NOT_STICKY`). Its reliability
  is "expensive to kill, quick to wake," not "unkillable."
- As long as our sync is in **JS**, we're one process-death away from total
  silence until reopen — the headless path is bounded and best-effort _by
  construction_ (RN: "spin up, run the task, spin down").

A realistic target for kaata: **Briar-class on cooperative OEMs (Samsung/Pixel)
once the engine is native; best-effort bounded windows on hostile OEMs** — not
parity everywhere.

## Recommendations (priority order)

### A. Native quick-wins — port the three missing Briar primitives (~days)

Cheapest, highest leverage; our FGS already credits Briar, so it's filling gaps:

1. **Renewable wake lock** — rotate a fresh `PARTIAL_WAKE_LOCK` every ~60s with
   overlap, instead of one long-held lock.
2. **OEM tag-spoofing** — `"LocationManagerService"` on Huawei PowerGenie,
   `"AudioIn"` on Evenwell, else package name.
3. **Self-rescheduling `setAndAllowWhileIdle` alarm** (~15 min, PID-tagged) as a
   Doze-proof backstop that re-spawns the FGS even after a full process kill.

These should fix "notification dies on the A17" and make the resident-process
window much longer on all OEMs. They do **not** make sync run after a swipe on
their own — that's (B)/(C).

### B. The structural fix — move the sync engine into native/JVM (weeks)

The only thing that truly matches Briar: run the mesh loop (dial, handshake,
anti-entropy, DB-merge) in the **resident FGS process with no JS VM**. The
BT-Classic transport is already native; the remaining work is porting the
TS mesh/CRDT/DB-merge logic to Kotlin (or a shared C++/Rust core via JSI). Big,
but it's the difference between "works" and "best-effort."

### C. The middle path — one warm headless context (days–week)

Instead of cold-spawning a fresh headless JS window every 90s, keep **one**
long-lived headless `ReactContext` alive under the FGS+wakelock for the whole
background session. Far cheaper than (B), but still pays RN's memory/stability
tax on low-end devices (it's why the crash-breaker exists), and is still JS.

### D. Guided OEM settings + reconsider the Xiaomi block (days)

Add Briar-style in-app prompts to the Doze whitelist and MIUI "Lock apps" screen.
With (A)'s alarm backstop + renewable lock in place, re-test lifting
`isHostileOem` on Xiaomi behind the crash-breaker.

## Strategic note (not just engineering)

Reliable killed-app P2P sync on Chinese OEMs is the single hardest problem in
this space — Briar spent years and a dedicated library (`dont-kill-me-lib`) on it,
and _still_ leans on user settings. Before pouring weeks into (B), weigh it
against the **server-backed shared ledger** (`docs/shared-ledger-spec.md`): for a
two-party tab that both sides want synced, a server sidesteps the entire
background-execution problem — the data is there whether either app is open or
not. Background BT sync is the right tool for _multi-device one-shop_ offline use;
the server is the right tool for _two-party always-agree_. They're different jobs.

Suggested sequencing: **(A) now** (it's cheap and fixes the visible "notification
dies" bug + extends residency on Samsung/Pixel), then decide (B) vs leaning on
the web shared-ledger based on which use case you're actually prioritizing.

## Sources

- Briar: `code.briarproject.org/briar/briar` (`briar-android/.../BriarService.java`,
  `bramble-android/.../AndroidBluetoothPlugin.java`,
  `bramble-android/.../system/AndroidTaskScheduler.java`,
  `bramble-core/.../lifecycle/LifecycleManagerImpl.java`,
  `bramble-core/.../sync/DuplexOutgoingSession.java`).
- Briar OEM survival: `code.briarproject.org/briar/dont-kill-me-lib`
  (`wakelock/RenewableWakeLock.java`, `wakelock/AndroidWakeLockManagerImpl.java`,
  `DozeUtils.kt`, `XiaomiUtils.kt`); `dontkillmyapp.com`.
- RN: `reactnative.dev/docs/headless-js-android`.
- kaata: `apps/mobile/modules/kaata-bt-classic/android/.../KaataForegroundService.kt`,
  `.../KaataMeshHeadlessService.kt`, `.../KaataBgMeshGate.kt`,
  `apps/mobile/lib/mesh/{btc-steady,anti-entropy,bg-catchup,bg-task}.ts`,
  `apps/mobile/components/MeshController.tsx`.
