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
import { getEntry, updateEntry } from "../../../lib/db";
import type { EntryType } from "../../../lib/types";

export default function EditEntryScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loaded, setLoaded] = useState(false);
  const [type, setType] = useState<EntryType>("debt");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    getEntry(id).then((e) => {
      if (e) {
        setType(e.type);
        setAmount(String(e.amount_afn));
        setNote(e.note ?? "");
      }
      setLoaded(true);
    });
  }, [id]);

  async function onSave() {
    if (!id) return;
    const intAmount = parseInt(amount.replace(/[^0-9]/g, ""), 10);
    if (!intAmount || intAmount <= 0) {
      Alert.alert("Enter a valid amount");
      return;
    }
    setBusy(true);
    try {
      await updateEntry(id, intAmount, note.trim().slice(0, 100) || null);
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

  const isDebt = type === "debt";

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={[styles.title, { color: isDebt ? colors.debt : colors.payment }]}>
          Edit {isDebt ? "debt" : "payment"}
        </Text>
        <View style={{ width: 60 }} />
      </View>
      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Text style={styles.hint}>
          Entry type can't be changed. To convert this {isDebt ? "debt" : "payment"} into a{" "}
          {isDebt ? "payment" : "debt"}, delete this entry and add a new one.
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>Amount (AFN)</Text>
          <TextInput
            style={styles.amountInput}
            value={amount}
            onChangeText={setAmount}
            placeholder="0"
            placeholderTextColor={colors.textSecondary}
            keyboardType="number-pad"
            autoFocus
            selectTextOnFocus
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Note (optional)</Text>
          <TextInput
            style={styles.input}
            value={note}
            onChangeText={setNote}
            placeholder="آرد و چای"
            placeholderTextColor={colors.textSecondary}
            maxLength={100}
          />
        </View>
        <View style={{ height: 24 }} />
        <Button
          label="Save changes"
          onPress={onSave}
          variant={isDebt ? "debt" : "payment"}
          loading={busy}
        />
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
  title: { fontSize: 16, fontWeight: "600" },
  body: { flex: 1, padding: 24 },
  hint: { fontSize: 13, color: colors.textSecondary, marginBottom: 24, lineHeight: 18 },
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
  amountInput: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 40,
    fontWeight: "700",
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    textAlign: "center",
  },
});
