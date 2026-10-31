import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebActivity } from "./web-activity";
import type { WebSession } from "./web-auth";

const session: WebSession = {
  account_id: "account",
  install_id: "browser-session",
  session_jwt: "session-token",
  default_vault_id: null,
  user: { has_password: false },
};

async function microtasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function fixture(options: { visible?: boolean; request?: () => Promise<unknown> } = {}) {
  let now = 0;
  let visible = options.visible ?? true;
  let online = true;
  let current: WebSession | null = session;
  let locale = "fa";
  let change: (() => void) | undefined;
  let nextID = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: { at: number; locale: string; signal: AbortSignal }[] = [];
  const activity = createWebActivity({
    session,
    locale: () => locale,
    dependencies: {
      now: () => now,
      visible: () => visible,
      online: () => online,
      getSession: () => current,
      request: async (language, signal) => {
        calls.push({ at: now, locale: language, signal });
        return options.request?.();
      },
      subscribe: (handler) => {
        change = handler;
        return () => {
          change = undefined;
        };
      },
      setTimer: (callback, delay) => {
        const id = ++nextID;
        timers.set(id, { at: now + delay, callback });
        return id;
      },
      clearTimer: (id) => timers.delete(id as number),
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
  return {
    ...activity,
    calls,
    timers,
    advance,
    changed: () => change?.(),
    visible: (value: boolean) => {
      visible = value;
      change?.();
    },
    online: (value: boolean) => {
      online = value;
      change?.();
    },
    session: (value: WebSession | null) => {
      current = value;
      change?.();
    },
    locale: (value: string) => {
      locale = value;
    },
  };
}

test("web presence sends once per minute while visible, including the latest language", async () => {
  const f = fixture();
  await f.advance(0);
  assert.deepEqual(
    f.calls.map(({ at, locale }) => ({ at, locale })),
    [{ at: 0, locale: "fa" }],
  );
  for (let i = 0; i < 20; i++) f.changed();
  await f.advance(59_999);
  assert.equal(f.calls.length, 1);
  f.locale("ps");
  await f.advance(1);
  assert.equal(f.calls[1].at, 60_000);
  assert.equal(f.calls[1].locale, "ps");
  f.stop();
  await f.advance(180_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 0);
});

test("hidden and offline tabs do not report activity, and resuming cannot bypass the minute limit", async () => {
  const f = fixture({ visible: false });
  await f.advance(180_000);
  assert.equal(f.calls.length, 0);
  f.visible(true);
  await f.advance(0);
  assert.equal(f.calls.length, 1);
  f.visible(false);
  await f.advance(10_000);
  f.visible(true);
  f.online(false);
  await f.advance(80_000);
  assert.equal(f.calls.length, 1);
  f.online(true);
  await f.advance(0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].at, 270_000);
  f.stop();
});

test("slow and failing presence requests never overlap or create a fast retry loop", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let requests = 0;
  const f = fixture({
    request: () => (++requests === 1 ? gate : Promise.reject(new Error("offline"))),
  });
  await f.advance(0);
  await f.advance(180_000);
  f.changed();
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
  finish();
  await microtasks();
  await f.advance(0);
  assert.equal(f.calls.length, 2);
  await f.advance(59_999);
  assert.equal(f.calls.length, 2);
  await f.advance(1);
  assert.equal(f.calls.length, 3);
  f.stop();
});

test("sign-out or a different browser credential aborts pending work and unsubscribes", async () => {
  for (const next of [
    null,
    { ...session, session_jwt: "new-token" },
    { ...session, install_id: "other-tab" },
  ]) {
    const f = fixture({ request: () => new Promise(() => {}) });
    await f.advance(0);
    f.session(next);
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.timers.size, 0);
    f.session(session);
    await f.advance(180_000);
    assert.equal(f.calls.length, 1);
    f.stop();
  }
});
