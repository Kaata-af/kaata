import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../components/Button";
import { CountryPickerSheet } from "../../../components/CountryPickerSheet";
import { useToast } from "../../../components/Toast";
import { colors } from "../../../lib/colors";
import { getPerson, updatePerson } from "../../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../../lib/direction";
import { fonts } from "../../../lib/fonts";
import { t } from "../../../lib/i18n";
import { getCountry, getCurrentDefaultCountryCode, inferCountryFromE164 } from "../../../lib/phone";

export default function EditPersonScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // Defaults to the user's preferred country. Overwritten on load via
  // inferCountryFromE164(person.phone) when the existing contact has a
  // phone — only matters as the visible default while the data loads,
  // and as the fallback for contacts saved without a phone number.
  const [countryCode, setCountryCode] = useState(getCurrentDefaultCountryCode);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const country = getCountry(countryCode);

  useEffect(() => {
    if (!id) return;
    getPerson(id).then((p) => {
      if (p) {
        setName(p.name);
        if (p.phone) {
          // Split stored E.164 into (country, national) so the picker shows
          // the right flag and the input shows just the national digits.
          const inferred = inferCountryFromE164(p.phone);
          const dial = getCountry(inferred).dialCode;
          setCountryCode(inferred);
          setPhone(p.phone.startsWith(dial) ? p.phone.slice(dial.length) : p.phone);
        } else {
          setPhone("");
        }
      }
      setLoaded(true);
    });
  }, [id]);

  // Reliable keyboard pop-up on Android — see entry/[id]/edit for context.
  useEffect(() => {
    if (!loaded) return;
    const focusTimer = setTimeout(() => nameRef.current?.focus(), 280);
    return () => clearTimeout(focusTimer);
  }, [loaded]);

  async function onSave() {
    if (!id) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.push(t("onboarding.nameRequired"), "error");
      return;
    }
    setBusy(true);
    try {
      const result = await updatePerson(id, trimmed, phone.trim() || null, countryCode);
      if (!result.ok) {
        if (result.error === "phone_invalid") {
          toast.push(t("personAdd.phone.invalid"), "error");
        } else {
          toast.push(t("personAdd.phone.conflict", { name: result.existing.name }), "error");
        }
        return;
      }
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

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("personEdit.title")}</Text>
        <View style={{ width: 60 }} />
      </View>
      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.field}>
          <Text style={[styles.label, textDir(isRTL)]}>
            {t("personEdit.name.label")} <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            ref={nameRef}
            style={[styles.input, textDir(isRTL)]}
            value={name}
            onChangeText={setName}
            placeholder={t("personEdit.name.label")}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
            returnKeyType="next"
            onSubmitEditing={() => phoneRef.current?.focus()}
            submitBehavior="submit"
          />
        </View>
        <View style={styles.field}>
          <Text style={[styles.label, textDir(isRTL)]}>{t("personEdit.phone.label")}</Text>
          {/* Phone row stays physical-LTR; numbers are LTR-natural via
              Unicode bidi. See the matching comment in person/new.tsx. */}
          <View style={styles.phoneRow}>
            <Pressable
              onPress={() => setPickerVisible(true)}
              style={({ pressed }) => [
                styles.countryBtn,
                pressed && { backgroundColor: colors.bgMuted },
              ]}
            >
              <Text style={styles.countryFlag}>{country.flag}</Text>
              <Text style={styles.countryDial}>{country.dialCode}</Text>
              <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
            </Pressable>
            <TextInput
              ref={phoneRef}
              style={styles.phoneInput}
              value={phone}
              onChangeText={setPhone}
              placeholder={country.code === "AF" ? "70 123 4567" : "national number"}
              placeholderTextColor={colors.textMuted}
              keyboardType="phone-pad"
              returnKeyType="done"
              onSubmitEditing={onSave}
            />
          </View>
        </View>
        <View style={{ height: 24 }} />
        <Button label={t("personEdit.save")} onPress={onSave} loading={busy} />
      </KeyboardAvoidingView>

      <CountryPickerSheet
        visible={pickerVisible}
        selectedCode={countryCode}
        onSelect={(c) => setCountryCode(c)}
        onDismiss={() => setPickerVisible(false)}
      />
    </SafeAreaView>
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
  body: { flex: 1, padding: 16, paddingTop: 24 },
  field: { marginBottom: 20 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
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
  phoneRow: { flexDirection: "row", gap: 8 },
  countryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    backgroundColor: colors.bgDefault,
  },
  countryFlag: { fontSize: 18 },
  countryDial: {
    fontSize: 14,
    fontFamily: fonts.monoMedium,
    color: colors.textEmphasis,
  },
  phoneInput: {
    flex: 1,
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
});
