// Actual transport helpers with synthetic native composer/Linking boundaries.
// Never opens another app, sends a message, or accesses the network.
import assert from "node:assert/strict";
import { SUPPORT_SMS_E164, SUPPORT_WHATSAPP_E164 } from "../../constants/env";
import type { SponsorBanner } from "../types";
import { compileUI, deferred, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

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

function bannerFixture(
  options: {
    locale?: "en" | "fa" | "ps";
    sponsor?: SponsorBanner;
    push?: (route: string, count: number) => void;
  } = {},
) {
  const locale = options.locale ?? "en";
  language.setLocale(locale);
  const hooks = uiHooks();
  const sponsorLinks: string[] = [];
  const routes: string[] = [];
  const toasts: unknown[][] = [];
  let blur = () => {};
  let focus = () => () => {};
  const component = compileUI("../../components/SponsorBanner", {
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
      Image: "Image",
      Pressable: "Pressable",
      Text: "Text",
      StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
      Linking: { openURL: async (url: string) => void sponsorLinks.push(url) },
    },
    "../lib/app-meta-context": { useAppMeta: () => ({ sponsorBanner: options.sponsor ?? null }) },
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
  const tree = hooks.render(() => component.SponsorBanner());
  return {
    tree,
    routes,
    sponsorLinks,
    toasts,
    blur: () => blur(),
    focus: () => {
      blur = focus();
    },
  };
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
    const banner = bannerFixture({ locale });
    assert.equal(banner.tree.props.testID, "home-sponsor-banner");
    assert.equal(
      banner.tree.props.disabled,
      false,
      "The promotion remains available without a campaign",
    );
    const label = nodes(banner.tree).find((node) => node.type === "Text")!;
    assert.equal(label.props.children, language.t("sponsorBanner.promote"));
    assert.equal(label.props.numberOfLines, 1, "The promotion uses one line");
    const style = flattenStyle(banner.tree.props.style({ pressed: false }));
    assert.equal(style.minHeight, 44);
    assert.equal(style.backgroundColor, "#000000", "The promotion is black");
    assert.equal(banner.tree.props.accessibilityRole, "button");
    await banner.tree.props.onPress();
    assert.deepEqual(banner.routes, ["/promote"]);
    assert.deepEqual(banner.sponsorLinks, []);
    assert.deepEqual(banner.toasts, []);
  }

  const duplicate = bannerFixture();
  await duplicate.tree.props.onPress();
  await duplicate.tree.props.onPress();
  assert.equal(duplicate.routes.length, 1, "Repeated taps cannot open duplicate proposal forms");
  duplicate.blur();
  duplicate.focus();
  await duplicate.tree.props.onPress();
  assert.equal(duplicate.routes.length, 2, "Returning to Home restores the promotion action");

  let rejectNavigation = true;
  const failure = bannerFixture({
    push: () => {
      if (rejectNavigation) throw new Error("Synthetic navigation failure");
    },
  });
  await failure.tree.props.onPress();
  assert.deepEqual(failure.toasts, [[language.t("sponsorBanner.openFailed"), "error"]]);
  rejectNavigation = false;
  await failure.tree.props.onPress();
  assert.equal(failure.routes.length, 2, "A failed navigation can be retried");
  const blurred = bannerFixture();
  blurred.blur();
  await blurred.tree.props.onPress();
  assert.deepEqual(blurred.routes, [], "A departed Home screen cannot navigate");

  const sponsor: SponsorBanner = {
    id: 1,
    sponsor: "Synthetic supplier",
    title: "Synthetic offer",
    body: "Synthetic details",
    image_url: null,
    cta_label: "View offer",
    cta_url: "https://example.invalid/offer",
    starts_at: "2026-11-01T00:00:00Z",
    ends_at: "2026-12-01T00:00:00Z",
  };
  const paid = bannerFixture({ sponsor });
  await paid.tree.props.onPress();
  assert.deepEqual(paid.sponsorLinks, [sponsor.cta_url]);
  assert.deepEqual(paid.routes, [], "An active sponsor retains its own destination");
  const information = bannerFixture({ sponsor: { ...sponsor, cta_label: null, cta_url: null } });
  assert.equal(information.tree.props.disabled, true);
  assert.equal(information.tree.props.accessibilityRole, "text");
  console.log(
    "PASS support transports and compact promotion strip: SMS outcomes, guarded WhatsApp support, EN/FA/PS black 44dp form invitation, duplicate navigation, retry/focus guards and active sponsor destinations",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
