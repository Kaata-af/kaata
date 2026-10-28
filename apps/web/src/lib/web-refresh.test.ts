import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebRefresh } from "./web-refresh";

async function microtasks() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function fixture(refresh: () => Promise<void> = async () => {}) {
  let now = 0;
  let nextID = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const starts: number[] = [];
  const queue = createWebRefresh({
    refresh: () => {
      starts.push(now);
      return refresh();
    },
    dependencies: {
      now: () => now,
      setTimer: (callback, delay) => {
        const id = ++nextID;
        timers.set(id, { at: now + delay, callback });
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    },
  });
  async function advance(ms: number) {
    const end = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
      await microtasks();
    }
    now = end;
    await microtasks();
  }
  return { ...queue, starts, advance, timers };
}

test("automatic refresh coalesces bursts and leaves eight seconds between read starts", async () => {
  const f = fixture();
  f.request();
  await f.advance(100);
  f.request();
  await f.advance(149);
  assert.deepEqual(f.starts, []);
  await f.advance(1);
  assert.deepEqual(f.starts, [250]);
  f.request();
  f.request();
  assert.equal(f.timers.size, 1);
  await f.advance(7_999);
  assert.deepEqual(f.starts, [250]);
  await f.advance(1);
  assert.deepEqual(f.starts, [250, 8_250]);
  await f.advance(20_000);
  assert.equal(f.starts.length, 2, "no unsolicited polling or retries");
  f.request();
  await f.advance(250);
  assert.deepEqual(f.starts, [250, 8_250, 28_500]);
});

test("hints arriving during a slow read retain one trailing refresh without overlap", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const f = fixture(() => (++calls === 1 ? gate : Promise.resolve()));
  f.request();
  await f.advance(250);
  f.request();
  await f.advance(9_000);
  f.request();
  f.request();
  assert.deepEqual(f.starts, [250]);
  assert.equal(f.timers.size, 0, "wait for the running read instead of spinning timers");
  finish();
  await microtasks();
  await f.advance(0);
  assert.deepEqual(f.starts, [250, 9_250]);
  assert.equal(f.timers.size, 0);
});

test("continuous hints cannot postpone a scheduled refresh indefinitely", async () => {
  const f = fixture();
  for (let i = 0; i < 200; i++) {
    f.request();
    await f.advance(100);
  }
  assert.deepEqual(f.starts, [250, 8_250, 16_250]);
  assert.equal(f.timers.size, 1, "the tail remains queued, with one timer only");
  f.stop();
  await f.advance(10_000);
  assert.equal(f.starts.length, 3);
});

test("a failed refresh does not loop but a later hint can retry", async () => {
  const f = fixture(async () => {
    throw new Error("offline");
  });
  f.request();
  await f.advance(20_000);
  assert.deepEqual(f.starts, [250]);
  assert.equal(f.timers.size, 0);
  f.request();
  await f.advance(250);
  assert.deepEqual(f.starts, [250, 20_250]);
});

test("stop cancels a queued refresh and ignores future requests", async () => {
  const f = fixture();
  f.request();
  f.stop();
  f.stop();
  f.request();
  await f.advance(20_000);
  assert.deepEqual(f.starts, []);
  assert.equal(f.timers.size, 0);
});

test("stop during a read prevents dirty follow-ups after that read finishes", async () => {
  let finish!: () => void;
  const f = fixture(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  f.request();
  await f.advance(250);
  f.request();
  f.stop();
  finish();
  await microtasks();
  f.request();
  await f.advance(20_000);
  assert.deepEqual(f.starts, [250]);
  assert.equal(f.timers.size, 0);
});

test("Retry-After postpones queued work without losing hints or shortening an existing cooldown", async () => {
  const f = fixture();
  f.request();
  await f.advance(100);
  f.deferFor(30_000);
  await f.advance(10_000);
  f.request();
  f.deferFor(1_000);
  f.deferFor(NaN);
  f.deferFor(-1);
  assert.equal(f.timers.size, 1);
  await f.advance(19_999);
  assert.deepEqual(f.starts, []);
  await f.advance(1);
  assert.deepEqual(f.starts, [30_100]);
  f.request();
  await f.advance(8_000);
  assert.deepEqual(f.starts, [30_100, 38_100], "ordinary pacing resumes after the cooldown");
});

test("cooldown during an in-flight read holds its dirty follow-up and never creates a retry alone", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const f = fixture(() => (++calls === 1 ? gate : Promise.resolve()));
  f.deferFor(1_000);
  await f.advance(2_000);
  assert.deepEqual(f.starts, [], "a cooldown without a request must not fetch");
  f.request();
  await f.advance(250);
  f.request();
  f.deferFor(30_000);
  finish();
  await microtasks();
  await f.advance(29_999);
  assert.deepEqual(f.starts, [2_250]);
  await f.advance(1);
  assert.deepEqual(f.starts, [2_250, 32_250]);
  f.request();
  f.deferFor(30_000);
  f.stop();
  await f.advance(60_000);
  assert.equal(f.starts.length, 2, "stop also cancels a deferred follow-up");
});
