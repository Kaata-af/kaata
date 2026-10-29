// OS accessibility only: this strict boundary rejects any database, saved-mode
// or hardware dependency in the shared motion service.
import assert from "node:assert/strict";
import { compileUI, deferred, settleUI } from "./ui-fixture";

type Motion = typeof import("../reduced-motion");

function fixture(initial: Promise<unknown> = Promise.resolve(false)) {
  let subscribe!: (listener: () => void) => () => void;
  let read = initial;
  let reads = 0;
  let registrations = 0;
  let removals = 0;
  let notifications = 0;
  const active = new Set<(value: any) => void>();
  const callbacks: ((value: any) => void)[] = [];
  const api = compileUI("../reduced-motion", {
    react: {
      useSyncExternalStore: (sub: typeof subscribe, get: () => boolean, server: () => boolean) => {
        subscribe = sub;
        assert.equal(get(), server());
        return get();
      },
    },
    "react-native": {
      AccessibilityInfo: {
        isReduceMotionEnabled: () => {
          reads++;
          return read;
        },
        addEventListener: (event: string, callback: (value: boolean) => void) => {
          assert.equal(event, "reduceMotionChanged");
          assert.equal(active.size, 0, "All consumers share one native listener");
          registrations++;
          active.add(callback);
          callbacks.push(callback);
          return {
            remove: () => {
              assert.ok(active.delete(callback), "A native subscription is removed once");
              removals++;
            },
          };
        },
      },
    },
  }) as Motion;
  const first = api.useReducedMotion();
  return {
    api,
    first,
    active,
    callbacks,
    start: () => subscribe(() => notifications++),
    setRead: (value: Promise<unknown>) => {
      read = value;
    },
    emit: (value: unknown) => {
      for (const callback of [...active]) callback(value);
    },
    get reads() {
      return reads;
    },
    get registrations() {
      return registrations;
    },
    get removals() {
      return removals;
    },
    get notifications() {
      return notifications;
    },
  };
}

async function main() {
  const normal = fixture();
  assert.equal(normal.first, false, "Normal app animations are the default");
  assert.equal(normal.api.getReducedMotion(), false);
  assert.equal(normal.reads, 0, "Cached reads perform no native or storage IO");
  const stopFirst = normal.start();
  const stopSecond = normal.start();
  await settleUI();
  assert.equal(normal.reads, 1);
  assert.equal(normal.registrations, 1);
  assert.equal(normal.notifications, 0, "An unchanged system result causes no render");
  normal.emit(true);
  assert.equal(normal.api.getReducedMotion(), true);
  assert.equal(normal.api.useReducedMotion(), true);
  assert.equal(normal.notifications, 2);
  normal.emit(true);
  normal.emit("true");
  assert.equal(normal.notifications, 2, "Duplicate and invalid events leave the snapshot stable");
  normal.emit(false);
  assert.equal(normal.api.getReducedMotion(), false);
  assert.equal(normal.notifications, 4);
  stopFirst();
  assert.equal(normal.active.size, 1);
  stopFirst();
  assert.equal(normal.removals, 0, "Repeated cleanup cannot remove another consumer's listener");
  stopSecond();
  stopSecond();
  assert.equal(normal.active.size, 0);
  assert.equal(normal.removals, 1);

  const initiallyReduced = fixture(Promise.resolve(true));
  const stopReduced = initiallyReduced.start();
  await settleUI();
  assert.equal(
    initiallyReduced.api.getReducedMotion(),
    true,
    "The OS accessibility choice applies",
  );
  stopReduced();
  assert.equal(
    initiallyReduced.api.getReducedMotion(),
    true,
    "Imperative readers retain cached OS state",
  );
  initiallyReduced.callbacks[0](false);
  assert.equal(
    initiallyReduced.api.getReducedMotion(),
    true,
    "Unmounted events cannot change state",
  );
  initiallyReduced.setRead(Promise.resolve(false));
  const stopRemount = initiallyReduced.start();
  await settleUI();
  assert.equal(initiallyReduced.reads, 2, "Remount refreshes changes made without subscribers");
  assert.equal(initiallyReduced.api.getReducedMotion(), false);
  stopRemount();

  const late = deferred<boolean>();
  const eventWins = fixture(late.promise);
  const stopEventWins = eventWins.start();
  await settleUI();
  eventWins.emit(true);
  late.resolve(false);
  await settleUI();
  assert.equal(eventWins.api.getReducedMotion(), true, "A late read cannot undo a newer OS event");
  stopEventWins();

  const pending = deferred<boolean>();
  const retired = fixture(pending.promise);
  const stopOld = retired.start();
  await settleUI();
  stopOld();
  retired.setRead(Promise.resolve(false));
  const stopNew = retired.start();
  await settleUI();
  pending.resolve(true);
  retired.callbacks[0](true);
  await settleUI();
  assert.equal(
    retired.api.getReducedMotion(),
    false,
    "Old reads/events cannot affect a remounted store",
  );
  stopNew();

  const failedRead = deferred<boolean>();
  const unavailable = fixture(failedRead.promise);
  const stopUnavailable = unavailable.start();
  failedRead.reject(new Error("Native preference unavailable"));
  await settleUI();
  assert.equal(
    unavailable.api.getReducedMotion(),
    false,
    "Unavailable OS data keeps default animations",
  );
  unavailable.emit(true);
  assert.equal(
    unavailable.api.getReducedMotion(),
    true,
    "Events recover after a failed native read",
  );
  stopUnavailable();
  unavailable.setRead(Promise.resolve(undefined));
  const stopInvalid = unavailable.start();
  await settleUI();
  assert.equal(
    unavailable.api.getReducedMotion(),
    true,
    "Invalid responses preserve cached accessibility state",
  );
  stopInvalid();

  const shortMount = fixture();
  shortMount.start()();
  await settleUI();
  assert.equal(shortMount.reads, 0, "A retired mount cannot start unnecessary native work");
  assert.equal(shortMount.removals, 1);

  console.log(
    "PASS system reduced motion: normal animations by default, no storage/hardware dependencies, shared live accessibility subscription, cached imperative reads, remount refresh, event/read races and cleanup",
  );
}

void main();
