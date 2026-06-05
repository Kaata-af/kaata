import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/colors";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  getCurrencyName,
  getCurrentCurrencyCode,
  setCurrentCurrency,
} from "../lib/currency";
import { getAppMeta, setAppMeta } from "../lib/db";
import { CountryPickerSheet } from "../components/CountryPickerSheet";
import { useToast } from "../components/Toast";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { type LocalePref, setLocale, t } from "../lib/i18n";
import {
  getCountry,
  getCurrentDefaultCountryCode,
  setCurrentDefaultCountryCode,
} from "../lib/phone";

// Preferences — language + currency.
//
// Auto-commit pattern (no Save button): tapping an option in the picker
// sheet immediately writes app_meta + calls the in-memory module setter
// (setLocale / setCurrentCurrency) AND closes the sheet. The screen
// re-renders in the new language / currency on the spot.

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: LocalePref; labelKey: string }> = [
  { value: "system", labelKey: "settings.language.option.system" },
  { value: "en", labelKey: "settings.language.option.en" },
  { value: "fa", labelKey: "settings.language.option.fa" },
];

export default function PreferencesScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
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
      // Country: read from the module-global which was hydrated at app
      // start via initDefaultCountryFromPref in _layout.tsx. No need to
      // re-read app_meta here — the global is the source of truth.
      setCountryCode(getCurrentDefaultCountryCode());
      setLoaded(true);
    })();
  }, []);

  async function pickLanguage(value: LocalePref) {
    setLocalePref(value);
    setLangSheetVisible(false);
    if (value !== localePref) {
      setLocale(value);
      await setAppMeta("locale_pref", value);
      // Toast fires in the NEW locale (setLocale already swapped the
      // module-global), so users get confirmation in their just-picked
      // language. Visual re-render of every t() call elsewhere is the
      // primary signal; the toast just confirms "yes, this stuck."
      toast.push(t("settings.language.changed"), "success");
    }
  }

  async function pickCurrency(code: string) {
    setCurrency(code);
    setCurrencySheetVisible(false);
    if (code !== currency) {
      setCurrentCurrency(code);
      await setAppMeta("default_currency", code);
      // Currency changes are less visible (only show on amount displays)
      // so the toast is more important here than for language.
      toast.push(t("settings.currency.changed"), "success");
    }
  }

  async function pickCountry(code: string) {
    setCountryCode(code);
    setCountrySheetVisible(false);
    if (code !== countryCode) {
      setCurrentDefaultCountryCode(code);
      await setAppMeta("default_country_code", code);
      toast.push(t("preferences.country.changed"), "success");
    }
  }

  if (!loaded) return null;

  const selectedLangLabelKey =
    LANGUAGE_OPTIONS.find((o) => o.value === localePref)?.labelKey ??
    "settings.language.option.system";

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("preferences.title")}</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <SelectField
          label={t("settings.language.label")}
          // selectedLangLabelKey is a runtime-computed string; t() expects
          // a literal key union. Casting to the union is safe because the
          // value is always one of the three known LANGUAGE_OPTIONS keys.
          value={t(selectedLangLabelKey as Parameters<typeof t>[0])}
          onPress={() => setLangSheetVisible(true)}
          isRTL={isRTL}
        />
        <SelectField
          label={t("settings.currency.label")}
          value={`${findSymbol(currency)}  ${getCurrencyName(currency)}`}
          onPress={() => setCurrencySheetVisible(true)}
          isRTL={isRTL}
          hint={t("settings.currency.hint")}
        />
        <SelectField
          label={t("preferences.country.label")}
          value={(() => {
            const c = getCountry(countryCode);
            return `${c.flag}  ${c.name} (${c.dialCode})`;
          })()}
          onPress={() => setCountrySheetVisible(true)}
          isRTL={isRTL}
          hint={t("preferences.country.hint")}
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

function findSymbol(code: string): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? "";
}

function SelectField(props: {
  label: string;
  value: string;
  onPress: () => void;
  isRTL: boolean;
  hint?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, textDir(props.isRTL)]}>{props.label}</Text>
      <Pressable
        onPress={props.onPress}
        style={({ pressed }) => [
          styles.selectField,
          rowDir(props.isRTL),
          pressed && { backgroundColor: colors.bgMuted },
        ]}
      >
        <Text style={[styles.selectValue, textDir(props.isRTL)]} numberOfLines={1}>
          {props.value}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
      {props.hint ? (
        <Text style={[styles.fieldHint, textDir(props.isRTL)]}>{props.hint}</Text>
      ) : null}
    </View>
  );
}

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
          Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
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
        Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
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
        <SafeAreaView edges={["bottom"]} style={styles.sheetWrap}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetGrabber} />
            <Text style={[styles.sheetTitle, textDir(isRTL)]}>{title}</Text>
            <View style={styles.sheetList}>
              {options.map((o, i) => {
                const isSelected = o.key === selected;
                return (
                  <Pressable
                    key={o.key}
                    onPress={() => onSelect(o.key)}
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
            </View>
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  cancel: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    minWidth: 60,
  },
  title: { fontSize: 16, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  scrollContent: { padding: 16, paddingTop: 24, paddingBottom: 32 },
  field: { marginBottom: 20 },
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
    marginTop: 6,
  },

  selectField: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
    justifyContent: "space-between",
    flexDirection: "row",
  },
  selectValue: {
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    flexShrink: 1,
  },

  // OptionSheet styles
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
  sheetWrap: { marginHorizontal: 12, marginBottom: 12 },
  sheet: {
    backgroundColor: colors.bgDefault,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  sheetGrabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderEmphasis,
    alignSelf: "center",
    marginBottom: 10,
  },
  sheetTitle: {
    fontSize: 13,
    fontFamily: fonts.sansSemi,
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  sheetList: {},
  sheetRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sheetRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
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
  },
  sheetRowLabel: {
    fontSize: 15,
    fontFamily: fonts.sansMedium,
    color: colors.textEmphasis,
    flexShrink: 1,
  },
});
