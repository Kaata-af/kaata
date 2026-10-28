const COALESCE_MS = 250;
const MIN_INTERVAL_MS = 8_000;

export type WebRefreshDependencies = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timer: number) => void;
};

/** Queue automatic reads without overlapping work or losing a hint mid-read. */
export function createWebRefresh({
  refresh,
  dependencies = {},
}: {
  refresh: () => Promise<void>;
  dependencies?: Partial<WebRefreshDependencies>;
}): { request: () => void; deferFor: (milliseconds: number) => void; stop: () => void } {
  const clock: WebRefreshDependencies = {
    now: () => performance.now(),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
    ...dependencies,
  };
  let stopped = false;
  let running = false;
  let dirty = false;
  let firstHintAt: number | null = null;
  let lastStartedAt: number | null = null;
  let notBefore = -Infinity;
  let timer: number | null = null;

  function schedule(): void {
    if (stopped || running || !dirty || timer !== null) return;
    const due = Math.max(
      (firstHintAt ?? clock.now()) + COALESCE_MS,
      lastStartedAt === null ? -Infinity : lastStartedAt + MIN_INTERVAL_MS,
      notBefore,
    );
    timer = clock.setTimer(() => void run(), Math.max(0, due - clock.now()));
  }

  async function run(): Promise<void> {
    timer = null;
    if (stopped || running || !dirty) return;
    dirty = false;
    firstHintAt = null;
    running = true;
    lastStartedAt = clock.now();
    try {
      await refresh();
    } catch {
      // The read callback owns its visible error. A later hint/poll can retry;
      // failures alone must not create an unbounded background retry loop.
    } finally {
      running = false;
      schedule();
    }
  }

  return {
    request() {
      if (stopped) return;
      dirty = true;
      firstHintAt ??= clock.now();
      // Keep the first deadline: continuous hints must never starve a read.
      schedule();
    },
    deferFor(milliseconds) {
      if (stopped || !Number.isFinite(milliseconds) || milliseconds <= 0) return;
      // Timer delays above the browser's signed 32-bit range wrap to an
      // immediate timeout. Retry-After normally stays far below that bound.
      const until = clock.now() + Math.min(milliseconds, 2_147_000_000);
      if (until <= notBefore) return;
      notBefore = until;
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
      // Preserve an existing hint; a cooldown alone does not create work.
      schedule();
    },
    stop() {
      stopped = true;
      dirty = false;
      firstHintAt = null;
      if (timer !== null) clock.clearTimer(timer);
      timer = null;
      // An already-running read cannot be cancelled here. Its owner must
      // ignore stale results; this queue never starts follow-up work after stop.
    },
  };
}
