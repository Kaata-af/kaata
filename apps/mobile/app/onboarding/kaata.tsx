import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { KaataConceptCard } from "../../components/KaataConceptCard";
import { updateAccountPhone } from "../../lib/auth";
import { colors } from "../../lib/colors";
import { CURRENCIES, DEFAULT_CURRENCY, getCurrencyName } from "../../lib/currency";
import { createSelfProfile, getAppMeta, setAppMeta } from "../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { EventSigningUnavailableError } from "../../lib/event-log";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";

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

  const currencyOptions = useMemo(() => CURRENCIES.map((c) => c.code), []);

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
  // concept card above the form is the one moment we teach "kaata = your whole
  // shop, tallies live inside it", and an auto-opened keyboard would cover it.
  // The user taps the field themselves after reading. (Data behind this:
  // most early users created a tally contact where they should have created
  // their kaata — the mental model needs the few seconds of screen time.)

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
      // This user just saw the concept card above — mark the one-time home
      // guide sheet (KaataGuideSheet) as already-covered so it only ever
      // shows to users who onboarded BEFORE the card existed (or who arrived
      // via restore/invite and skipped this screen).
      await setAppMeta("kaata_guide_seen", "1");
      // Clear the onboarding scratch values now that they're persisted into
      // the self user + vault.
      await setAppMeta("onboarding_self_name", "");
      await setAppMeta("onboarding_self_phone", "");
      await setAppMeta("onboarding_pending_name", "");
      await setAppMeta("onboarding_pending_email", "");
      await setAppMeta("onboarding_pending_phone", "");
      router.replace("/");
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
            name={isRTL ? "chevron-forward" : "chevron-back"}
            size={22}
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
          <Text style={[styles.title, textDir(isRTL)]}>{t("onboardingKaata.title")}</Text>
          <Text style={[styles.subtitle, textDir(isRTL)]}>{t("onboardingKaata.subtitle")}</Text>

          <View style={{ height: 18 }} />
          {/* The kaata-vs-tally mental-model diagram. Teaching at the exact
              moment of naming — users who read "kaata" as one person's tab
              typed a customer name here. See KaataConceptCard for context. */}
          <KaataConceptCard />

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

          <Text style={[styles.label, textDir(isRTL)]}>{t("onboardingKaata.currency.label")}</Text>
          <View style={[styles.currencyRow, rowDir(isRTL)]}>
            {currencyOptions.map((code) => {
              const selected = code === currency;
              const entry = CURRENCIES.find((c) => c.code === code);
              return (
                <Pressable
                  key={code}
                  onPress={() => setCurrency(code)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`${code} — ${getCurrencyName(code)}`}
                  style={({ pressed }) => [
                    styles.currencyChip,
                    selected && styles.currencyChipSelected,
                    busy && { opacity: 0.5 },
                    pressed && !selected && { backgroundColor: colors.bgMuted },
                  ]}
                >
                  <Text
                    style={[styles.currencyChipText, selected && styles.currencyChipTextSelected]}
                  >
                    {code}
                    {entry ? `  ${entry.symbol}` : ""}
                  </Text>
                </Pressable>
              );
            })}
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
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 2,
  },
  backText: { fontSize: 15, fontFamily: fonts.sansMedium, color: colors.textSubtle },
  scrollContent: { flexGrow: 1, padding: 24, paddingTop: 12, paddingBottom: 48 },
  title: {
    fontSize: 22,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 8,
    lineHeight: 20,
  },
  spacer: { height: 28 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 8,
    lineHeight: 17,
  },
  submitError: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 16,
  },
  currencyRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  currencyChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    backgroundColor: colors.bgDefault,
  },
  currencyChipSelected: { borderColor: colors.textEmphasis, backgroundColor: colors.bgInverted },
  currencyChipText: { fontSize: 13, fontFamily: fonts.monoMedium, color: colors.textEmphasis },
  currencyChipTextSelected: { color: colors.textInverted },
});
