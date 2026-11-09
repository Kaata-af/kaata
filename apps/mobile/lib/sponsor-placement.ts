import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState } from "react-native";
import { getBackendUrl } from "./api";

export type SponsorSlide = { image_url: string; destination_url: string };

type SponsorPlacement = {
  button: { enabled: boolean; label: string };
  banner: { enabled: boolean; rotation_seconds: number; slides: SponsorSlide[] };
};

const IMAGE_PATH = /^\/v1\/sponsor-images\/[a-f0-9]{64}$/;
const REFRESH_MS = 60_000;
const TIMEOUT_MS = 5_000;

function isWebDestination(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    /^https?:\/\/[^/?#@\\\s]+(?:[/?#]|$)/i.test(value)
  );
}

async function fetchPlacement(signal: AbortSignal): Promise<SponsorPlacement> {
  const backend = (await getBackendUrl()).replace(/\/+$/, "");
  const response = await fetch(`${backend}/v1/sponsor-placement`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("sponsor_placement_unavailable");
  const placement: Partial<SponsorPlacement> | null = await response.json();
  if (
    typeof placement?.button?.enabled !== "boolean" ||
    typeof placement.button.label !== "string" ||
    typeof placement.banner?.enabled !== "boolean" ||
    !Array.isArray(placement.banner.slides)
  ) {
    throw new Error("sponsor_placement_invalid");
  }
  const slides = placement.banner.enabled
    ? placement.banner.slides.slice(0, 8).flatMap((slide) => {
        if (
          typeof slide?.image_url !== "string" ||
          !IMAGE_PATH.test(slide.image_url) ||
          !isWebDestination(slide.destination_url)
        )
          return [];
        return [
          {
            image_url: `${backend}${slide.image_url}`,
            destination_url: slide.destination_url,
          },
        ];
      })
    : [];
  const seconds = placement.banner.rotation_seconds;
  return {
    button: { enabled: placement.button.enabled, label: placement.button.label.trim() },
    banner: {
      enabled: placement.banner.enabled,
      slides,
      rotation_seconds: Number.isInteger(seconds) && seconds >= 3 && seconds <= 30 ? seconds : 6,
    },
  };
}

/** Refresh independently of check-in, without sending any account or device data. */
export function useSponsorPlacement(enabled: boolean): SponsorPlacement | null {
  const [placement, setPlacement] = useState<SponsorPlacement | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      let request: AbortController | null = null;
      let fingerprint = "";

      const clear = () => {
        request?.abort();
        request = null;
        fingerprint = "";
        setPlacement(null);
      };
      const refresh = async () => {
        if (request || (AppState.currentState && AppState.currentState !== "active")) return;
        const controller = new AbortController();
        request = controller;
        const timeout = setTimeout(() => {
          if (request === controller) clear();
        }, TIMEOUT_MS);
        try {
          const next = await fetchPlacement(controller.signal);
          if (request !== controller) return;
          const nextFingerprint = JSON.stringify(next);
          if (nextFingerprint !== fingerprint) {
            fingerprint = nextFingerprint;
            setPlacement(next);
          }
        } catch {
          if (request === controller) clear();
        } finally {
          clearTimeout(timeout);
          if (request === controller) request = null;
        }
      };

      void refresh();
      const timer = setInterval(() => void refresh(), REFRESH_MS);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void refresh();
        else clear();
      });
      return () => {
        subscription.remove();
        clearInterval(timer);
        clear();
      };
    }, [enabled]),
  );
  return enabled ? placement : null;
}
