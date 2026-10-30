// Restore spans a projection seed and replay tail. Alert observers resume only
// after that complete result is ready, with intermediate work invalidated.
let restoreDepth = 0;
let epoch = 0;
const listeners = new Set<() => void>();

export const creditAlertObservationPaused = () => restoreDepth > 0;
export const creditAlertObservationEpoch = () => epoch;

export function beginCreditAlertRestore(): () => void {
  restoreDepth++;
  epoch++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    restoreDepth--;
    epoch++;
    if (restoreDepth === 0) for (const listener of [...listeners]) listener();
  };
}

export function onCreditAlertObservationResumed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
