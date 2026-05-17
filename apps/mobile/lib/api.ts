import { BACKEND_URL } from "../constants/env";
import type { CheckInResponse } from "./types";

const TIMEOUT_MS = 5000;

export async function checkIn(payload: {
  install_id: string;
  app_version: string;
  platform: string;
  device_locale: string;
  // Telemetry counters set once during the v0 -> v1 mobile migration.
  // Omitted when nothing was dropped.
  phones_invalid_count?: number;
  phones_conflict_count?: number;
}): Promise<CheckInResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND_URL}/v1/check-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`check-in failed: ${res.status}`);
    }
    return (await res.json()) as CheckInResponse;
  } finally {
    clearTimeout(timer);
  }
}
