import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { getSessionJWT } from "../lib/auth";
import { getLastBackupAt, uploadBackup } from "../lib/backup";

// Auto-backup component. Mounts once at the app root and listens for
// AppState transitions to "background" — the moment the user swipes
// up, presses home, or takes a call. That's the natural pause point
// where running a network upload doesn't interrupt anything they're
// doing.
//
// Behavior:
//   - Only fires when there's a session JWT (signed in).
//   - Enforces a 5-minute minimum interval between backups so a
//     rapid background → foreground (e.g. checking a notification)
//     doesn't spam the backend.
//   - Errors fail SILENTLY. Auto-backup must not nag the user — if a
//     given attempt fails, the next one will retry. The manual "Back
//     up now" button in Account is the path for explicit feedback.
//   - On iOS, "background" is reached after a brief "inactive" stop;
//     we ignore "inactive" because the user might be peeking at the
//     app switcher and returning instantly.
//
// Renders nothing — it's purely a side-effect host.

const MIN_INTERVAL_MS = 5 * 60 * 1000;

export function AutoBackup() {
  useEffect(() => {
    async function maybeBackup(state: AppStateStatus) {
      if (state !== "background") return;
      try {
        const jwt = await getSessionJWT();
        if (!jwt) return; // not signed in
        const lastAt = await getLastBackupAt();
        if (lastAt && Date.now() - lastAt.getTime() < MIN_INTERVAL_MS) {
          // Backed up recently — skip this trigger.
          return;
        }
        await uploadBackup();
      } catch (err) {
        // Silent failure by design. Console for debugging only.
        console.warn("[auto-backup] skipped or failed", err);
      }
    }
    const sub = AppState.addEventListener("change", maybeBackup);
    return () => sub.remove();
  }, []);

  return null;
}
