// apps/mobile/lib/mesh/sync-diag.ts
//
// In-app sync diagnostics ring buffer. RELEASE (preview) builds strip JS
// console.log + don't pipe it to logcat, so the steady-sync logs are invisible on
// a real device — which is why "doesn't sync" has been undebuggable. This captures
// the key sync events into an in-memory ring the app can DISPLAY (app/sync-diag),
// so the state is readable on-device without adb.
//
// Cheap + best-effort: a bounded array, no I/O. Safe to call from anywhere.

export type SyncDiagListener = () => void;

const MAX_LINES = 120;
const lines: string[] = [];
const listeners = new Set<SyncDiagListener>();

function hhmmss(): string {
  // Date.now() is fine in app code (only the workflow sandbox forbids it).
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Record one sync event. Keep messages SHORT — they're read on a phone screen. */
export function syncDiag(line: string): void {
  try {
    lines.push(`${hhmmss()} ${line}`);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    for (const l of listeners) {
      try {
        l();
      } catch {
        /* */
      }
    }
  } catch {
    /* never let diagnostics break sync */
  }
}

/** Newest-first snapshot for display. */
export function getSyncDiagLines(): string[] {
  return [...lines].reverse();
}

export function clearSyncDiag(): void {
  lines.length = 0;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* */
    }
  }
}

/** Subscribe to new lines (for a live-updating screen). Returns unsubscribe. */
export function onSyncDiag(fn: SyncDiagListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
