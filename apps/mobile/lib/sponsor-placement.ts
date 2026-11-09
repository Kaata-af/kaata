import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { getBackendUrl } from "./api";
import { getAppMeta, setAppMeta } from "./db";
import { cachedSponsorArtwork, stageSponsorArtwork } from "./sponsor-artwork-cache";

export type SponsorSlide = { image_url: string; destination_url: string };

type SponsorPlacement = {
  button: { enabled: boolean; label: string };
  banner: { enabled: boolean; rotation_seconds: number; slides: SponsorSlide[] };
};

type PlacementSnapshot = { backend: string; etag: string | null; settings: SponsorPlacement };

const IMAGE_PATH = /^\/v1\/sponsor-images\/[a-f0-9]{64}$/;
const CACHE_KEY = "sponsor_placement_cache_v1";
const REFRESH_MS = 60_000;
const TIMEOUT_MS = 5_000;
const ARTWORK_TIMEOUT_MS = 25_000;

function isWebDestination(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    /^https?:\/\/[^/?#@\\\s]+(?:[/?#]|$)/i.test(value)
  );
}

function parsePlacement(data: unknown): SponsorPlacement {
  const placement = data as Partial<SponsorPlacement> | null;
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
        return [{ image_url: slide.image_url, destination_url: slide.destination_url }];
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

const resolvedBackend = async () => (await getBackendUrl()).replace(/\/+$/, "");
const artworkPaths = (placement: SponsorPlacement) =>
  placement.banner.slides.map((slide) => slide.image_url);

function displayPlacement({ backend, settings }: PlacementSnapshot): SponsorPlacement {
  return {
    button: settings.button,
    banner: {
      ...settings.banner,
      slides: settings.banner.slides.flatMap((slide) => {
        const local = cachedSponsorArtwork(backend, slide.image_url);
        return local ? [{ ...slide, image_url: local }] : [];
      }),
    },
  };
}

function same<T>(left: T, right: T) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Refresh independently of check-in, without sending any account or device data. */
export function useSponsorPlacement(enabled: boolean) {
  const [ready, setReady] = useState(false);
  const [placement, setPlacement] = useState<SponsorPlacement | null>(null);
  const snapshot = useRef<PlacementSnapshot | null>(null);
  const persistQueue = useRef(Promise.resolve());

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const [backend, raw] = await Promise.all([resolvedBackend(), getAppMeta(CACHE_KEY)]);
        if (!current || !raw) return;
        const saved = JSON.parse(raw) as Partial<PlacementSnapshot> | null;
        if (saved?.backend !== backend) return;
        const settings = parsePlacement(saved.settings);
        const etag = typeof saved.etag === "string" ? saved.etag : null;
        snapshot.current = { backend, etag, settings };
        setPlacement(displayPlacement(snapshot.current));
      } catch {
        // A missing or corrupt cache must not block Home.
      } finally {
        if (current) setReady(true);
      }
    })();
    return () => {
      current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!enabled || !ready) return;
      let request: AbortController | null = null;

      const cancel = () => {
        request?.abort();
        request = null;
      };
      const publish = (next: PlacementSnapshot) => {
        const previous = snapshot.current;
        snapshot.current = next;
        const visible = displayPlacement(next);
        setPlacement((prior) => {
          if (!prior) return visible;
          const button = same(prior.button, visible.button) ? prior.button : visible.button;
          const banner = same(prior.banner, visible.banner) ? prior.banner : visible.banner;
          return button === prior.button && banner === prior.banner ? prior : { button, banner };
        });
        if (!same(previous, next)) {
          persistQueue.current = persistQueue.current
            .then(() => setAppMeta(CACHE_KEY, JSON.stringify(next)))
            .catch(() => {});
        }
      };
      const refresh = async () => {
        if (request || (AppState.currentState && AppState.currentState !== "active")) return;
        const controller = new AbortController();
        request = controller;
        const expire = () => {
          if (request === controller) cancel();
        };
        let timeout = setTimeout(expire, TIMEOUT_MS);
        try {
          const backend = await resolvedBackend();
          if (request !== controller) return;
          let previous = snapshot.current;
          if (previous && previous.backend !== backend) {
            previous = null;
            snapshot.current = null;
            setPlacement(null);
          }
          const response = await fetch(`${backend}/v1/sponsor-placement`, {
            headers: {
              Accept: "application/json",
              ...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
            },
            cache: "no-store",
            signal: controller.signal,
          });
          let next: PlacementSnapshot;
          if (response.status === 304 && previous) next = previous;
          else {
            if (!response.ok) return;
            const settings = parsePlacement(await response.json());
            next = { backend, etag: response.headers.get("ETag"), settings };
          }
          if (request !== controller) return;

          const paths = artworkPaths(next.settings);
          const retained = previous ? artworkPaths(previous.settings) : [];
          const needsArtwork = paths.some(
            (path) => !retained.includes(path) || !cachedSponsorArtwork(backend, path),
          );
          if (!needsArtwork) {
            if (!same(previous, next)) publish(next);
            return;
          }

          if (!same(previous?.settings.button, next.settings.button)) {
            // The promotion switch applies even if the new artwork cannot load.
            publish({
              backend,
              etag: null,
              settings: {
                button: next.settings.button,
                banner: previous?.settings.banner ?? { ...next.settings.banner, slides: [] },
              },
            });
          }
          clearTimeout(timeout);
          timeout = setTimeout(expire, ARTWORK_TIMEOUT_MS);
          await stageSponsorArtwork(backend, paths, retained, controller.signal);
          if (request === controller) publish(next);
        } catch {
          // Keep the last complete artwork and retry on the next refresh.
          if (request === controller) cancel();
        } finally {
          clearTimeout(timeout);
          if (request === controller) request = null;
        }
      };

      void refresh();
      const timer = setInterval(() => void refresh(), REFRESH_MS);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void refresh();
        else cancel();
      });
      return () => {
        subscription.remove();
        clearInterval(timer);
        cancel();
      };
    }, [enabled, ready]),
  );
  return { ready, placement: enabled ? placement : null };
}
