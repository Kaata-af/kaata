// apps/mobile/lib/util/mutex.ts
//
// Minimal async mutex. Used by the migration-014 sweep to serialize
// quarantine sweeps against applyIncomingBatch (both mutate projections
// via the same applier dispatch).
//
// Design: a FIFO promise chain. runExclusive queues a callback behind
// any currently-running or queued callbacks; resolves with that
// callback's return value or rejects with its thrown error. Cancellation
// is intentionally NOT supported — the use cases here are all "run to
// completion, then release."

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Run a callback under exclusive lock. The callback is queued behind
   * any currently-running or previously-queued holders and resolves
   * with the callback's return value. If the callback throws or
   * rejects, the lock is released (the rejection is propagated to the
   * runExclusive caller).
   */
  async runExclusive<T>(callback: () => Promise<T> | T): Promise<T> {
    // Anchor the next slot on the current tail. The slot's resolution
    // controls when the NEXT runExclusive call may start.
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previousTail = this.tail;
    this.tail = previousTail.then(() => slot);
    // Wait our turn.
    await previousTail;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}
