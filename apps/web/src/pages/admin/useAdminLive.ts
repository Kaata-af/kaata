import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BACKEND_URL } from "../../env";
import { createAdminLive, refreshAdminQueries, type AdminLiveState } from "./live";

export function useAdminLive(token: string, onUnauthorized: () => void): AdminLiveState {
  const client = useQueryClient();
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const [connection, setConnection] = useState<{ token: string; state: AdminLiveState }>({
    token,
    state: token ? "connecting" : "polling",
  });

  useEffect(() => {
    let active = true;
    const controller = createAdminLive({
      backendUrl: BACKEND_URL,
      token,
      onState: (state) => {
        if (active) setConnection({ token, state });
      },
      onUnauthorized: () => {
        if (active) unauthorizedRef.current();
      },
      invalidate: () => refreshAdminQueries(client, () => active),
    });
    return () => {
      active = false;
      controller.stop();
    };
  }, [client, token]);

  return connection.token === token ? connection.state : token ? "connecting" : "polling";
}
