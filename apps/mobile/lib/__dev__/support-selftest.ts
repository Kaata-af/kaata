// Actual transport helpers with synthetic native composer/Linking boundaries.
// Never opens another app, sends a message, or accesses the network.
import assert from "node:assert/strict";
import { SUPPORT_SMS_E164, SUPPORT_WHATSAPP_E164 } from "../../constants/env";
import type { LocaleCode } from "../i18n";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
const tokens = compileUI("../tokens", {
  "./fonts": {
    fonts: {},
    sansLineHeight: (_size: number, height: number) => height,
    monoLineHeight: (_size: number, height: number) => height,
  },
});

function fixture(
  options: {
    nativeMissing?: boolean;
    probeThrows?: boolean;
    importThrows?: boolean;
    available?: boolean;
    availabilityError?: boolean;
    availabilityGate?: Promise<boolean>;
    composerError?: boolean;
    composerGate?: Promise<{ result: "sent" | "unknown" | "cancelled" }>;
    result?: "sent" | "unknown" | "cancelled";
    openUrl?: (url: string, count: number) => Promise<void>;
  } = {},
) {
  const probes: string[] = [],
    urls: string[] = [],
    composers: unknown[][] = [];
  let imports = 0,
    availabilityCalls = 0;
  const api = compileUI(
    "../support",
    {
      "react-native": {
        Linking: {
          openURL: async (url: string) => {
            urls.push(url);
            await options.openUrl?.(url, urls.length);
          },
        },
      },
      "expo-modules-core": {
        requireOptionalNativeModule: (name: string) => {
          probes.push(name);
          if (options.probeThrows) throw new Error("Synthetic native unavailable");
          return options.nativeMissing ? null : {};
        },
      },
      "../constants/env": { SUPPORT_SMS_E164, SUPPORT_WHATSAPP_E164 },
      get "expo-sms"() {
        imports++;
        if (options.importThrows) throw new Error("Synthetic missing SMS entry point");
        return {
          isAvailableAsync: async () => {
            availabilityCalls++;
            if (options.availabilityError) throw new Error("Synthetic availability failure");
            return options.availabilityGate ?? options.available !== false;
          },
          sendSMSAsync: async (...args: unknown[]) => {
            composers.push(args);
            if (options.composerError) throw new Error("Synthetic no messaging app");
            return options.composerGate ?? { result: options.result ?? "unknown" };
          },
        };
      },
    },
    { console: { warn() {} } },
  ) as typeof import("../support");
  return {
    api,
    probes,
    urls,
    composers,
    get imports() {
      return imports;
    },
    get availabilityCalls() {
      return availabilityCalls;
    },
  };
}

function sponsorButtonFixture(
  options: {
    locale?: "en" | "fa" | "ps";
    enabled?: boolean;
    label?: string;
    interactive?: boolean;
    push?: (route: string, count: number) => void;
  } = {},
) {
  const locale = options.locale ?? "en";
  language.setLocale(locale);
  const hooks = uiHooks();
  const routes: string[] = [];
  const toasts: unknown[][] = [];
  let blur = () => {};
  let focus = () => () => {};
  const component = compileUI("../../components/SponsorButton", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": {
      useFocusEffect: (work: () => () => void) =>
        hooks.react.useEffect(() => {
          focus = work;
          blur = work();
          return blur;
        }, [work]),
      useRouter: () => ({
        push: (route: string) => {
          routes.push(route);
          options.push?.(route, routes.length);
        },
      }),
    },
    "react-native": {
      Pressable: "Pressable",
      Text: "Text",
      StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
    },
    "../lib/colors": compileUI("../colors", {}),
    "../lib/direction": {
      useIsRTL: () => locale !== "en",
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
    },
    "../lib/i18n": language,
    "../lib/tokens": tokens,
    "./Toast": { useToast: () => ({ push: (...args: unknown[]) => void toasts.push(args) }) },
  });
  const tree = hooks.render(() =>
    component.SponsorButton({
      enabled: options.enabled ?? true,
      label: options.label ?? "",
      interactive: options.interactive,
    }),
  );
  return {
    tree,
    routes,
    toasts,
    blur: () => blur(),
    focus: () => {
      blur = focus();
    },
  };
}

async function sponsorPlacementChecks() {
  const firstPath = `/v1/sponsor-images/${"a".repeat(64)}`;
  const nextPath = `/v1/sponsor-images/${"b".repeat(64)}`;
  const dariPath = `/v1/sponsor-images/${"c".repeat(64)}`;
  const pashtoPath = `/v1/sponsor-images/${"d".repeat(64)}`;
  const destination = "https://example.invalid/?text=@shop";
  const cached = new Set<string>();
  const localArtwork = (path: string) => `file:///kaata/cache/${path.slice(-64)}.img`;
  const requests: { url: string; tag?: string }[] = [];
  const downloads: string[][] = [];
  let saved: string | null = null;
  let etag = 'W/"a"';
  let path = firstPath;
  let buttonEnabled = true;
  let bannerEnabled = true;
  let unavailable = false;
  let waitForArtwork: Promise<void> | undefined;
  let waitForDari: Promise<void> | undefined;

  function mountPlacement() {
    const hooks = uiHooks();
    let locale: LocaleCode = "en";
    const intervals = new Set<() => void>();
    let onAppState = (_state: string) => {};
    const appState = {
      currentState: "active",
      addEventListener: (_name: string, listener: typeof onAppState) => {
        onAppState = listener;
        return { remove() {} };
      },
    };
    const placementModule = compileUI(
      "../sponsor-placement",
      {
        react: hooks.react,
        "expo-router": {
          useFocusEffect: (effect: () => () => void) => hooks.react.useEffect(effect, [effect]),
        },
        "react-native": { AppState: appState },
        "./api": { getBackendUrl: async () => "https://api.example.invalid/backend/" },
        "./db": {
          getAppMeta: async () => saved,
          setAppMeta: async (_key: string, value: string) => {
            saved = value;
          },
        },
        "./sponsor-artwork-cache": {
          cachedSponsorArtwork: (_backend: string, image: string) =>
            cached.has(image) ? localArtwork(image) : null,
          stageSponsorArtwork: async (
            _backend: string,
            images: string[],
            retained: string[],
            signal: AbortSignal,
          ) => {
            downloads.push(images);
            await waitForArtwork;
            if (signal.aborted) return;
            for (const image of cached) {
              if (!images.includes(image) && !retained.includes(image)) cached.delete(image);
            }
            images.forEach((image) => cached.add(image));
          },
        },
      },
      {
        fetch: async (url: string, options: { headers: Record<string, string> }) => {
          const tag = options.headers["If-None-Match"];
          requests.push({ url, tag });
          if (unavailable) throw new Error("offline");
          const language = new URL(url).searchParams.get("locale");
          if (language === "fa") await waitForDari;
          const publicTag = language === "en" ? etag : `W/"${language}-${bannerEnabled}"`;
          const image = language === "fa" ? dariPath : language === "ps" ? pashtoPath : path;
          const label =
            language === "fa"
              ? "تبلیغ کنید"
              : language === "ps"
                ? "اعلان وکړئ"
                : " Advertise here ";
          const link = language === "en" ? destination : `https://example.invalid/${language}`;
          if (tag === publicTag) return { status: 304, ok: false };
          return {
            status: 200,
            ok: true,
            headers: { get: () => publicTag },
            json: async () => ({
              button: { enabled: buttonEnabled, label },
              banner: {
                enabled: bannerEnabled,
                rotation_seconds: 8,
                slides: [
                  {
                    image_url: image,
                    destination_url: link,
                    ...(image !== firstPath ? { aspect_ratio: 2.5 } : {}),
                  },
                  {
                    image_url: "https://tracker.example.invalid/pixel",
                    destination_url: destination,
                  },
                  { image_url: path, destination_url: "kaata://invite/not-an-ad" },
                ],
              },
            }),
          };
        },
        setInterval: (fn: () => void, delay: number) => {
          assert.equal(delay, 60_000);
          intervals.add(fn);
          return fn;
        },
        clearInterval: (fn: () => void) => intervals.delete(fn),
      },
    );
    type State = ReturnType<typeof import("../sponsor-placement").useSponsorPlacement>;
    const render = () =>
      hooks.render(() => placementModule.useSponsorPlacement(locale, true)) as unknown as State;
    const poll = async () => {
      intervals.forEach((callback) => callback());
      await settleUI();
      return render().placement;
    };
    return {
      render,
      poll,
      intervals,
      unmount: hooks.unmount,
      selectLocale: (next: LocaleCode) => {
        locale = next;
        return render().placement;
      },
      appState: (state: string) => {
        appState.currentState = state;
        onAppState(state);
      },
    };
  }

  const home = mountPlacement();
  assert.equal(home.render().ready, false);
  await settleUI();
  assert.deepEqual(home.render(), { ready: true, placement: null });
  await settleUI();
  const initial = home.render().placement;
  assert.deepEqual(initial, {
    button: { enabled: true, label: "Advertise here" },
    banner: {
      enabled: true,
      rotation_seconds: 8,
      slides: [
        { image_url: localArtwork(firstPath), destination_url: destination, aspect_ratio: 6.4 },
      ],
    },
  });
  assert.deepEqual(requests, [
    { url: "https://api.example.invalid/backend/v1/sponsor-placement?locale=en", tag: undefined },
  ]);
  assert.equal(await home.poll(), initial, "A 304 leaves the original placement untouched");
  assert.equal(requests.at(-1)?.tag, etag);
  assert.deepEqual(downloads, [[firstPath]]);
  unavailable = true;
  home.appState("background");
  assert.equal(home.render().placement, initial);
  home.unmount();
  assert.equal(home.intervals.size, 0);

  const reopened = mountPlacement();
  reopened.render();
  await settleUI();
  assert.deepEqual(
    reopened.render(),
    { ready: true, placement: initial },
    "Cold Home draws saved artwork before the network resolves",
  );
  await settleUI();
  const offline = reopened.render().placement;
  assert.deepEqual(offline, initial);
  assert.equal(await reopened.poll(), offline, "An offline refresh retains the saved banner");

  unavailable = false;
  cached.delete(firstPath);
  assert.equal(
    await reopened.poll(),
    offline,
    "A 304 can restore an evicted file without moving the row",
  );
  assert.deepEqual(downloads, [[firstPath], [firstPath]]);

  etag = 'W/"b"';
  path = nextPath;
  buttonEnabled = false;
  const stage = deferred<void>();
  waitForArtwork = stage.promise;
  const staged = await reopened.poll();
  assert.equal(
    staged?.button.enabled,
    false,
    "The button switch is independent of the asset download",
  );
  assert.equal(staged?.banner, offline?.banner, "Slow replacement art leaves the old row intact");
  stage.resolve();
  await settleUI();
  assert.equal(reopened.render().placement?.banner.slides[0].image_url, localArtwork(nextPath));
  assert.equal(reopened.render().placement?.banner.slides[0].aspect_ratio, 2.5);
  assert.deepEqual(downloads, [[firstPath], [firstPath], [nextPath]]);

  const dariRequest = deferred<void>();
  waitForDari = dariRequest.promise;
  assert.equal(reopened.selectLocale("fa"), null, "An uncached locale never shows English artwork");
  await settleUI();
  assert.equal(reopened.selectLocale("ps"), null);
  await settleUI();
  const pashto = reopened.render().placement;
  assert.equal(pashto?.button.label, "اعلان وکړئ");
  assert.deepEqual(pashto?.banner.slides, [
    {
      image_url: localArtwork(pashtoPath),
      destination_url: "https://example.invalid/ps",
      aspect_ratio: 2.5,
    },
  ]);
  dariRequest.resolve();
  await settleUI();
  assert.equal(reopened.render().placement, pashto, "A late Dari response cannot replace Pashto");
  assert.equal(
    reopened.selectLocale("fa"),
    null,
    "An abandoned request must not publish its artwork",
  );
  await settleUI();
  const dari = reopened.render().placement;
  assert.equal(dari?.button.label, "تبلیغ کنید");
  assert.deepEqual(dari?.banner.slides, [
    {
      image_url: localArtwork(dariPath),
      destination_url: "https://example.invalid/fa",
      aspect_ratio: 2.5,
    },
  ]);
  unavailable = true;
  assert.equal(
    reopened.selectLocale("ps"),
    pashto,
    "Cached Pashto artwork survives an offline switch",
  );
  assert.equal(reopened.selectLocale("en")?.banner.slides[0].image_url, localArtwork(nextPath));
  assert.ok(cached.has(pashtoPath) && cached.has(dariPath) && cached.has(nextPath));
  await settleUI();

  unavailable = false;
  etag = 'W/"off"';
  bannerEnabled = false;
  const hidden = await reopened.poll();
  assert.deepEqual(hidden?.banner.slides, []);
  assert.equal(saved && JSON.parse(saved).locales.en.etag, etag);
  unavailable = true;
  assert.deepEqual(
    reopened.selectLocale("fa")?.banner.slides,
    [],
    "A confirmed global hide applies to offline language switches",
  );
  reopened.unmount();
}

async function sponsorCarouselChecks() {
  const hooks = uiHooks();
  const urls: string[] = [];
  const intervals = new Set<() => void>();
  let interactive = true;
  let finishTransition = () => {};
  let stops = 0;
  const component = compileUI(
    "../../components/SponsorBanner",
    {
      react: { ...hooks.react, useLayoutEffect: hooks.react.useEffect },
      "expo-router": { useIsFocused: () => true },
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        Animated: {
          View: "Track",
          Value: class {
            setValue() {}
            interpolate({ outputRange }: { outputRange: number[] }) {
              return outputRange;
            }
          },
          timing: (_offset: unknown, options: { toValue: number }) => ({
            start: (done: (state: { finished: boolean }) => void) => {
              assert.equal(options.toValue, 1);
              finishTransition = () => done({ finished: true });
            },
            stop() {
              stops++;
            },
          }),
        },
        AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
        Image: "Image",
        Linking: { openURL: async (url: string) => void urls.push(url) },
        Pressable: "Pressable",
        StyleSheet: { create: (styles: unknown) => styles, absoluteFill: { position: "absolute" } },
        View: "View",
      },
      "../lib/colors": compileUI("../colors", {}),
      "../lib/i18n": language,
      "../lib/reduced-motion": { useReducedMotion: () => false },
      "./Toast": { useToast: () => ({ push() {} }) },
    },
    {
      setInterval: (fn: () => void, delay: number) => {
        assert.equal(delay, 6_000);
        intervals.add(fn);
        return fn;
      },
      clearInterval: (fn: () => void) => intervals.delete(fn),
    },
  );
  const slides = ["one", "two"].map((id, index) => ({
    image_url: `https://api.example.invalid/${id}`,
    destination_url: `https://example.invalid/${id}`,
    aspect_ratio: index === 0 ? 6.4 : 2.5,
  }));
  const tree = hooks.render(() =>
    component.SponsorBanner({ slides, rotationSeconds: 6, separated: true, interactive }),
  );
  const frame = (root: typeof tree) =>
    nodes(root).find((node) => node.props.testID === "home-sponsor-banner-frame")!;
  const link = (root: typeof tree) =>
    nodes(root).find((node) => node.props.testID === "home-sponsor-banner")!;
  assert.equal(link(tree).props.disabled, true);
  assert.equal(flattenStyle(tree.props.style).borderBottomWidth, 1);
  const initialFrame = flattenStyle(frame(tree).props.style);
  assert.deepEqual(
    [initialFrame.width, initialFrame.aspectRatio],
    ["100%", 6.4],
    "The image fills the card at its own ratio before it decodes",
  );
  assert.equal(initialFrame.marginBottom, undefined);
  frame(tree).props.onLayout({ nativeEvent: { layout: { width: 352 } } });
  const images = nodes(tree).filter((node) => node.type === "Image");
  assert.equal(images.length, 2, "The next ad loads before rotation");
  assert.deepEqual(
    images.map((node) => node.props.style),
    [
      { width: "50%", aspectRatio: 6.4 },
      { width: "50%", aspectRatio: 2.5 },
    ],
  );
  assert.equal(
    nodes(tree).some((node) => node.type === "Text"),
    false,
  );
  images.forEach((image) => image.props.onLoad());
  const ready = hooks.render();
  const style = flattenStyle(frame(ready).props.style);
  assert.deepEqual(style.height, [352 / 6.4, 352 / 2.5]);
  await link(ready).props.onPress();
  intervals.forEach((rotate) => rotate());
  interactive = false;
  const covered = hooks.render();
  assert.equal(intervals.size, 0);
  assert.equal(stops, 0, "Opening an overlay leaves an in-flight slide intact");
  assert.equal(link(covered).props.disabled, true);
  await link(ready).props.onPress();
  assert.deepEqual(
    urls,
    [slides[0].destination_url],
    "A queued tap cannot open a link through an overlay",
  );
  finishTransition();
  assert.deepEqual(flattenStyle(frame(hooks.render()).props.style).height, [352 / 2.5, 352 / 6.4]);
  assert.equal(intervals.size, 0);
  interactive = true;
  const rotated = hooks.render();
  assert.deepEqual(flattenStyle(frame(rotated).props.style).height, [352 / 2.5, 352 / 6.4]);
  await link(rotated).props.onPress();
  assert.deepEqual(
    urls,
    slides.map((slide) => slide.destination_url),
  );
  nodes(hooks.tree)
    .filter((node) => node.type === "Image")
    .forEach((image) => image.props.onError());
  assert.equal(hooks.render(), null, "Failed images leave no empty ad row");
  assert.equal(intervals.size, 0);
}

async function main() {
  assert.equal(SUPPORT_SMS_E164, "+93781696644");
  assert.equal(
    SUPPORT_SMS_E164,
    SUPPORT_WHATSAPP_E164,
    "SMS uses the same verified public support recipient",
  );
  const untouched = fixture();
  assert.equal(untouched.imports, 0);
  assert.deepEqual(untouched.probes, [], "Importing support never resolves new native SMS code");

  for (const options of [
    { nativeMissing: true },
    { probeThrows: true },
    { importThrows: true },
    { available: false },
  ]) {
    const f = fixture(options);
    assert.equal(await f.api.openSupportSms("Synthetic support summary"), "unavailable");
    assert.equal(f.composers.length, 0);
    assert.equal(f.urls.length, 0, "Unavailable SMS never falls back to WhatsApp or a browser");
    if (options.nativeMissing || options.probeThrows) assert.equal(f.imports, 0);
  }

  const text = "Kaata diagnostic test\nVersion 2.2.4; errors=0";
  for (const result of ["unknown", "sent", "cancelled"] as const) {
    const f = fixture({ result });
    assert.equal(
      await f.api.openSupportSms(text),
      result === "cancelled" ? "cancelled" : "opened",
      "A composer outcome is never reported as delivery",
    );
    assert.deepEqual(f.probes, ["ExpoSMS"]);
    assert.equal(f.availabilityCalls, 1);
    assert.deepEqual(
      f.composers,
      [[[SUPPORT_SMS_E164], text]],
      "Only the OS composer receives the exact body and the existing support recipient, with no attachments",
    );
    assert.deepEqual(f.urls, []);
  }
  for (const options of [{ availabilityError: true }, { composerError: true }]) {
    const f = fixture(options);
    assert.equal(await f.api.openSupportSms(text), "failed");
    assert.equal(f.urls.length, 0);
  }

  const canceled = fixture();
  assert.equal(await canceled.api.openSupportSms(text, () => false), "cancelled");
  assert.deepEqual(canceled.probes, []);
  assert.equal(canceled.imports, 0);
  assert.equal(canceled.availabilityCalls, 0);
  let active = true;
  const loading = fixture();
  const loadingResult = loading.api.openSupportSms(text, () => active);
  active = false;
  assert.equal(await loadingResult, "cancelled");
  assert.equal(
    loading.availabilityCalls,
    0,
    "Leaving during lazy module loading prevents availability work and handoff",
  );

  const available = deferred<boolean>();
  const delayed = fixture({ availabilityGate: available.promise });
  active = true;
  const delayedResult = delayed.api.openSupportSms(text, () => active);
  for (let i = 0; i < 10 && !delayed.availabilityCalls; i++) await Promise.resolve();
  assert.equal(delayed.availabilityCalls, 1);
  active = false;
  available.resolve(true);
  assert.equal(await delayedResult, "cancelled");
  assert.equal(
    delayed.composers.length,
    0,
    "A late availability response cannot open a composer after leaving",
  );
  const composed = deferred<{ result: "unknown" }>();
  const afterOpen = fixture({ composerGate: composed.promise });
  active = true;
  const afterOpenResult = afterOpen.api.openSupportSms(text, () => active);
  for (let i = 0; i < 15 && !afterOpen.composers.length; i++) await Promise.resolve();
  assert.equal(afterOpen.composers.length, 1);
  active = false;
  composed.resolve({ result: "unknown" });
  assert.equal(
    await afterOpenResult,
    "cancelled",
    "A late composer outcome stays quiet after the screen leaves",
  );

  const direct = fixture();
  assert.equal(await direct.api.openSupportWhatsApp(text), "app");
  assert.equal(new URL(direct.urls[0]).searchParams.get("phone"), SUPPORT_WHATSAPP_E164.slice(1));
  assert.equal(new URL(direct.urls[0]).searchParams.get("text"), text);
  const fallback = fixture({
    openUrl: async (_url, count) => {
      if (count === 1) throw new Error("Synthetic absent WhatsApp");
    },
  });
  assert.equal(await fallback.api.openSupportWhatsApp(text), "web");
  assert.equal(new URL(fallback.urls[1]).pathname, "/" + SUPPORT_WHATSAPP_E164.slice(1));
  assert.equal(new URL(fallback.urls[1]).searchParams.get("text"), text);
  const noWhatsApp = fixture({
    openUrl: async () => {
      throw new Error("Synthetic unavailable browser");
    },
  });
  assert.equal(await noWhatsApp.api.openSupportWhatsApp(text), "failed");
  const inactiveWhatsApp = fixture();
  assert.equal(await inactiveWhatsApp.api.openSupportWhatsApp(text, () => false), "failed");
  assert.deepEqual(inactiveWhatsApp.urls, []);
  active = true;
  const departedWhatsApp = fixture({
    openUrl: async () => {
      active = false;
      throw new Error("Synthetic late failure");
    },
  });
  assert.equal(await departedWhatsApp.api.openSupportWhatsApp(text, () => active), "failed");
  assert.equal(
    departedWhatsApp.urls.length,
    1,
    "Leaving after an app-link failure prevents the browser fallback",
  );

  for (const locale of ["en", "fa", "ps"] as const) {
    const banner = sponsorButtonFixture({ locale });
    assert.equal(banner.tree.props.testID, "home-sponsor-button");
    const label = nodes(banner.tree).find((node) => node.type === "Text")!;
    assert.equal(label.props.children, language.t("sponsorBanner.promote"));
    assert.equal(label.props.numberOfLines, 1, "The promotion uses one line");
    const style = flattenStyle(banner.tree.props.style({ pressed: false }));
    assert.equal(style.minHeight, 44);
    assert.equal(style.backgroundColor, "#000000", "The promotion is black");
    assert.equal(banner.tree.props.accessibilityRole, "button");
    await banner.tree.props.onPress();
    assert.deepEqual(banner.routes, ["/promote"]);
    assert.deepEqual(banner.toasts, []);
  }

  const duplicate = sponsorButtonFixture();
  await duplicate.tree.props.onPress();
  await duplicate.tree.props.onPress();
  assert.equal(duplicate.routes.length, 1, "Repeated taps cannot open duplicate proposal forms");
  duplicate.blur();
  duplicate.focus();
  await duplicate.tree.props.onPress();
  assert.equal(duplicate.routes.length, 2, "Returning to Home restores the promotion action");

  let rejectNavigation = true;
  const failure = sponsorButtonFixture({
    push: () => {
      if (rejectNavigation) throw new Error("Synthetic navigation failure");
    },
  });
  await failure.tree.props.onPress();
  assert.deepEqual(failure.toasts, [[language.t("sponsorBanner.openFailed"), "error"]]);
  rejectNavigation = false;
  await failure.tree.props.onPress();
  assert.equal(failure.routes.length, 2, "A failed navigation can be retried");
  const blurred = sponsorButtonFixture();
  blurred.blur();
  await blurred.tree.props.onPress();
  assert.deepEqual(blurred.routes, [], "A departed Home screen cannot navigate");

  assert.equal(sponsorButtonFixture({ enabled: false }).tree, null);
  const coveredButton = sponsorButtonFixture({ interactive: false });
  assert.equal(coveredButton.tree.props.disabled, true);
  await coveredButton.tree.props.onPress();
  assert.deepEqual(coveredButton.routes, []);
  const custom = sponsorButtonFixture({ label: "Advertise with Kaata" });
  assert.equal(custom.tree.props.accessibilityLabel, "Advertise with Kaata");
  assert.equal(
    nodes(custom.tree).find((node) => node.type === "Text")?.props.children,
    "Advertise with Kaata",
  );
  await sponsorPlacementChecks();
  await sponsorCarouselChecks();
  console.log(
    "PASS support transports and independent promotion button: SMS outcomes, guarded WhatsApp support, EN/FA/PS defaults, label override, visibility, duplicate navigation and retry/focus guards",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
