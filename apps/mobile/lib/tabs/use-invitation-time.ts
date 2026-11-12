import { useEffect, useState } from "react";
import { AppState } from "react-native";

/** Refresh invitation labels at their deadline and after returning to the app.
 * One timer per screen, with no polling when all invitations are resolved. */
export function useInvitationTime(deadlines: readonly (number | null | undefined)[]): number {
  const [now, setNow] = useState(Date.now);
  const next = deadlines.reduce<number>(
    (earliest, time) =>
      typeof time === "number" && Number.isFinite(time) && time > now
        ? Math.min(earliest, time)
        : earliest,
    Infinity,
  );
  useEffect(() => {
    const wake = () => setNow(Date.now());
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") wake();
    });
    const timer = Number.isFinite(next)
      ? setTimeout(wake, Math.min(2_147_483_647, Math.max(1, next - Date.now() + 1)))
      : undefined;
    return () => {
      subscription.remove();
      if (timer != null) clearTimeout(timer);
    };
  }, [next, now]);
  return now;
}
