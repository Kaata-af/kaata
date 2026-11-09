import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { getBackendUrl } from "./api";
import { getAppMeta, setAppMeta } from "./db";
import type { LocaleCode } from "./i18n";
import { cachedSponsorArtwork, stageSponsorArtwork } from "./sponsor-artwork-cache";

export type SponsorSlide = { image_url: string; destination_url: string };

type SponsorPlacement = {
  button: { enabled: boolean; label: string };
  banner: { enabled: boolean; rotation_seconds: number; slides: SponsorSlide[] };
};

type PlacementSnapshot = { etag: string | null; settings: SponsorPlacement };
type PlacementSwitches = { button: boolean; banner: boolean };
type Locales<T> = Partial<Record<LocaleCode, T>>;
type PlacementCache = {
  backend: string;
  switches: PlacementSwitches;
  locales: Locales<PlacementSnapshot>;
};
type PlacementView = { switches: PlacementSwitches | null; locales: Locales<SponsorPlacement> };

const IMAGE_PATH = /^\/v1\/sponsor-images\/[a-f0-9]{64}$/;
const CACHE_KEY = "sponsor_placement_cache_v2";
const LOCALES = ["en", "fa", "ps"] as const satisfies readonly LocaleCode[];
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

function displayPlacement(backend: string, settings: SponsorPlacement): SponsorPlacement {
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

function readCache(backend: string, raw: string): PlacementCache | null {
  const saved = JSON.parse(raw) as Partial<PlacementCache> | null;
  if (
    saved?.backend !== backend ||
    typeof saved.switches?.button !== "boolean" ||
    typeof saved.switches.banner !== "boolean"
  )
    return null;

  const locales: Locales<PlacementSnapshot> = {};
  for (const locale of LOCALES) {
    const entry = saved.locales?.[locale];
    if (!entry) continue;
    try {
      const settings = parsePlacement(entry.settings);
      locales[locale] = { settings, etag: typeof entry.etag === "string" ? entry.etag : null };
    } catch {
      // A bad entry for one locale does not discard the other saved artwork.
    }
  }
  return { backend, switches: saved.switches, locales };
}

function same<T>(left: T, right: T) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Refresh independently of check-in, without sending any account or device data. */
export function useSponsorPlacement(locale: LocaleCode, enabled: boolean) {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<PlacementView>({ switches: null, locales: {} });
  const cache = useRef<PlacementCache | null>(null);
  const persistQueue = useRef(Promise.resolve());

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const [backend, raw] = await Promise.all([resolvedBackend(), getAppMeta(CACHE_KEY)]);
        if (!current || !raw) return;
        const saved = readCache(backend, raw);
        if (!saved) return;
        cache.current = saved;
        const locales: Locales<SponsorPlacement> = {};
        for (const language of LOCALES) {
          const entry = saved.locales[language];
          if (entry) locales[language] = displayPlacement(backend, entry.settings);
        }
        setView({ switches: saved.switches, locales });
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
      const publish = (backend: string, next: PlacementSnapshot, switches: PlacementSwitches) => {
        const previous = cache.current;
        const saved = { backend, switches, locales: { ...previous?.locales, [locale]: next } };
        cache.current = saved;
        const visible = displayPlacement(backend, next.settings);
        setView((prior) => {
          const entry = prior.locales[locale];
          const button =
            entry && same(entry.button, visible.button) ? entry.button : visible.button;
          const banner =
            entry && same(entry.banner, visible.banner) ? entry.banner : visible.banner;
          const nextSwitches = same(prior.switches, switches) ? prior.switches : switches;
          const locales =
            button === entry?.button && banner === entry.banner
              ? prior.locales
              : { ...prior.locales, [locale]: { button, banner } };
          return locales === prior.locales && nextSwitches === prior.switches
            ? prior
            : { locales, switches: nextSwitches };
        });
        if (!same(previous, saved)) {
          persistQueue.current = persistQueue.current
            .then(() => setAppMeta(CACHE_KEY, JSON.stringify(saved)))
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
          if (cache.current && cache.current.backend !== backend) {
            cache.current = null;
            setView({ switches: null, locales: {} });
          }
          const previous = cache.current?.locales[locale];
          const response = await fetch(`${backend}/v1/sponsor-placement?locale=${locale}`, {
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
            next = { etag: response.headers.get("ETag"), settings };
          }
          if (request !== controller) return;

          const paths = artworkPaths(next.settings);
          const retained = Object.values(cache.current?.locales ?? {}).flatMap(({ settings }) =>
            artworkPaths(settings),
          );
          const switches = {
            button: next.settings.button.enabled,
            banner: next.settings.banner.enabled,
          };
          const needsArtwork = paths.some(
            (path) => !retained.includes(path) || !cachedSponsorArtwork(backend, path),
          );
          if (!needsArtwork) {
            if (!same(previous, next) || !same(cache.current?.switches, switches)) {
              publish(backend, next, switches);
            }
            return;
          }

          if (
            !same(previous?.settings.button, next.settings.button) ||
            !same(cache.current?.switches, switches)
          ) {
            // Switches and button text apply without waiting for replacement art.
            publish(
              backend,
              {
                etag: null,
                settings: {
                  button: next.settings.button,
                  banner: previous?.settings.banner ?? { ...next.settings.banner, slides: [] },
                },
              },
              switches,
            );
          }
          clearTimeout(timeout);
          timeout = setTimeout(expire, ARTWORK_TIMEOUT_MS);
          await stageSponsorArtwork(backend, paths, retained, controller.signal);
          if (request === controller) publish(backend, next, switches);
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
    }, [enabled, locale, ready]),
  );
  const active = view.locales[locale];
  const switches = view.switches;
  const placement = useMemo(() => {
    if (!active || !switches) return null;
    const button =
      active.button.enabled === switches.button
        ? active.button
        : { ...active.button, enabled: switches.button };
    const banner =
      active.banner.enabled === switches.banner
        ? active.banner
        : {
            ...active.banner,
            enabled: switches.banner,
            slides: switches.banner ? active.banner.slides : [],
          };
    return button === active.button && banner === active.banner ? active : { button, banner };
  }, [active, switches]);
  return { ready, placement: enabled ? placement : null };
}
