// Imperative "run a check-in NOW" signal.
//
// BackgroundCheckIn (app/_layout.tsx) normally only pings the backend on cold
// launch and on background->foreground transitions (throttled). That leaves a
// gap: when the user completes onboarding MID-SESSION — creating their
// local-self identity (name / phone / shop) — none of that reaches the backend
// until their NEXT independent launch or foreground. For a user who onboarded
// but did NOT sign in with Google (anonymous install), the only record the
// admin dashboard has is the cold-launch check-in that fired BEFORE the self
// existed: has_onboarded=false, no name, no phone. If they set the phone down
// and don't reopen the app, that stale state persists indefinitely.
//
// This module is a tiny dependency-free pub/sub so identity-creating flows can
// ask BackgroundCheckIn to run an immediate, un-throttled check-in the moment
// the self is committed. createSelfProfile() fires it after writing the self +
// first vault. Keeping it dependency-free avoids any import cycle with lib/db.
//
// It is intentionally best-effort: if BackgroundCheckIn isn't mounted yet, or
// the network is down, the request is simply dropped — the next cold-launch
// check-in still self-heals because getLocalSelf() now returns the self.

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Ask any mounted check-in runner to perform an immediate (un-throttled)
 * check-in. Safe to call from anywhere; a no-op if nothing is subscribed.
 * Never throws — a misbehaving listener is logged and skipped.
 */
export function requestImmediateCheckIn(): void {
  // Snapshot so a listener that unsubscribes during iteration can't mutate
  // the set we're walking.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.warn("[checkin-trigger] listener threw", err);
    }
  }
}

/**
 * Subscribe to immediate-check-in requests. Returns an unsubscribe function;
 * call it on unmount. BackgroundCheckIn is the sole subscriber today.
 */
export function subscribeCheckInRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
