import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";
import { colors } from "../lib/colors";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  getCurrencyName,
  getCurrentCurrencyCode,
  setCurrentCurrency,
} from "../lib/currency";
import { getAppMeta, getLocalSelf, setAppMeta, updateSelfProfile } from "../lib/db";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { type LocalePref, setLocale, t } from "../lib/i18n";

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: LocalePref; labelKey: string }> = [
  { value: "system", labelKey: "settings.language.option.system" },
  { value: "en", labelKey: "settings.language.option.en" },
  { value: "fa", labelKey: "settings.language.option.fa" },
];

// Settings is one form: name, shop name, language, currency. Language and
// currency are select fields that open a bottom sheet picker. Nothing is
// persisted until the user taps Save — drafts live in local state until then.
// This lets the user back out via the Cancel header button without committing.

export default function SettingsScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  // Drafts. Initial values come from app_meta on mount. Save commits them
  // to DB + the in-memory module globals (setLocale, setCurrentCurrency).
  const [localePref, setLocalePref] = useState<LocalePref>("system");
  const [currency, setCurrency] = useState<string>(DEFAULT_CURRENCY);
  // Original values captured on load so save() knows what actually changed.
  // (Avoids gratuitous setLocale notifications if user re-picked the same.)
  const initial = useRef<{ localePref: LocalePref; currency: string }>({
    localePref: "system",
    currency: DEFAULT_CURRENCY,
  });
  const [busy, setBusy] = useState(false);
  const [langSheetVisible, setLangSheetVisible] = useState(false);
  const [currencySheetVisible, setCurrencySheetVisible] = useState(false);
  const shopRef = useRef<TextInput>(null);
  // Lets us re-render this screen after Save commits a language change, so
  // the cancel/title/labels here repaint in the new locale before the user
  // navigates back. Other mounted screens repaint via the useIsRTL/locale
  // subscriber pattern.
  const [, forceRerender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    (async () => {
      const [s, storedPref] = await Promise.all([getLocalSelf(), getAppMeta("locale_pref")]);
      if (s) {
        setName(s.name);
        setShopName(s.shop_name ?? "");
      }
      const pref: LocalePref = storedPref === "en" || storedPref === "fa" ? storedPref : "system";
      setLocalePref(pref);
      const code = getCurrentCurrencyCode();
      setCurrency(code);
      initial.current = { localePref: pref, currency: code };
      setLoaded(true);
    })();
  }, []);

  async function onSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.push(t("onboarding.nameRequired"), "error");
      return;
    }
    setBusy(true);
    try {
      // Name + shop always commit (cheap, safe to overwrite).
      await updateSelfProfile(trimmed, shopName.trim() || null);

      // Language: only commit + notify if actually changed. setLocale fires
      // subscribers (useIsRTL + every consumer that subscribes via
      // subscribeLocale), which triggers tree-wide re-render in the new
      // language.
      if (localePref !== initial.current.localePref) {
        setLocale(localePref);
        await setAppMeta("locale_pref", localePref);
      }

      // Currency: same pattern. setCurrentCurrency mutates the module
      // global; consumers reading getCurrentCurrencySymbol() see the new
      // value on their next render.
      if (currency !== initial.current.currency) {
        setCurrentCurrency(currency);
        await setAppMeta("default_currency", currency);
      }

      // Repaint this screen if locale changed so the Saved toast + any
      // labels on the way out are already in the new language.
      forceRerender();
      toast.push(t("settings.saved"), "success");
      router.back();
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.fillCenter}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
    );
  }

  const selectedLangLabelKey =
    LANGUAGE_OPTIONS.find((o) => o.value === localePref)?.labelKey ??
    "settings.language.option.system";

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("settings.title")}</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
        >
          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>
              {t("settings.name.label")} <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              style={[styles.input, textDir(isRTL)]}
              value={name}
              onChangeText={setName}
              placeholder={t("onboarding.name.placeholder")}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
              returnKeyType="next"
              onSubmitEditing={() => shopRef.current?.focus()}
              submitBehavior="submit"
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>{t("settings.shop.label")}</Text>
            <TextInput
              ref={shopRef}
              style={[styles.input, textDir(isRTL)]}
              value={shopName}
              onChangeText={setShopName}
              placeholder={t("onboarding.shop.placeholder")}
              placeholderTextColor={colors.textMuted}
              returnKeyType="done"
            />
            <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("settings.shop.hint")}</Text>
          </View>

          <SelectField
            label={t("settings.language.label")}
            value={t(selectedLangLabelKey as never)}
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

          <View style={{ height: 24 }} />
          <Button label={t("settings.save")} onPress={onSave} loading={busy} />
        </ScrollView>
      </KeyboardAvoidingView>

      <OptionSheet
        visible={langSheetVisible}
        title={t("settings.language.label")}
        options={LANGUAGE_OPTIONS.map((o) => ({
          key: o.value,
          label: t(o.labelKey as never),
        }))}
        selected={localePref}
        onDismiss={() => setLangSheetVisible(false)}
        onSelect={(key) => {
          setLocalePref(key as LocalePref);
          setLangSheetVisible(false);
        }}
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
        onDismiss={() => setCurrencySheetVisible(false)}
        onSelect={(key) => {
          setCurrency(key);
          setCurrencySheetVisible(false);
        }}
        isRTL={isRTL}
      />
    </SafeAreaView>
  );
}

function findSymbol(code: string): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? "";
}

// Compact select field. Renders like an input with the current value + a
// chevron-down affordance; tap fires onPress to open a picker sheet.
function SelectField(props: {
  label: string;
  value: string;
  onPress: () => void;
  isRTL: boolean;
  hint?: string;
}) {
  const { label, value, onPress, isRTL, hint } = props;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, textDir(isRTL)]}>{label}</Text>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.selectField,
          rowDir(isRTL),
          pressed && { backgroundColor: colors.bgMuted },
        ]}
      >
        <Text style={[styles.selectValue, textDir(isRTL)]} numberOfLines={1}>
          {value}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
      {hint ? <Text style={[styles.fieldHint, textDir(isRTL)]}>{hint}</Text> : null}
    </View>
  );
}

// Bottom sheet that presents a list of options with checkmarks. Pattern
// mirrors BottomSheet's slide-up + blur-backdrop chrome; kept inline here
// because the row layout (leading char + label + checkmark) is specific.
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
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefault,
  },
  cancel: { fontSize: 15, fontFamily: fonts.sansMedium, color: colors.textSubtle, minWidth: 60 },
  title: { fontSize: 15, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  scrollContent: { padding: 16, paddingTop: 24, paddingBottom: 32 },
  field: { marginBottom: 20 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
  },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
  },

  // Compact select field — looks like the text input, with a value + chevron.
  selectField: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.bgDefault,
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectValue: {
    flex: 1,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
  },

  // Bottom-sheet picker chrome — mirrors BottomSheet.tsx + CountryPickerSheet.
  sheetTint: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.08)" },
  sheetContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "80%",
  },
  sheetWrap: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  sheet: { paddingTop: 8, paddingBottom: 8 },
  sheetGrabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderEmphasis,
    marginBottom: 8,
  },
  sheetTitle: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  sheetList: { paddingHorizontal: 8 },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 8,
  },
  sheetRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  sheetRowLeft: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 12,
    flex: 1,
  },
  sheetRowLeading: {
    fontSize: 17,
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
