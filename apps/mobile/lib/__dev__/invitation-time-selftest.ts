import assert from "node:assert/strict";
import { compileUI, jsx, uiHooks } from "./ui-fixture";

function fixture(initialNow: number, initialDeadlines: (number | null | undefined)[]) {
  let now = initialNow,
    nextId = 0,
    deadlines = initialDeadlines;
  const timers = new Map<number, { at: number; run: () => void }>();
  const listeners = new Set<(state: string) => void>();
  const hooks = uiHooks();
  const { useInvitationTime } = compileUI(
    "../tabs/use-invitation-time",
    {
      react: hooks.react,
      "react-native": {
        AppState: {
          addEventListener: (_: string, listener: (state: string) => void) => {
            listeners.add(listener);
            return { remove: () => listeners.delete(listener) };
          },
        },
      },
    },
    {
      Date: { now: () => now },
      setTimeout: (run: () => void, delay: number) => {
        const id = ++nextId;
        timers.set(id, { at: now + delay, run });
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  const render = () => hooks.render(() => jsx("clock", { now: useInvitationTime(deadlines) }));
  render();
  return {
    timers,
    listeners,
    hooks,
    now: () => hooks.tree.props.now as number,
    deadlines: (value: typeof deadlines) => {
      deadlines = value;
      render();
    },
    advance: (value: number, runTimers = true) => {
      now = value;
      if (runTimers) {
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue;
          timers.delete(id);
          timer.run();
          render();
        }
      }
    },
    state: (state: string) => {
      for (const listener of [...listeners]) listener(state);
      render();
    },
  };
}

const deadlines = fixture(1_000, [3_000, null, 2_000, 2_000, Number.NaN]);
assert.equal(
  deadlines.timers.size,
  1,
  "a screen owns one timer for its nearest pending invitation",
);
deadlines.advance(1_999);
assert.equal(deadlines.now(), 1_000);
deadlines.advance(2_001);
assert.equal(
  deadlines.now(),
  2_001,
  "crossing the deadline refreshes the visible status without interaction",
);
assert.equal(deadlines.timers.size, 1, "the next unresolved invitation gets its own deadline");
deadlines.advance(3_001);
assert.equal(deadlines.now(), 3_001);
assert.equal(deadlines.timers.size, 0, "resolved deadlines do not leave a polling timer");
deadlines.hooks.unmount();

const resumed = fixture(1_000, [2_000]);
resumed.state("background");
resumed.advance(9_000, false);
assert.equal(resumed.now(), 1_000, "the fake OS suspends timer callbacks in background");
resumed.state("active");
assert.equal(
  resumed.now(),
  9_000,
  "returning to the app refreshes an overdue invitation immediately",
);
assert.equal(resumed.timers.size, 0);
resumed.deadlines([10_000]);
assert.equal(resumed.timers.size, 1);
resumed.deadlines([]);
assert.equal(resumed.timers.size, 0, "accepting or withdrawing the last invite cancels its timer");
resumed.hooks.unmount();
assert.equal(resumed.listeners.size, 0, "unmount removes the AppState listener");
assert.equal(resumed.hooks.lateWrites, 0);

const distant = fixture(0, [3_000_000_000]);
assert.equal(
  [...distant.timers.values()][0].at,
  2_147_483_647,
  "long deadlines never overflow native timers",
);
distant.advance(2_147_483_647);
assert.equal([...distant.timers.values()][0].at, 3_000_000_001);
distant.hooks.unmount();
assert.equal(distant.timers.size, 0);
console.log(
  "PASS: invitation clock deadlines, background resume, cancelled invitations, timer bounds and cleanup",
);
