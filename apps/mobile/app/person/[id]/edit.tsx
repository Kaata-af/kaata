import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { colors } from "../../../lib/colors";
import { getPerson, updatePerson } from "../../../lib/db";
import { fonts } from "../../../lib/fonts";

export default function EditPersonScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const phoneRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!id) return;
    getPerson(id).then((p) => {
      if (p) {
        setName(p.name);
        setPhone(p.phone ?? "");
      }
      setLoaded(true);
    });
  }, [id]);

  async function onSave() {
    if (!id) return;
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert("Name required");
      return;
    }
    setBusy(true);
    try {
      const result = await updatePerson(id, trimmed, phone.trim() || null);
      if (!result.ok) {
        if (result.error === "phone_invalid") {
          Alert.alert(
            "Couldn't read that phone number",
            "Leave it blank, or try a format like +93 70 123 4567.",
          );
        } else {
          Alert.alert(
            "Phone already used",
            `${result.existing.name} already has this phone number. Use a different one.`,
          );
        }
        return;
      }
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
        <Text style={styles.title}>Edit person</Text>
        <View style={{ width: 60 }} />
      </View>
      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.field}>
          <Text style={styles.label}>
            Name <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Name"
            placeholderTextColor={colors.textMuted}
            autoFocus
            autoCapitalize="words"
            returnKeyType="next"
            onSubmitEditing={() => phoneRef.current?.focus()}
            submitBehavior="submit"
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>WhatsApp number</Text>
          <TextInput
            ref={phoneRef}
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="+93..."
            placeholderTextColor={colors.textMuted}
            keyboardType="phone-pad"
            returnKeyType="done"
            onSubmitEditing={onSave}
          />
        </View>
        <View style={{ height: 24 }} />
        <Button label="Save changes" onPress={onSave} loading={busy} />
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
});
