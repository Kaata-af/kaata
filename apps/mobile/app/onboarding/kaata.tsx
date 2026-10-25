import type { TextInputInstance } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { FormField } from "../../components/FormField";
import {
  OnboardingAction,
  OnboardingHeader,
  OnboardingIntro,
  onboardingStyles,
} from "../../components/Onboarding";
import { OptionSheet } from "../../components/OptionSheet";
import { getSessionJWT, updateAccountPhone } from "../../lib/auth";
import { colors } from "../../lib/colors";
import { CURRENCIES, DEFAULT_CURRENCY, getCurrencyName } from "../../lib/currency";
import { createSelfProfile, getAppMeta, setAppMeta } from "../../lib/db";
import { bidiIsolate, rowDir, textDir, useIsRTL } from "../../lib/direction";
import { EventSigningUnavailableError } from "../../lib/event-log";
import { t } from "../../lib/i18n";
import { fetchTabPreview } from "../../lib/tabs/link";
import { icon, typography } from "../../lib/tokens";
import { useOnboardingKeyboardScroll } from "../../lib/use-onboarding-keyboard-scroll";

// Onboarding final step — create the shopkeeper's first kaata (their shop's
// ledger book). The personal-profile step (name + phone) stashed those values
// in app_meta and advanced onboarding_step to 'kaata'; here we collect the
// SHOP name + currency and call createSelfProfile(name, shop, phone, currency),
// which atomically writes the local-self user AND mints the default vault.
//
// Why self-creation is DEFERRED to this screen (not done on the profile step):
// hasOnboarded is derived from "a local_self row exists" and short-circuits
// routing straight to home. If the profile step created the self, the user
// would already count as onboarded and routing would skip this step. By
// minting self + vault together HERE, the invariant
//   self exists  <=>  onboarded  <=>  has a kaata
// holds, so a fresh account ALWAYS lands on home with a kaata — no more
// confusing "create a kaata" empty state as the first thing a new user sees.
//
// Identity is read from app_meta (resume-safe across a force-quit) rather than
// route params (which are lost on relaunch). If the stashed name is missing we
// bail back to the profile step instead of minting a nameless self.

const NAME_MAX = 50;

export default function OnboardingKaataScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();

  const [shopName, setShopName] = useState("");
  const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY);
  // The field opens the same picker used when editing a kaata.
  const [currencySheetVisible, setCurrencySheetVisible] = useState(false);
  // Mutual-tab handoff (docs/mutual-tab-design.md §4.4, D9): a link followed
  // before this install had a kaata stashed pending_tab_token (app/t/[token])
  // and sent the user through onboarding; THIS is the screen that mints the
  // kaata the tab will join, so it should be minted in the tab's currency
  // rather than the AFN default that bounced the user straight back to "you
  // need a USD kaata". Preset from the background read below; the row stays
  // changeable, a pick made before it resolves wins (currencyDirtyRef), and
  // the hint names the shared account only while the row shows its currency.
  const [presetCurrency, setPresetCurrency] = useState<string | null>(null);
  const currencyDirtyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Identity collected on the previous step, hydrated from app_meta on mount.
  const [selfName, setSelfName] = useState<string | null>(null);
  const [selfPhone, setSelfPhone] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const shopRef = useRef<TextInputInstance>(null);
  const { scrollProps, focusInput, blurInput } = useOnboardingKeyboardScroll();
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx. Without it a
  // double-tap mints two selves/vaults.
  const savingRef = useRef(false);

  useEffect(() => {
    (async () => {
      const [name, phone] = await Promise.all([
        getAppMeta("onboarding_self_name"),
        getAppMeta("onboarding_self_phone"),
      ]);
      setSelfName((name ?? "").trim() || null);
      setSelfPhone((phone ?? "").trim() || null);
      setLoaded(true);
    })();
  }, []);

  // The pending tab's currency, in the background: never blocks the form and
  // swallows every failure (no session yet, offline, a dead link) — the row
  // simply keeps its default. The preview needs the session JWT the auth step
  // just created. A currency already stashed by the join screen presets the
  // row at once; the fetched one is then stashed too, so vault/new can reuse
  // it without a second round trip.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getAppMeta("pending_tab_token");
        if (!token || cancelled) return;
        const stashed = await getAppMeta("pending_tab_currency");
        if (cancelled) return;
        if (stashed && CURRENCIES.some((c) => c.code === stashed) && !currencyDirtyRef.current) {
          setCurrency(stashed);
          setPresetCurrency(stashed);
        }
        if (!(await getSessionJWT())) return;
        const preview = await fetchTabPreview(token);
        if (cancelled) return;
        const code = preview.tab.currency;
        if (!CURRENCIES.some((c) => c.code === code)) return;
        await setAppMeta("pending_tab_currency", code);
        if (cancelled || currencyDirtyRef.current) return;
        setCurrency(code);
        setPresetCurrency(code);
      } catch (err) {
        console.warn("[onboarding/kaata] pending tab preview failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // If we reached this step without a stashed name (app_meta cleared
  // out-of-band, deep-link straight here, etc.) don't strand the user on a
  // screen that can't complete — send them back to the profile step.
  useEffect(() => {
    if (loaded && !selfName) {
      void setAppMeta("onboarding_step", "profile");
      router.replace("/onboarding/profile");
    }
  }, [loaded, selfName, router]);

  // Deliberately NO auto-focus on this screen (unlike the profile step): the
  // subtitle is where "kaata = your whole shop's book" lands, and an
  // auto-opened keyboard pushes it half off-screen before it's read. The user
  // taps the field themselves. (Data behind this: most early users created a
  // tally contact where they should have created their kaata — the concept
  // needs its few seconds of screen time before the naming happens.)

  async function onCreate() {
    if (savingRef.current) return;
    const trimmedShop = shopName.trim();
    if (!trimmedShop) {
      setNameError(t("onboardingKaata.name.required"));
      shopRef.current?.focus();
      return;
    }
    // Guarded by the bail-out effect above; also narrows selfName to string
    // for the createSelfProfile call below.
    if (!selfName) return;
    setNameError(null);
    savingRef.current = true;
    setCurrencySheetVisible(false);
    setSubmitError(null);
    setBusy(true);
    try {
      // Atomic: writes the local-self user AND mints the default vault (trust
      // anchor, shop_profile, genesis vault_member_added event). This is what
      // flips hasOnboarded true, so it must succeed BEFORE we mark onboarding
      // done + navigate home.
      await createSelfProfile(selfName, trimmedShop, selfPhone, currency);
      // Best-effort: back the phone up to the account so it survives a
      // reinstall (signed-in only; no-op offline). Lives here, not on the
      // profile step, because the self is created here.
      void updateAccountPhone(selfPhone ?? null);
      await setAppMeta("onboarding_step", "done");
      // Clear the onboarding scratch values now that they're persisted into
      // the self user + vault.
      await setAppMeta("onboarding_self_name", "");
      await setAppMeta("onboarding_self_phone", "");
      await setAppMeta("onboarding_pending_name", "");
      await setAppMeta("onboarding_pending_email", "");
      await setAppMeta("onboarding_pending_phone", "");
      // Confirm the kaata that was created. onboarding_step is already 'done', so a
      // force-quit on the success screen just lands home on relaunch.
      Keyboard.dismiss();
      router.replace({
        pathname: "/onboarding/success",
        params: { name: trimmedShop },
      });
    } catch (err) {
      console.warn("[onboarding/kaata] createSelfProfile failed", err);
      // Mythos Fix Set C: signing-unavailable gets an actionable message.
      if (err instanceof EventSigningUnavailableError) {
        setSubmitError(t("entry.signingUnavailable"));
      } else {
        setSubmitError(t("entry.saveFailed"));
      }
      savingRef.current = false;
      setBusy(false);
    }
  }

  const onBack = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setSubmitError(null);
    setCurrencySheetVisible(false);
    Keyboard.dismiss();
    // Step back to the profile form. The stashed name/phone stay in app_meta
    // (harmless) and are overwritten when the user submits profile again.
    try {
      await setAppMeta("onboarding_step", "profile");
      router.replace("/onboarding/profile");
    } catch (err) {
      console.warn("[onboarding/kaata] returning to profile failed", err);
      savingRef.current = false;
      setBusy(false);
      setSubmitError(t("entry.saveFailed"));
    }
  }, [router]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        void onBack();
        return true;
      });
      return () => subscription.remove();
    }, [onBack]),
  );

  // Same trailing composition as vault/settings.tsx's currency row: symbol +
  // localized name, so "₨  Pakistani Rupee" reads to someone who doesn't know
  // the ISO codes. Built here (not in a memo) — it's two lookups per render.
  const currencyValue =
    `${CURRENCIES.find((c) => c.code === currency)?.symbol ?? ""}  ${getCurrencyName(currency)}`.trim();

  return (
    <SafeAreaView style={onboardingStyles.screen}>
      <OnboardingHeader onBack={onBack} disabled={busy} />

      <KeyboardAvoidingView
        style={styles.form}
        // Android draws edge-to-edge, so adjustResize no longer shrinks the
        // window: without this the currency row and Create sit under the
        // keyboard with nothing to scroll (2.0.0 had it). Inert on iOS, whose
        // ScrollView insets already compensate (see the hook); enabled there it
        // would also arm a stray LayoutAnimation on every keyboard show.
        behavior="height"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          {...scrollProps}
          style={styles.form}
          contentContainerStyle={onboardingStyles.content}
          showsVerticalScrollIndicator={false}
        >
          <OnboardingIntro
            title={t("onboardingKaata.title")}
            description={t("onboardingKaata.subtitle")}
          />

          <FormField
            ref={shopRef}
            onFocus={() => focusInput(shopRef.current)}
            onBlur={() => blurInput(shopRef.current)}
            label={t("onboardingKaata.name.label")}
            required
            value={shopName}
            editable={!busy}
            maxLength={NAME_MAX}
            autoCapitalize="words"
            placeholder={t("onboardingKaata.name.placeholder")}
            style={styles.input}
            onChangeText={(s) => {
              setShopName(s);
              if (nameError) setNameError(null);
            }}
            error={nameError}
          />

          <View>
            <Text style={[styles.fieldLabel, textDir(isRTL)]}>
              {t("onboardingKaata.currency.label")}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t("onboardingKaata.currency.label")}: ${currencyValue}`}
              accessibilityState={{ disabled: busy, expanded: currencySheetVisible }}
              onPress={() => {
                if (savingRef.current) return;
                Keyboard.dismiss();
                setCurrencySheetVisible(true);
              }}
              disabled={busy}
              style={({ pressed }) => [
                styles.currencyField,
                rowDir(isRTL),
                pressed && styles.currencyFieldPressed,
                busy && styles.disabled,
              ]}
            >
              <Text style={[styles.currencyValue, textDir(isRTL)]}>{currencyValue}</Text>
              <Ionicons name="chevron-down" size={icon.trailing} color={colors.textSubtle} />
            </Pressable>
            {/* ONE hint under the row: the shared-account line replaces the
              generic one while the row still shows the preset currency (the
              ISO code is a Latin token in Dari prose — isolate it). */}
            <Text style={[styles.fieldHint, textDir(isRTL)]}>
              {presetCurrency && currency === presetCurrency
                ? t("tab.join.currencyPreset", { currency: bidiIsolate(presetCurrency) })
                : t("onboardingKaata.currency.hint")}
            </Text>
          </View>

          {submitError ? (
            <Text style={[styles.submitError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {submitError}
            </Text>
          ) : null}

          <View style={styles.actionSpace} />
          <OnboardingAction
            label={t("onboardingKaata.submit")}
            onPress={onCreate}
            disabled={busy || shopName.trim().length === 0}
            loading={busy}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Currency picker — same sheet, same option list and same selection tick
          as /vault/new and vault/settings. */}
      <OptionSheet
        visible={currencySheetVisible}
        title={t("onboardingKaata.currency.label")}
        options={CURRENCIES.map((c) => ({
          key: c.code,
          label: getCurrencyName(c.code),
          leading: c.symbol,
        }))}
        selected={currency}
        onSelect={(code) => {
          if (savingRef.current) return;
          setCurrencySheetVisible(false);
          currencyDirtyRef.current = true;
          setCurrency(code);
        }}
        onDismiss={() => setCurrencySheetVisible(false)}
        isRTL={isRTL}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  form: { flex: 1 },
  input: { minHeight: 52, borderRadius: 12 },
  fieldLabel: {
    ...typography.label,
    color: colors.textDefault,
    marginBottom: 8,
  },
  currencyField: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    backgroundColor: colors.bgDefault,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: "center",
    gap: 12,
  },
  currencyFieldPressed: { backgroundColor: colors.bgMuted },
  currencyValue: {
    ...typography.body,
    color: colors.textEmphasis,
    flex: 1,
  },
  disabled: { opacity: 0.5 },
  fieldHint: { ...typography.hint, color: colors.textSubtle, marginTop: 8 },
  actionSpace: { height: 28 },
  submitError: {
    ...typography.bodySm,
    fontFamily: typography.label.fontFamily,
    color: colors.danger,
    marginTop: 16,
  },
});
