import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { colors } from "../lib/colors";
import { createSelfProfile } from "../lib/db";
import { fonts } from "../lib/fonts";

export default function OnboardingScreen() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [busy, setBusy] = useState(false);
  const shopRef = useRef<TextInput>(null);

  async function onSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert("Name required");
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
        style={styles.inner}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Text style={styles.wordmark}>kaata.</Text>
        <Text style={styles.subtitle}>A quiet ledger between you and the people you trust.</Text>

        <View style={{ height: 36 }} />

        <View style={styles.field}>
          <Text style={styles.label}>
            Your name <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Sultan"
            placeholderTextColor={colors.textMuted}
            autoFocus
            returnKeyType="next"
            onSubmitEditing={() => shopRef.current?.focus()}
            submitBehavior="submit"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Store or business name</Text>
          <TextInput
            ref={shopRef}
            style={styles.input}
            value={shopName}
            onChangeText={setShopName}
            placeholder="Shop Sultan"
            placeholderTextColor={colors.textMuted}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        </View>

        <View style={{ height: 24 }} />
        <Button label="Continue" onPress={onSubmit} loading={busy} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  inner: { flex: 1, padding: 24, justifyContent: "center" },
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
