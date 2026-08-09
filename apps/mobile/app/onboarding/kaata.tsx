import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
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
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { OptionSheet } from "../../components/OptionSheet";
import { NavRow } from "../../components/SettingsScreen";
import { updateAccountPhone } from "../../lib/auth";
import { colors } from "../../lib/colors";
import { CURRENCIES, DEFAULT_CURRENCY, getCurrencyName } from "../../lib/currency";
import { createSelfProfile, getAppMeta, setAppMeta } from "../../lib/db";
import { SETTINGS_ROW_PADDING_X } from "../../lib/design-tokens";
import { rowDir, textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { EventSigningUnavailableError } from "../../lib/event-log";
import { t } from "../../lib/i18n";
import { gutter, icon, space, TOUCH_MIN, typography } from "../../lib/tokens";

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
  // Currency is picked through a row→sheet, not a chip grid — see the NavRow
  // in the form below. Only the CONTROL changed; `currency` / setCurrency are
  // still what createSelfProfile() is called with.
  const [currencySheetVisible, setCurrencySheetVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Identity collected on the previous step, hydrated from app_meta on mount.
  const [selfName, setSelfName] = useState<string | null>(null);
  const [selfPhone, setSelfPhone] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const shopRef = useRef<TextInput>(null);
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
      // The game-style completion moment — celebrates AND teaches ("this is
      // your kaata: <shop name>"). onboarding_step is already 'done', so a
      // force-quit on the success screen just lands home on relaunch.
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

  async function onBack() {
    // Step back to the profile form. The stashed name/phone stay in app_meta
    // (harmless) and are overwritten when the user submits profile again.
    await setAppMeta("onboarding_step", "profile");
    router.replace("/onboarding/profile");
  }

  // Same trailing composition as vault/settings.tsx's currency row: symbol +
  // localized name, so "₨  Pakistani Rupee" reads to someone who doesn't know
  // the ISO codes. Built here (not in a memo) — it's two lookups per render.
  const currencyValue =
    `${CURRENCIES.find((c) => c.code === currency)?.symbol ?? ""}  ${getCurrencyName(currency)}`.trim();

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable
          onPress={onBack}
          hitSlop={10}
          disabled={busy}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons
            // icon.row (22), NOT icon.header (26) — labelled back control, same
            // as onboarding/profile.tsx. See the note there.
            name={isRTL ? "chevron-forward" : "chevron-back"}
            size={icon.row}
            color={colors.textEmphasis}
          />
          <Text style={[styles.backText, textDir(isRTL)]}>{t("onboardingMode.back")}</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.title, textDir(isRTL), trackingSafe(isRTL)]}>
            {t("onboardingKaata.title")}
          </Text>
          <Text style={[styles.subtitle, textDir(isRTL)]}>{t("onboardingKaata.subtitle")}</Text>

          <View style={styles.spacer} />

          <FormField
            ref={shopRef}
            label={t("onboardingKaata.name.label")}
            required
            value={shopName}
            editable={!busy}
            maxLength={NAME_MAX}
            autoCapitalize="words"
            placeholder={t("onboardingKaata.name.placeholder")}
            onChangeText={(s) => {
              setShopName(s);
              if (nameError) setNameError(null);
            }}
            error={nameError}
          />

          {/* Currency: row→sheet, IDENTICAL to the edit path (vault/settings.tsx)
              and to /vault/new. The old control was a 9-chip wrapping grid at
              ~36px tall — under the 44pt floor, and a mistap here silently
              mislabels every future amount in this kaata (lib/currency.ts
              relabels, it never converts), which is the worst possible place for
              a fat-finger: the shopkeeper's very first screen. NavRow clears the
              floor at 52px and the sheet gives each currency a full row. */}
          <View style={styles.currencyRowBleed}>
            <NavRow
              icon="cash-outline"
              label={t("onboardingKaata.currency.label")}
              trailing={currencyValue}
              // NavRow puts accessibilityLabel on the Pressable, which SUPPRESSES the
              // child text — so without this TalkBack announced only "Currency" and
              // never the selected value sitting in `trailing`. A blind user could not
              // hear which currency their ledger was about to be created in.
              accessibilityLabel={`${t("onboardingKaata.currency.label")}: ${currencyValue}`}
              onPress={() => setCurrencySheetVisible(true)}
              disabled={busy}
              isRTL={isRTL}
              isLast
            />
          </View>
          <Text style={[styles.fieldHint, textDir(isRTL)]}>
            {t("onboardingKaata.currency.hint")}
          </Text>

          {submitError ? (
            <Text style={[styles.submitError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {submitError}
            </Text>
          ) : null}

          <View style={{ height: 20 }} />
          <Button
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
          setCurrencySheetVisible(false);
          setCurrency(code);
        }}
        onDismiss={() => setCurrencySheetVisible(false)}
        isRTL={isRTL}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  header: {
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 4,
    flexDirection: "row",
    alignItems: "center",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    // ~40 computed (8+8 padding + a 15px label) — under the HIG floor.
    // alignItems already centres on this row's cross axis, so no
    // justifyContent needed. See onboarding/profile.tsx.
    minHeight: TOUCH_MIN,
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 2,
  },
  backText: { ...typography.label, color: colors.textSubtle },
  scrollContent: { flexGrow: 1, padding: gutter.hero, paddingTop: 12, paddingBottom: 48 },
  title: {
    // 22 collapsed onto the scale's heading (20), but keeping the BOLD cut —
    // heading's own family is sansSemi, and the onboarding steps share one
    // 700-weight headline voice. letterSpacing is the pre-existing optical
    // tightening; trackingSafe(isRTL) in the JSX cancels it for Persian, where
    // tracking would sever the joining.
    ...typography.heading,
    fontFamily: typography.display.fontFamily,
    color: colors.textEmphasis,
    letterSpacing: -0.4,
  },
  subtitle: { ...typography.body, color: colors.textSubtle, marginTop: space.sm },
  spacer: { height: 28 },
  fieldHint: { ...typography.hint, color: colors.textSubtle, marginTop: space.sm },
  submitError: {
    // bodySm's 13px at the label weight — an error line is emphasised body,
    // and bodySm's own family is sansRegular.
    ...typography.bodySm,
    fontFamily: typography.label.fontFamily,
    color: colors.danger,
    marginTop: space.lg,
  },
  // The currency row is a settings NavRow — it carries its own 20px gutter and
  // a full-width press surface — dropped into a hero-gutter (24px) form. Cancel
  // the hero gutter, then hand back the 4px difference so the row's icon+label
  // land on exactly the same left edge as the form fields above, while the
  // press surface still runs nearly edge to edge. (isLast on the row suppresses
  // the hairline divider: one lone rule under a single row reads as a mistake.)
  currencyRowBleed: {
    marginHorizontal: -gutter.hero,
    paddingHorizontal: gutter.hero - SETTINGS_ROW_PADDING_X,
  },
});
