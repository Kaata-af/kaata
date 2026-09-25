import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { readDeviceContacts, type DeviceContactsResult } from "./contacts-sync";

/** Explicit access button + silent refresh when returning from system Settings. */
export function useDeviceContacts() {
  const [access, setAccess] = useState<DeviceContactsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const requesting = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(async (requestPermission = false) => {
    const run = ++generation.current;
    const result = await readDeviceContacts({ requestPermission });
    if (mounted.current && run === generation.current) setAccess(result);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    let previous = AppState.currentState;
    const listener = AppState.addEventListener("change", (next) => {
      const resumed = previous !== "active" && next === "active";
      previous = next;
      // Permission dialogs can themselves cause an inactive→active event.
      if (resumed && !requesting.current) void refresh();
    });
    return () => {
      mounted.current = false;
      generation.current++;
      listener.remove();
    };
  }, [refresh]);

  const requestAccess = async () => {
    if (requesting.current) return;
    requesting.current = true;
    setBusy(true);
    setFailed(false);
    try {
      if (access?.limited || (access?.granted === false && !access.canAskAgain)) {
        await Linking.openSettings();
        await refresh();
      } else {
        await refresh(true);
      }
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      requesting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return { access, busy, failed, requestAccess };
}
