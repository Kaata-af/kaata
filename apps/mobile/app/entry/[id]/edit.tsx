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
import { fonts } from "../../../lib/fonts";
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
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
    );
  }

  const verb = type === "debt" ? "I gave" : "I received";
  const otherVerb = type === "debt" ? "I received" : "I gave";

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Edit · {verb}</Text>
        <View style={{ width: 60 }} />
      </View>
      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Text style={styles.hint}>
          Direction can&apos;t be changed. To turn this into &ldquo;{otherVerb}&rdquo;, delete this
          entry and add a new one.
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>
            Amount (AFN) <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={styles.amountInput}
            value={amount}
            onChangeText={setAmount}
            placeholder="0"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            autoFocus
            selectTextOnFocus
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Note</Text>
          <TextInput
            style={styles.input}
            value={note}
            onChangeText={setNote}
            placeholder="آرد و چای"
            placeholderTextColor={colors.textMuted}
            maxLength={100}
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
  body: { flex: 1, padding: 16, paddingTop: 20 },
  hint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginBottom: 20,
    lineHeight: 18,
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
  amountInput: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 36,
    fontFamily: fonts.monoBold,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
    textAlign: "center",
  },
});
