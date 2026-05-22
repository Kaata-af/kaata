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
import { Button } from "../../components/Button";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { createEntry, getPerson } from "../../lib/db";
import { fonts } from "../../lib/fonts";
import type { EntryType, PersonWithBalance } from "../../lib/types";

export default function NewEntryScreen() {
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ personId?: string; type?: string }>();
  const personId = params.personId ?? "";
  const type: EntryType = params.type === "payment" ? "payment" : "debt";

  const [person, setPerson] = useState<PersonWithBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!personId) {
      setLoading(false);
      return;
    }
    getPerson(personId).then((p) => {
      setPerson(p);
      setLoading(false);
    });
  }, [personId]);

  async function onSave() {
    if (!personId) return;
    const intAmount = parseInt(amount.replace(/[^0-9]/g, ""), 10);
    if (!intAmount || intAmount <= 0) {
      toast.push("Enter a valid amount", "error");
      return;
    }
    setBusy(true);
    try {
      await createEntry(personId, type, intAmount, note.trim().slice(0, 100) || null);
      toast.push("Entry saved", "success");
      router.back();
    } catch {
      toast.push("Couldn't save. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.fillCenter}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
    );
  }

  if (!person) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.fillCenter}>
          <Text style={styles.errorText}>Person not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const verb = type === "debt" ? "I gave" : "I received";

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>{verb}</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.context}>
          <Text style={styles.contextLabel}>{type === "debt" ? "to" : "from"}</Text>
          <Text style={styles.contextName}>{person.name}</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>
            Amount (AFN) <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            style={styles.amountInput}
            value={amount}
            // Keep only the leading run of digits. Anything after the first
            // non-digit (decimal, comma, space) is treated as fractional /
            // separator and discarded — AFN is integer-only. Without this,
            // typing "150.50" used to be parsed as "15050" because the save
            // path stripped non-digits and joined what remained.
            onChangeText={(t) => setAmount(t.match(/^\d*/)?.[0] ?? "")}
            placeholder="0"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            autoFocus
            returnKeyType="next"
            onSubmitEditing={() => noteRef.current?.focus()}
            submitBehavior="submit"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Note</Text>
          <TextInput
            ref={noteRef}
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
        <Button label="Save" onPress={onSave} loading={busy} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorText: { fontSize: 14, fontFamily: fonts.sansRegular, color: colors.textSubtle },
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
  context: { marginBottom: 24 },
  contextLabel: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  contextName: {
    fontSize: 18,
    fontFamily: fonts.sansBold,
    color: colors.textEmphasis,
    marginTop: 4,
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
