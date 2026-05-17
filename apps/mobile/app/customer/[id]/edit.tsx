import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
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
import { getCustomer, updateCustomer } from "../../../lib/db";

export default function EditCustomerScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    getCustomer(id).then((c) => {
      if (c) {
        setName(c.name);
        setPhone(c.phone ?? "");
      }
      setLoaded(true);
    });
  }, [id]);

  async function onSave() {
    if (!id) return;
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert("Customer name required");
      return;
    }
    setBusy(true);
    try {
      const result = await updateCustomer(id, trimmed, phone.trim() || null);
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
          <ActivityIndicator />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Edit customer</Text>
        <View style={{ width: 60 }} />
      </View>
      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.field}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Customer name"
            placeholderTextColor={colors.textSecondary}
            autoFocus
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>WhatsApp Number</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="+93..."
            placeholderTextColor={colors.textSecondary}
            keyboardType="phone-pad"
          />
        </View>
        <View style={{ height: 24 }} />
        <Button label="Save changes" onPress={onSave} loading={busy} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cancel: { fontSize: 16, color: colors.textSecondary, minWidth: 60 },
  title: { fontSize: 16, fontWeight: "600", color: colors.textPrimary },
  body: { flex: 1, padding: 24 },
  field: { marginBottom: 16 },
  label: { fontSize: 14, color: colors.textSecondary, marginBottom: 6 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
});
