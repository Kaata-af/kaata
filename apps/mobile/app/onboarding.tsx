import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
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
import { createSelfProfile } from "../lib/db";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

export default function OnboardingScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [busy, setBusy] = useState(false);
  const shopRef = useRef<TextInput>(null);

  async function onSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.push(t("onboarding.nameRequired"), "error");
      return;
    }
    setBusy(true);
    try {
      await createSelfProfile(trimmedName, shopName.trim() || null);
      router.replace("/");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Image source={require("../assets/logo.png")} style={styles.logo} />
          <Text style={styles.wordmark}>{t("brand.wordmark")}</Text>
          <Text style={[styles.subtitle, textDir(isRTL)]}>{t("onboarding.subtitle")}</Text>

          <View style={{ height: 36 }} />

          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>
              {t("onboarding.name.label")} <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              style={[styles.input, textDir(isRTL)]}
              value={name}
              onChangeText={setName}
              placeholder={t("onboarding.name.placeholder")}
              placeholderTextColor={colors.textMuted}
              autoFocus
              returnKeyType="next"
              onSubmitEditing={() => shopRef.current?.focus()}
              submitBehavior="submit"
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>{t("onboarding.shop.label")}</Text>
            <TextInput
              ref={shopRef}
              style={[styles.input, textDir(isRTL)]}
              value={shopName}
              onChangeText={setShopName}
              placeholder={t("onboarding.shop.placeholder")}
              placeholderTextColor={colors.textMuted}
              returnKeyType="done"
              onSubmitEditing={onSubmit}
            />
          </View>

          <View style={{ height: 24 }} />
          <Button label={t("onboarding.continue")} onPress={onSubmit} loading={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
    justifyContent: "center",
    paddingBottom: 48,
  },
  logo: { width: 72, height: 72, marginBottom: 20 },
  wordmark: {
    fontSize: 36,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    letterSpacing: -0.8,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 8,
    lineHeight: 22,
  },
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
});
