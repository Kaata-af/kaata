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
import { useToast } from "../../../components/Toast";
import { colors } from "../../../lib/colors";
import { getCurrentCurrencySymbol } from "../../../lib/currency";
import { getEntry, updateEntry } from "../../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../../lib/direction";
import { RoleGateRejectionError } from "../../../lib/event-log";
import { fonts } from "../../../lib/fonts";
import { t } from "../../../lib/i18n";
import type { EntryType } from "../../../lib/types";

export default function EditEntryScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loaded, setLoaded] = useState(false);
  const [found, setFound] = useState(false);
  const [type, setType] = useState<EntryType>("debt");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const amountRef = useRef<TextInput>(null);
  const noteRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!id) {
      setLoaded(true);
      return;
    }
    getEntry(id).then((e) => {
      if (e) {
        setType(e.type);
        setAmount(String(e.amount_afn));
        setNote(e.note ?? "");
        setFound(true);
      }
      setLoaded(true);
    });
  }, [id]);

  // Reliable keyboard pop-up on Android. `autoFocus` on a TextInput inside a
  // modal-presented screen often fires before the screen is interactive — the
  // focus call succeeds but the soft keyboard never opens. Deferring with
  // setTimeout past the modal slide-in (~250ms) makes it land consistently.
  useEffect(() => {
    if (!loaded || !found) return;
    const focusTimer = setTimeout(() => amountRef.current?.focus(), 280);
    return () => clearTimeout(focusTimer);
  }, [loaded, found]);

  async function onSave() {
    if (!id) return;
    const intAmount = parseInt(amount.replace(/[^0-9]/g, ""), 10);
    if (!intAmount || intAmount <= 0) {
      toast.push(t("entry.invalidAmount"), "error");
      return;
    }
    setBusy(true);
    try {
      await updateEntry(id, intAmount, note.trim().slice(0, 100) || null);
      toast.push(t("entry.updated"), "success");
      router.back();
    } catch (err) {
      // Distinguish role-gate refusal from generic storage error so a
      // demoted editor sees actionable "view only" copy rather than
      // generic "save failed". See entry/new.tsx for the same pattern.
      if (err instanceof RoleGateRejectionError) {
        toast.push(t("entry.roleDenied"), "error");
      } else {
        toast.push(t("entry.saveFailed"), "error");
      }
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

  if (!found) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.header, rowDir(isRTL)]}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.back")}</Text>
          </Pressable>
          <Text style={styles.title}>{t("personEdit.title")}</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={styles.fillCenter}>
          <Text style={styles.errorText}>{t("entry.notFound")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const verb = type === "debt" ? t("person.action.iGave") : t("person.action.iReceived");
  const otherVerb = type === "debt" ? t("person.action.iReceived") : t("person.action.iGave");

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("entry.edit.title", { verb })}</Text>
        <View style={{ width: 60 }} />
      </View>
      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Text style={[styles.hint, textDir(isRTL)]}>{t("entry.edit.hint", { otherVerb })}</Text>

        <View style={styles.field}>
          <Text style={[styles.label, textDir(isRTL)]}>
            {t("entry.amount.labelTemplate", { code: getCurrentCurrencySymbol() })}{" "}
            <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            ref={amountRef}
            style={styles.amountInput}
            value={amount}
            // See entry/new.tsx — strip non-digits at typing time so "150.50"
            // doesn't get parsed as "15050" on save. AFN is integer-only.
            onChangeText={(raw) => setAmount(raw.match(/^\d*/)?.[0] ?? "")}
            placeholder="0"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            selectTextOnFocus
            returnKeyType="next"
            onSubmitEditing={() => noteRef.current?.focus()}
            submitBehavior="submit"
          />
        </View>
        <View style={styles.field}>
          <Text style={[styles.label, textDir(isRTL)]}>{t("entry.note.label")}</Text>
          <TextInput
            ref={noteRef}
            style={[styles.input, textDir(isRTL)]}
            value={note}
            onChangeText={setNote}
            placeholder={t("entry.note.placeholder")}
            placeholderTextColor={colors.textMuted}
            maxLength={100}
            returnKeyType="done"
            onSubmitEditing={onSave}
          />
        </View>
        <View style={{ height: 24 }} />
        <Button label={t("entry.saveChanges")} onPress={onSave} loading={busy} />
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
