// Preferences — Phase 7 unified design.
//
// Adopts the ProfileSettingsSheet design DNA so this page reads as a
// natural extension of the sheet rather than a foreign modal:
//   - SectionHeader (11/sansSemi/uppercase/letterSpacing 0.6/textSubtle)
//   - SectionGap (4px bgMuted bar with 12px top margin)
//   - NavRow (52px min, 20px horizontal padding, hairline divider)
//   - Header: card-presentation with a back chevron on the left, no
//     "Cancel" word — same affordance as iOS settings pages and the rest
//     of the redesigned vault/* surfaces.
//
// Sections, top to bottom:
//   1. LANGUAGE      — System default / English / دری
//   2. CURRENCY      — default currency for new Kaatas (per-Kaata override
//                      in /vault/settings)
//   3. REGION        — default country code for new contacts
//   4. APPEARANCE    — placeholder, disabled until theme support ships
//   5. NOTIFICATIONS — placeholder, disabled until push ships (Phase 8+)
//
// Auto-commit pattern (no Save button): tapping an option in the picker
// sheet writes app_meta + flips the in-memory module setter AND closes
// the sheet. The page re-renders with the new value on the spot.

import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { CountryPickerSheet } from "../components/CountryPickerSheet";
import { NavRow, ScreenHeader, SectionGap, SectionHeader } from "../components/SettingsScreen";
import { useToast } from "../components/Toast";
import { colors } from "../lib/colors";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  getCurrencyName,
  getCurrentCurrencyCode,
  setCurrentCurrency,
} from "../lib/currency";
import { getAppMeta, setAppMeta } from "../lib/db";
import {
  SETTINGS_ROW_LABEL_FONT_SIZE,
  SETTINGS_ROW_MIN_HEIGHT,
  SETTINGS_ROW_PADDING_X,
  SETTINGS_ROW_PADDING_Y,
  SETTINGS_SECTION_HEADER_FONT_SIZE,
  SETTINGS_SECTION_HEADER_LETTER_SPACING,
  SETTINGS_SECTION_HEADER_PADDING_BOTTOM,
  SETTINGS_SECTION_HEADER_PADDING_TOP,
  SETTINGS_SHEET_TOP_RADIUS,
} from "../lib/design-tokens";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { type LocalePref, setLocale, t } from "../lib/i18n";
import {
  getCountry,
  getCurrentDefaultCountryCode,
  setCurrentDefaultCountryCode,
} from "../lib/phone";

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: LocalePref; labelKey: string }> = [
  { value: "system", labelKey: "settings.language.option.system" },
  { value: "en", labelKey: "settings.language.option.en" },
  { value: "fa", labelKey: "settings.language.option.fa" },
];

export default function PreferencesScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const insets = useSafeAreaInsets();

  const [loaded, setLoaded] = useState(false);
  const [localePref, setLocalePref] = useState<LocalePref>("system");
  const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY);
  const [countryCode, setCountryCode] = useState<string>("AF");

  const [langSheetVisible, setLangSheetVisible] = useState(false);
  const [currencySheetVisible, setCurrencySheetVisible] = useState(false);
  const [countrySheetVisible, setCountrySheetVisible] = useState(false);

  useEffect(() => {
    (async () => {
      const storedPref = await getAppMeta("locale_pref");
      const pref: LocalePref = storedPref === "en" || storedPref === "fa" ? storedPref : "system";
      setLocalePref(pref);
      setCurrency(getCurrentCurrencyCode());
      setCountryCode(getCurrentDefaultCountryCode());
      setLoaded(true);
    })();
  }, []);

  async function pickLanguage(value: LocalePref) {
    setLangSheetVisible(false);
    if (value === localePref) return;
    setLocalePref(value);
    setLocale(value);
    await setAppMeta("locale_pref", value);
    toast.push(t("settings.language.changed"), "success");
  }

  async function pickCurrency(code: string) {
    setCurrencySheetVisible(false);
    if (code === currency) return;
    setCurrency(code);
    setCurrentCurrency(code);
    await setAppMeta("default_currency", code);
    toast.push(t("settings.currency.changed"), "success");
  }

  async function pickCountry(code: string) {
    setCountrySheetVisible(false);
    if (code === countryCode) return;
    setCountryCode(code);
    setCurrentDefaultCountryCode(code);
    await setAppMeta("default_country_code", code);
    toast.push(t("preferences.country.changed"), "success");
  }

  if (!loaded) return null;

  const selectedLangLabelKey =
    LANGUAGE_OPTIONS.find((o) => o.value === localePref)?.labelKey ??
    "settings.language.option.system";
  const languageValue = t(selectedLangLabelKey as Parameters<typeof t>[0]);

  const currencyEntry = CURRENCIES.find((c) => c.code === currency);
  const currencyValue = currencyEntry
    ? `${currencyEntry.symbol}  ${getCurrencyName(currency)}`
    : currency;

  const country = getCountry(countryCode);
  const countryValue = `${country.flag}  ${country.name}`;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader
        title={t("preferences.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 + insets.bottom * 0.25 }}
      >
        {/* ============ LANGUAGE ============ */}
        <SectionHeader label={t("settings.language.label")} isRTL={isRTL} />
        <NavRow
          icon="language-outline"
          label={t("settings.language.label")}
          trailing={languageValue}
          onPress={() => setLangSheetVisible(true)}
          isRTL={isRTL}
          isLast
        />

        <SectionGap />

        {/* ============ CURRENCY ============ */}
        <SectionHeader label={t("preferences.currency.section")} isRTL={isRTL} />
        <NavRow
          icon="cash-outline"
          label={t("settings.currency.label")}
          hint={t("preferences.currency.defaultHint")}
          trailing={currencyValue}
          onPress={() => setCurrencySheetVisible(true)}
          isRTL={isRTL}
          isLast
        />

        <SectionGap />

        {/* ============ REGION ============ */}
        <SectionHeader label={t("preferences.region.section")} isRTL={isRTL} />
        <NavRow
          icon="flag-outline"
          label={t("preferences.country.label")}
          hint={t("preferences.country.hint")}
          trailing={countryValue}
          onPress={() => setCountrySheetVisible(true)}
          isRTL={isRTL}
          isLast
        />

        <SectionGap />

        {/* ============ APPEARANCE (placeholder) ============
            Theme toggle isn't shipped yet — the app is hard-coded light.
            Row renders disabled with a "Coming soon" trailing so users
            know the slot exists. When dark mode lands, drop the disabled
            flag and wire up an OptionSheet (Light / Dark / System) using
            the same pattern as language. */}
        <SectionHeader label={t("preferences.appearance.section")} isRTL={isRTL} />
        <NavRow
          icon="color-palette-outline"
          label={t("preferences.appearance.theme")}
          hint={t("preferences.appearance.themeHint")}
          trailing={t("preferences.comingSoon")}
          onPress={() => {}}
          isRTL={isRTL}
          disabled
          isLast
        />

        <SectionGap />

        {/* ============ NOTIFICATIONS (placeholder) ============
            Push notifications aren't shipped yet. Phase 8+. */}
        <SectionHeader label={t("preferences.notifications.section")} isRTL={isRTL} />
        <NavRow
          icon="notifications-outline"
          label={t("preferences.notifications.reminders")}
          hint={t("preferences.notifications.remindersHint")}
          trailing={t("preferences.comingSoon")}
          onPress={() => {}}
          isRTL={isRTL}
          disabled
          isLast
        />
      </ScrollView>

      <OptionSheet
        visible={langSheetVisible}
        title={t("settings.language.label")}
        options={LANGUAGE_OPTIONS.map((o) => ({
          key: o.value,
          label: t(o.labelKey as Parameters<typeof t>[0]),
        }))}
        selected={localePref}
        onSelect={(k) => pickLanguage(k as LocalePref)}
        onDismiss={() => setLangSheetVisible(false)}
        isRTL={isRTL}
      />
      <OptionSheet
        visible={currencySheetVisible}
        title={t("settings.currency.label")}
        options={CURRENCIES.map((c) => ({
          key: c.code,
          label: getCurrencyName(c.code),
          leading: c.symbol,
        }))}
        selected={currency}
        onSelect={pickCurrency}
        onDismiss={() => setCurrencySheetVisible(false)}
        isRTL={isRTL}
      />
      <CountryPickerSheet
        visible={countrySheetVisible}
        selectedCode={countryCode}
        onSelect={pickCountry}
        onDismiss={() => setCountrySheetVisible(false)}
      />
    </SafeAreaView>
  );
}

// --------------------------------------------------------------------------
// OptionSheet — picker bottom sheet used for language / currency. Same
// chrome as BottomSheet.tsx (OFFSCREEN=600, friction/tension, hairline
// dividers, BlurView scrim, 220ms exit defer constant).
// --------------------------------------------------------------------------

const SHEET_OFFSCREEN = 600;
const SHEET_EXIT_MS = 220;

type Option = { key: string; label: string; leading?: string };

function OptionSheet(props: {
  visible: boolean;
  title: string;
  options: ReadonlyArray<Option>;
  selected: string;
  onSelect: (key: string) => void;
  onDismiss: () => void;
  isRTL: boolean;
}) {
  const { visible, title, options, selected, onSelect, onDismiss, isRTL } = props;
  const [rendered, setRendered] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(SHEET_OFFSCREEN)).current;

  useEffect(() => {
    if (visible) {
      setRendered(true);
      requestAnimationFrame(() => {
        Animated.parallel([
          Animated.timing(opacity, {
            toValue: 1,
            duration: 220,
            useNativeDriver: true,
          }),
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            friction: 11,
            tension: 75,
          }),
        ]).start();
      });
    } else if (rendered) {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: SHEET_OFFSCREEN,
          duration: SHEET_EXIT_MS,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!rendered) return null;

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onDismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <BlurView
          intensity={20}
          tint="light"
          experimentalBlurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.sheetTint} />
        <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      </Animated.View>

      <Animated.View
        style={[styles.sheetContainer, { transform: [{ translateY }] }]}
        pointerEvents="box-none"
      >
        <SafeAreaView
          edges={["bottom"]}
          // Numeric maxHeight — percentage strings against position:absolute
          // parents with no explicit height are undefined in RN. Concrete
          // pixel cap. Same fix as ProfileSettingsSheet / VaultPickerSheet.
          style={[styles.sheetWrap, { maxHeight: Dimensions.get("window").height * 0.75 }]}
        >
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetGrabber} />
            <Text style={[styles.sheetTitle, textDir(isRTL)]}>{title}</Text>
            <ScrollView
              showsVerticalScrollIndicator={false}
              bounces={false}
              contentContainerStyle={{ paddingBottom: 8 }}
            >
              {options.map((o, i) => {
                const isSelected = o.key === selected;
                return (
                  <Pressable
                    key={o.key}
                    onPress={() => onSelect(o.key)}
                    accessibilityRole="button"
                    accessibilityLabel={o.label}
                    accessibilityState={{ selected: isSelected }}
                    style={({ pressed }) => [
                      styles.sheetRow,
                      rowDir(isRTL),
                      i !== options.length - 1 && styles.sheetRowDivider,
                      pressed && { backgroundColor: colors.bgMuted },
                    ]}
                  >
                    <View style={[styles.sheetRowLeft, rowDir(isRTL)]}>
                      {o.leading ? <Text style={styles.sheetRowLeading}>{o.leading}</Text> : null}
                      <Text style={[styles.sheetRowLabel, textDir(isRTL)]}>{o.label}</Text>
                    </View>
                    {isSelected ? (
                      <Ionicons name="checkmark" size={18} color={colors.textEmphasis} />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },

  // OptionSheet ------------------------------------------------------------
  sheetTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.08)",
  },
  sheetContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopRightRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  sheet: {
    paddingTop: 8,
    paddingBottom: 0,
    flexShrink: 1,
  },
  sheetGrabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderEmphasis,
    marginBottom: 4,
  },
  sheetTitle: {
    fontSize: SETTINGS_SECTION_HEADER_FONT_SIZE,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: SETTINGS_SECTION_HEADER_PADDING_TOP,
    paddingBottom: SETTINGS_SECTION_HEADER_PADDING_BOTTOM,
    textTransform: "uppercase",
    letterSpacing: SETTINGS_SECTION_HEADER_LETTER_SPACING,
  },
  sheetRow: {
    minHeight: SETTINGS_ROW_MIN_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: SETTINGS_ROW_PADDING_Y,
  },
  sheetRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  sheetRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  sheetRowLeading: {
    fontSize: 18,
    fontFamily: fonts.monoSemi,
    color: colors.textEmphasis,
    minWidth: 28,
  },
  sheetRowLabel: {
    fontSize: SETTINGS_ROW_LABEL_FONT_SIZE,
    fontFamily: fonts.sansMedium,
    color: colors.textEmphasis,
    flexShrink: 1,
  },
});
