import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";
import { colors } from "../lib/colors";
import { getLocalSelf, updateSelfProfile } from "../lib/db";
import { fonts } from "../lib/fonts";

export default function SettingsScreen() {
  const router = useRouter();
  const toast = useToast();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [busy, setBusy] = useState(false);
  const shopRef = useRef<TextInput>(null);

  useEffect(() => {
    getLocalSelf().then((s) => {
      if (s) {
        setName(s.name);
        setShopName(s.shop_name ?? "");
      }
      setLoaded(true);
    });
  }, []);

  async function onSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.push("Name required", "error");
      return;
    }
    setBusy(true);
    try {
      await updateSelfProfile(trimmed, shopName.trim() || null);
      toast.push("Saved", "success");
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
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
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
            <Text style={styles.label}>
              Your name <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Sultan"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
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
              onSubmitEditing={onSave}
            />
            <Text style={styles.fieldHint}>Leave blank if you don&apos;t have one.</Text>
          </View>

          <View style={{ height: 16 }} />
          <Button label="Save changes" onPress={onSave} loading={busy} />
        </ScrollView>
      </KeyboardAvoidingView>
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
});
