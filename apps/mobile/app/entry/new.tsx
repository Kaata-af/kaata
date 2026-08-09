import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ScreenLoading } from "../../components/ScreenLoading";
import { ScreenHeader } from "../../components/SettingsScreen";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import { createEntry, getActiveVaultArchivedState, getPerson } from "../../lib/db";
import { toAsciiDigits } from "../../lib/digits";
import { textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../lib/event-log";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { radius, TOUCH_MIN, typography } from "../../lib/tokens";
import { ENTRY_NOTE_MAX_LENGTH, type EntryType, type PersonWithBalance } from "../../lib/types";

// presentation:"modal" screen: the loaded branch is a bare <SafeAreaView>,
// which insets all four edges. ScreenLoading defaults to ["top"] (the pushed-
// screen case), so the pre-content branches have to spell this out or the
// header shifts the moment the read resolves.
const MODAL_EDGES = ["top", "bottom", "left", "right"] as const;

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
      try {
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
      } catch (err) {
        // A rejected SQLite read must not leave a permanent spinner with no
        // back affordance on this modal — clear loading so the screen renders.
        if (cancelled) return;
        console.warn("[entry/new] load failed", err);
        setLoading(false);
      }
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
      await createEntry(
        personId,
        type,
        intAmount,
        note.trim().slice(0, ENTRY_NOTE_MAX_LENGTH) || null,
      );
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

  // Derived above the load branches on purpose: the verb comes from the route
  // param, not from the person, so the loading header can already show the
  // final title and nothing moves when the read resolves.
  const verb = type === "debt" ? t("person.action.iGave") : t("person.action.iReceived");

  if (loading) {
    return (
      <ScreenLoading title={verb} onBack={() => router.back()} isRTL={isRTL} edges={MODAL_EDGES} />
    );
  }

  if (!person) {
    // Not-found still needs a way OUT — this is a modal screen, and without
    // a header the only escape is hardware back (which iOS doesn't have).
    return (
      <ScreenLoading
        title={verb}
        onBack={() => router.back()}
        isRTL={isRTL}
        message={t("personAdd.personNotFound")}
        edges={MODAL_EDGES}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* The "Cancel" word becomes the shared chevron; it survives as the a11y
          label so TalkBack still announces "Cancel", not "Back". */}
      <ScreenHeader
        title={verb}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.cancel")}
      />

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.context}>
          <Text style={[styles.contextLabel, textDir(isRTL), trackingSafe(isRTL)]}>
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
              // Strip unambiguous grouping separators (comma, whitespace,
              // Arabic thousands ٬ U+066C) BEFORE the leading-digits match so a
              // pasted "25,000" isn't silently truncated to "25". '.' is left
              // alone (ambiguous decimal vs grouping); AFN is integer so a
              // decimal tail is still dropped by the ^\d* match.
              const digits = toAsciiDigits(raw).replace(/[,\s٬]/g, "");
              setAmount(digits.match(/^\d*/)?.[0] ?? "");
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
            maxLength={ENTRY_NOTE_MAX_LENGTH}
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
  body: { flex: 1, padding: 16, paddingTop: 24 },
  context: { marginBottom: 24 },
  contextLabel: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  // 18 → typography.heading (20). 18 was an orphan sitting 2px under `heading`;
  // this line names the person the tally is being written against, which is the
  // same rank of statement as person detail's name — so both now land on the
  // same step. Bold is preserved over heading's sansSemi (same override idiom as
  // Button's `textPill`) because the whole context block is label-then-name and
  // the weight is what separates them.
  contextName: {
    ...typography.heading,
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
    minHeight: TOUCH_MIN,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
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
    borderRadius: radius.md,
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
