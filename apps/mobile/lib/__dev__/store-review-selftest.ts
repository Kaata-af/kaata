import assert from "node:assert/strict";
import type { StoreReviewContext, StoreReviewDependencies } from "../store-review";
import { compileUI, deferred } from "./ui-fixture";

const { createStoreReviewService } = compileUI("../store-review", {
  expo: { isRunningInExpoGo: () => false },
  "expo-application": { applicationId: "af.kaata.app", nativeApplicationVersion: "2.3.0" },
  "react-native": { Platform: { OS: "android" } },
  "./db": { getAppMeta: async () => null, setAppMeta: async () => {} },
  "./db-tx": {
    getInstallIdSync: () => "install",
    getAccountIdSync: () => "account",
    getActiveVaultIdSyncMaybe: () => "vault",
  },
  "./install-id": { getInstalledAtUnixMs: async () => 1 },
}) as typeof import("../store-review");

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1, 10);
type Phase = "read" | "write" | "installed" | "native" | "available";
function fixture() {
  let now = START;
  let context: StoreReviewContext = {
    installId: "install",
    accountId: "account",
    vaultId: "vault",
  };
  let supported = true;
  let version: string | null = "2.3.0";
  let installed: number | null = START - 500 * DAY;
  let available = true;
  let nativeRequests = 0;
  let availabilityChecks = 0;
  let fail: Phase | "request" | null = null;
  const metadata = new Map<string, string>();
  const writes: string[] = [];
  let paused: {
    phase: Phase;
    entered: ReturnType<typeof deferred<void>>;
    gate: ReturnType<typeof deferred<void>>;
  } | null = null;
  const phase = async (name: Phase) => {
    if (fail === name) throw new Error(`fixture ${name} failure`);
    if (paused?.phase === name) {
      const pending = paused;
      paused = null;
      pending.entered.resolve();
      await pending.gate.promise;
    }
  };
  const deps: StoreReviewDependencies = {
    now: () => now,
    currentContext: () => ({ ...context }),
    supportedEnvironment: () => supported,
    appVersion: () => version,
    installedAt: async () => {
      await phase("installed");
      return installed;
    },
    read: async (key) => {
      await phase("read");
      return metadata.get(key) ?? null;
    },
    write: async (key, value) => {
      await phase("write");
      metadata.set(key, value);
      writes.push(value);
    },
    nativeReview: async () => {
      await phase("native");
      return {
        isAvailableAsync: async () => {
          availabilityChecks++;
          await phase("available");
          return available;
        },
        requestReview: async () => {
          nativeRequests++;
          assert.ok(
            state().attempts.length > 0,
            "The attempt is durable before native review begins",
          );
          if (fail === "request") throw new Error("fixture request failure");
        },
      };
    },
  };
  const service = createStoreReviewService(deps);
  const key = () => `store_review:v1:${context.installId}`;
  const state = () => JSON.parse(metadata.get(key())!);
  const snapshot = () => ({ ...context });
  let entry = 0;
  const note = (id = `entry-${++entry}`, captured = snapshot()) =>
    service.noteReviewableTally(captured, id);
  const flush = () => service.requestReviewOpportunity(snapshot(), "flush-only", () => false);
  const opportunity = () => service.getReviewOpportunity(snapshot());
  const qualify = async () => {
    for (let i = 0; i < 4; i++) note();
    await flush();
    for (const day of [1, 2, 3, 4, 5, 7]) {
      now = START + day * DAY;
      note();
      await flush();
    }
    assert.ok(opportunity(), "Ten tallies across seven active days and a full week qualify");
  };
  return {
    service,
    metadata,
    writes,
    snapshot,
    note,
    flush,
    opportunity,
    qualify,
    state,
    get nativeRequests() {
      return nativeRequests;
    },
    get availabilityChecks() {
      return availabilityChecks;
    },
    setNow(value: number) {
      now = value;
    },
    setContext(value: Partial<StoreReviewContext>) {
      context = { ...context, ...value };
    },
    setSupported(value: boolean) {
      supported = value;
    },
    setVersion(value: string | null) {
      version = value;
    },
    setInstalled(value: number | null) {
      installed = value;
    },
    setAvailable(value: boolean) {
      available = value;
    },
    setFailure(value: typeof fail) {
      fail = value;
    },
    pause(name: Phase) {
      const pending = { phase: name, entered: deferred<void>(), gate: deferred<void>() };
      paused = pending;
      return pending;
    },
  };
}

async function main() {
  {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.note();
    await f.flush();
    assert.equal(
      f.state().tallyCount,
      100,
      "Concurrent fire-and-forget saves serialize their counters",
    );
    assert.equal(f.state().recentEntryIds.length, 32);
    assert.equal(f.state().activeDays.length, 1);
    assert.equal(f.opportunity(), null, "An old install and many first-day tallies never prompt");
    f.note("duplicate");
    f.note("duplicate");
    await f.flush();
    assert.equal(f.state().tallyCount, 101, "The same saved entry counts once");
    assert.equal(f.nativeRequests, 0);
  }
  {
    const f = fixture();
    for (let day = 0; day < 7; day++) {
      f.setNow(START + day * DAY);
      f.note();
      f.note();
      await f.flush();
    }
    assert.equal(f.state().activeDays.length, 7);
    assert.equal(f.opportunity(), null, "Seven calendar buckets do not replace seven elapsed days");
    f.setNow(START + 7 * DAY);
    f.note();
    await f.flush();
    assert.ok(f.opportunity());
  }
  {
    const f = fixture();
    f.setInstalled(null);
    await f.qualify();
    let notifications = 0;
    const unsubscribe = f.service.subscribeReviewOpportunities(() => notifications++);
    const id = f.opportunity()!;
    const first = f.service.requestReviewOpportunity(f.snapshot(), id, () => true);
    const second = f.service.requestReviewOpportunity(f.snapshot(), id, () => true);
    assert.equal(first, second, "Concurrent prompt requests coalesce");
    await Promise.all([first, second]);
    assert.equal(f.nativeRequests, 1);
    assert.equal(f.state().attempts.length, 1);
    assert.equal(f.opportunity(), null);
    f.setNow(START + 100 * DAY);
    f.note();
    await f.flush();
    assert.equal(f.opportunity(), null, "The same marketing version is never requested twice");
    f.setVersion("2.3.1");
    f.note();
    await f.flush();
    assert.ok(f.opportunity());
    assert.equal(notifications, 1);
    unsubscribe();
    f.service.dismissReviewOpportunity(f.opportunity()!);
    f.note();
    await f.flush();
    assert.equal(notifications, 1, "Unsubscribed listeners stay silent");
  }
  {
    const f = fixture();
    await f.qualify();
    f.setAvailable(false);
    await f.service.requestReviewOpportunity(f.snapshot(), f.opportunity()!, () => true);
    assert.equal(f.nativeRequests, 0);
    assert.equal(f.state().attempts.length, 0);
    assert.equal(
      f.opportunity(),
      null,
      "Unavailable stores consume no attempt and discard this opportunity",
    );
  }
  {
    const f = fixture();
    await f.qualify();
    f.setFailure("request");
    await assert.doesNotReject(
      f.service.requestReviewOpportunity(f.snapshot(), f.opportunity()!, () => true),
    );
    assert.equal(
      f.state().attempts.length,
      1,
      "A native failure cannot cause repeated immediate requests",
    );
    f.setFailure(null);
    f.setVersion("2.3.1");
    f.setNow(START + 96 * DAY);
    f.note();
    await f.flush();
    assert.equal(f.opportunity(), null, "Ninety days since the attempt are required");
    f.setNow(START + 97 * DAY);
    f.note();
    await f.flush();
    assert.ok(f.opportunity());
  }
  {
    const f = fixture();
    await f.qualify();
    for (const [day, version] of [
      [7, "2.3.0"],
      [97, "2.3.1"],
      [187, "2.3.2"],
    ] as const) {
      f.setNow(START + day * DAY);
      f.setVersion(version);
      f.note();
      await f.flush();
      await f.service.requestReviewOpportunity(f.snapshot(), f.opportunity()!, () => true);
    }
    f.setNow(START + 277 * DAY);
    f.setVersion("2.3.3");
    f.note();
    await f.flush();
    assert.equal(f.opportunity(), null, "At most three requests are made in a rolling year");
    for (const day of [366, 367, 368, 369, 370, 371, 372]) {
      f.setNow(START + day * DAY);
      f.note();
      await f.flush();
    }
    assert.ok(f.opportunity());
    f.setNow(START);
    assert.equal(f.opportunity(), null, "Clock rollback invalidates pending opportunities");
  }
  {
    const f = fixture();
    await f.qualify();
    f.setContext({ accountId: "another-account" });
    f.note();
    await f.flush();
    assert.equal(
      f.opportunity(),
      null,
      "A new account cannot use another person's week on this phone",
    );
    assert.equal(f.state().tallyCount, 1);
    assert.equal(f.state().activeDays.length, 1);
    assert.equal(f.state().firstObservedAt, START + 7 * DAY);
    f.setContext({ vaultId: "another-vault" });
    f.note();
    await f.flush();
    assert.equal(f.state().tallyCount, 2, "The same account retains activity across its Kaatas");
  }
  {
    const f = fixture();
    await f.qualify();
    await f.service.requestReviewOpportunity(f.snapshot(), f.opportunity()!, () => true);
    f.setContext({ accountId: null });
    f.note();
    await f.flush();
    assert.equal(f.state().tallyCount, 1);
    assert.equal(
      f.state().attempts.length,
      1,
      "An account change retains install-wide request limits",
    );
  }
  for (const bad of [
    "garbage",
    "null",
    "{}",
    JSON.stringify({ schema: 1, installId: "another" }),
  ]) {
    const f = fixture();
    f.metadata.set("store_review:v1:install", bad);
    await f.qualify().catch(() => {});
    assert.equal(f.opportunity(), null, "Damaged state does not erase a previous cooldown");
    assert.equal(f.state().quietUntil, START + 90 * DAY);
  }
  for (const phase of ["read", "write", "installed"] as const) {
    const f = fixture();
    f.setFailure(phase);
    f.note();
    await assert.doesNotReject(f.flush());
    assert.equal(f.opportunity(), null);
    assert.equal(f.nativeRequests, 0);
  }
  for (const changed of [{ accountId: "other-account" }, { vaultId: "other-vault" }]) {
    const f = fixture();
    await f.qualify();
    const original = f.snapshot();
    const oldId = f.opportunity()!;
    f.setContext(changed);
    assert.equal(f.service.getReviewOpportunity(original), null);
    f.setContext(original);
    assert.equal(f.opportunity(), null, "A context ABA cannot revive the discarded prompt");
    await f.service.requestReviewOpportunity(original, oldId, () => true);
    assert.equal(f.nativeRequests, 0);
  }
  {
    const f = fixture();
    await f.qualify();
    f.service.dismissReviewOpportunity(f.opportunity()!);
    const pending = f.pause("read");
    f.note();
    await pending.entered.promise;
    f.setNow(START + 8 * DAY);
    pending.gate.resolve();
    await f.flush();
    assert.equal(
      f.opportunity(),
      null,
      "A delayed counter write cannot turn an old action into a fresh prompt",
    );
  }
  for (const phase of ["read", "write", "installed", "native", "available"] as const) {
    const f = fixture();
    await f.qualify();
    const pending = f.pause(phase);
    const request = f.service.requestReviewOpportunity(f.snapshot(), f.opportunity()!, () => true);
    await pending.entered.promise;
    f.setContext({ installId: "new-install", accountId: "new-account", vaultId: "new-vault" });
    pending.gate.resolve();
    await request;
    assert.equal(
      f.nativeRequests,
      0,
      `A changed identity after ${phase} prevents the native request`,
    );
    assert.equal(
      f.metadata.has("store_review:v1:new-install"),
      false,
      "Stale writes cannot overwrite new-install state",
    );
  }
  {
    const f = fixture();
    await f.qualify();
    let ready = true;
    const pending = f.pause("available");
    const request = f.service.requestReviewOpportunity(f.snapshot(), f.opportunity()!, () => ready);
    await pending.entered.promise;
    ready = false;
    pending.gate.resolve();
    await request;
    assert.equal(f.nativeRequests, 0);
    assert.equal(f.state().attempts.length, 0);
  }
  {
    const f = fixture();
    await f.qualify();
    const id = f.opportunity()!;
    f.setNow(START + 7 * DAY + 10 * 60 * 1000 + 1);
    assert.equal(
      f.opportunity(),
      null,
      "Opportunities expire rather than showing on a later launch",
    );
    await f.service.requestReviewOpportunity(f.snapshot(), id, () => true);
    assert.equal(f.nativeRequests, 0);
    f.setSupported(false);
    f.note();
    await f.flush();
    assert.equal(f.state().tallyCount, 10);
  }
  for (const badVersion of [null, "", "unknown", "0", "build-55"]) {
    const f = fixture();
    f.setVersion(badVersion);
    await f.qualify().catch(() => {});
    assert.equal(f.opportunity(), null);
    assert.equal(f.nativeRequests, 0);
  }
  console.log(
    "PASS native rating opportunities: a week of active tally use, durable bounded usage, version/cooldown/year limits, native availability, no rating-result claims, serialized requests and stale-context/failure guards",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
