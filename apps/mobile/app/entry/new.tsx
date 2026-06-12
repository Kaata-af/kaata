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
import { getCurrentCurrencySymbol } from "../../lib/currency";
import { createEntry, getActiveVaultArchivedState, getPerson } from "../../lib/db";
import { toAsciiDigits } from "../../lib/digits";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../lib/event-log";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import type { EntryType, PersonWithBalance } from "../../lib/types";

export default function NewEntryScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const params = useLocalSearchParams<{ personId?: string; type?: string }>();
  const personId = params.personId ?? "";
  const type: EntryType = params.type === "payment" ? "payment" : "debt";

  const [person, setPerson] = useState<PersonWithBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Inline errors — this screen is presentation:"modal", and toasts cannot
  // render above native stack modals (see components/Toast.tsx), so
  // validation and save failures MUST surface inline or they're invisible.
  const [amountError, setAmountError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const amountRef = useRef<TextInput>(null);
  const noteRef = useRef<TextInput>(null);
  // Synchronous re-entry guard. `busy` state alone can't stop a double-tap:
  // setState doesn't apply within the same frame, so two rapid taps (or a
  // note-field "done" + button tap) both observe busy === false and each
  // write an entry. The ref flips synchronously before any await.
  const savingRef = useRef(false);

  // D-DEFENSIVE-ARCHIVED-GUARD: D-POST-ARCHIVE-SWITCH should already
  // have moved the user off any archived vault before they can land here,
  // but a remote vault_setting_set arriving via mesh between the home
  // screen's load() and this screen's mount can still drop us into an
  // archived state. Bail to the right place instead of silently writing
  // entries into a tombstone vault (which would be discarded the moment
  // the user sync'd, and is incoherent meanwhile).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const guard = await getActiveVaultArchivedState();
      if (cancelled) return;
      if (guard.state === "none") {
        toast.push(t("entry.noActiveVault"), "error");
        router.replace("/");
        return;
      }
      if (guard.state === "archived") {
        toast.push(t("entry.vaultArchived"), "error");
        router.replace("/vault/archived");
        return;
      }
      if (!personId) {
        setLoading(false);
        return;
      }
      const p = await getPerson(personId);
      if (cancelled) return;
      setPerson(p);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // toast/router/t are stable; only personId can meaningfully change here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);

  // Reliable keyboard pop-up on Android — autoFocus on a modally-presented
  // screen fires before the slide-in finishes and the soft keyboard never
  // opens. Defer past the animation; see entry/[id]/edit for the pattern.
  useEffect(() => {
    if (loading || !person) return;
    const focusTimer = setTimeout(() => amountRef.current?.focus(), 280);
    return () => clearTimeout(focusTimer);
  }, [loading, person]);

  async function onSave() {
    if (savingRef.current || !personId) return;
    const intAmount = parseInt(amount.replace(/[^0-9]/g, ""), 10);
    if (!intAmount || intAmount <= 0) {
      setAmountError(t("entry.invalidAmount"));
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setSaveError(null);
    try {
      // Re-check at save time: the user may have sat on this screen long
      // enough for a mesh-sourced archive event to land. Cheaper than
      // hand-rolling a subscription and good enough for a defensive guard.
      const guard = await getActiveVaultArchivedState();
      if (guard.state === "none") {
        toast.push(t("entry.noActiveVault"), "error");
        router.replace("/");
        return;
      }
      if (guard.state === "archived") {
        toast.push(t("entry.vaultArchived"), "error");
        router.replace("/vault/archived");
        return;
      }
      await createEntry(personId, type, intAmount, note.trim().slice(0, 100) || null);
      toast.push(t("entry.saved"), "success");
      router.back();
    } catch (err) {
      // Distinguish "you don't have permission to edit this Kaata"
      // (role-gate refusal — caused by a demotion that landed via
      // mesh/sync between the screen load and the save tap) from a
      // generic storage error. Without this branch the user sees the
      // same generic "couldn't save" copy in both cases and assumes the
      // app is broken, when the real story is "you're now a viewer".
      if (err instanceof RoleGateRejectionError) {
        setSaveError(t("entry.roleDenied"));
      } else if (err instanceof EventSigningUnavailableError) {
        // Mythos Fix Set C: signing-unavailable gets an actionable message.
        setSaveError(t("entry.signingUnavailable"));
      } else {
        setSaveError(t("entry.saveFailed"));
      }
    } finally {
      savingRef.current = false;
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
    // Not-found still needs a way OUT — this is a modal screen, and without
    // a header the only escape is hardware back (which iOS doesn't have).
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.header, rowDir(isRTL)]}>
          <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.back")}</Text>
          </Pressable>
          <View style={{ width: 60 }} />
          <View style={{ width: 60 }} />
        </View>
        <View style={styles.fillCenter}>
          <Text style={styles.errorText}>{t("personAdd.personNotFound")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const verb = type === "debt" ? t("person.action.iGave") : t("person.action.iReceived");

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{verb}</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.context}>
          <Text style={[styles.contextLabel, textDir(isRTL)]}>
            {type === "debt" ? t("entry.context.to") : t("entry.context.from")}
          </Text>
          <Text style={[styles.contextName, textDir(isRTL)]}>{person.name}</Text>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, textDir(isRTL)]}>
            {t("entry.amount.labelTemplate", { code: getCurrentCurrencySymbol() })}{" "}
            <Text style={styles.required}>*</Text>
          </Text>
          <TextInput
            ref={amountRef}
            style={[styles.amountInput, amountError ? styles.inputError : null]}
            value={amount}
            // Transliterate Persian/Arabic-Indic digits (Persian keyboards
            // emit them even on number-pad), then keep only the leading run
            // of digits. Anything after the first non-digit (decimal, comma,
            // space) is treated as fractional / separator and discarded —
            // AFN is integer-only. Without this, typing "150.50" used to be
            // parsed as "15050" because the save path stripped non-digits
            // and joined what remained.
            onChangeText={(raw) => {
              setAmountError(null);
              setAmount(toAsciiDigits(raw).match(/^\d*/)?.[0] ?? "");
            }}
            placeholder="0"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            // 10 digits ≈ 9.9 billion — far above any real ledger amount,
            // far below where double precision (and the 36px display) break.
            maxLength={10}
            accessibilityLabel={t("entry.amount.labelTemplate", {
              code: getCurrentCurrencySymbol(),
            })}
            returnKeyType="next"
            onSubmitEditing={() => noteRef.current?.focus()}
            submitBehavior="submit"
          />
          {amountError ? (
            <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {amountError}
            </Text>
          ) : null}
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
            accessibilityLabel={t("entry.note.label")}
            returnKeyType="done"
            onSubmitEditing={onSave}
          />
        </View>

        {saveError ? (
          <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {saveError}
          </Text>
        ) : null}
        <View style={{ height: 24 }} />
        <Button label={t("entry.save")} onPress={onSave} loading={busy} />
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
  // Mirrors FormField's error treatment so inline errors look the same
  // whether a screen uses the shared component or a custom input.
  inputError: {
    borderColor: colors.danger,
    backgroundColor: "rgba(220, 38, 38, 0.04)",
  },
  fieldError: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 6,
  },
});
