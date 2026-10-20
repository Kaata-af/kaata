import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../components/Button";
import { ScreenLoading } from "../../../components/ScreenLoading";
import { ScreenHeader } from "../../../components/SettingsScreen";
import { useToast } from "../../../components/Toast";
import { colors } from "../../../lib/colors";
import { creditWarningForEdit } from "../../../lib/credit-limits";
import { getCurrentCurrencySymbol } from "../../../lib/currency";
import { getEntry, SettledChapterError, TabLinkedEntryError, updateEntry } from "../../../lib/db";
import { textDir, useIsRTL } from "../../../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../../lib/event-log";
import { fonts, sansLineHeight } from "../../../lib/fonts";
import { t } from "../../../lib/i18n";
import { normalizeAmountInput, parseAmountInput } from "../../../lib/money";
import { getTabLinkForRelationship } from "../../../lib/tabs/db";
import { radius } from "../../../lib/tokens";
import { ENTRY_NOTE_MAX_LENGTH, type EntryType } from "../../../lib/types";

// presentation:"modal" screen: the loaded branch is a bare <SafeAreaView>,
// which insets all four edges. ScreenLoading defaults to ["top"] (the pushed-
// screen case), so the pre-content branches have to spell this out or the
// header shifts the moment the read resolves.
const MODAL_EDGES = ["top", "bottom", "left", "right"] as const;

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
  // Inline errors — modal screen, toasts can't render above it (Toast.tsx).
  const [amountError, setAmountError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Raising an amount past a limit warned nowhere (audit #24); the same
  // live hint as the new-tally form, counting only the change.
  const [overLimit, setOverLimit] = useState(false);
  useEffect(() => {
    const parsed = parseAmountInput(amount);
    if (!loaded || !found || parsed === null || parsed <= 0 || !id) {
      setOverLimit(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      creditWarningForEdit(id, parsed)
        .then((over) => {
          if (alive) setOverLimit(over);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [amount, id, loaded, found]);
  // Mutual tab (docs/mutual-tab-design.md §4.4): a local row of a LINKED
  // contact is frozen — its sum is already the tab's opening tally (D8) —
  // so the form shows the reason up front and disables Save instead of
  // letting the user type and then refusing. The data layer refuses too
  // (TabLinkedEntryError), which the catch below words the same way.
  const [tabLocked, setTabLocked] = useState(false);
  const amountRef = useRef<TextInput>(null);
  const noteRef = useRef<TextInput>(null);
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx.
  const savingRef = useRef(false);

  useEffect(() => {
    if (!id) {
      setLoaded(true);
      return;
    }
    getEntry(id)
      .then(async (e) => {
        if (e) {
          setType(e.type);
          setAmount(String(e.amount_afn));
          setNote(e.note ?? "");
          // Read-only probe; a failed lookup leaves the row editable and the
          // data-layer guard still has the last word on save.
          const link = await getTabLinkForRelationship(e.relationship_id).catch(() => null);
          if (link) {
            setTabLocked(true);
            setSaveError(t("tab.editLocked"));
          }
          setFound(true);
        }
        setLoaded(true);
      })
      .catch((err) => {
        // A rejected read must still flip `loaded` — otherwise this modal is a
        // permanent spinner with no header/back. Render the not-found branch.
        console.warn("[entry/edit] load failed", err);
        setLoaded(true);
      });
  }, [id]);

  // Reliable keyboard pop-up on Android. `autoFocus` on a TextInput inside a
  // modal-presented screen often fires before the screen is interactive — the
  // focus call succeeds but the soft keyboard never opens. Deferring with
  // setTimeout past the modal slide-in (~250ms) makes it land consistently.
  useEffect(() => {
    // No keyboard for a locked row: there is nothing to type into.
    if (!loaded || !found || tabLocked) return;
    const focusTimer = setTimeout(() => amountRef.current?.focus(), 280);
    return () => clearTimeout(focusTimer);
  }, [loaded, found, tabLocked]);

  async function onSave() {
    if (savingRef.current || !id || tabLocked) return;
    const parsedAmount = parseAmountInput(amount);
    if (parsedAmount === null) {
      setAmountError(t("entry.invalidAmount"));
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setSaveError(null);
    try {
      await updateEntry(id, parsedAmount, note.trim().slice(0, ENTRY_NOTE_MAX_LENGTH) || null);
      toast.push(t("entry.updated"), "success");
      router.back();
    } catch (err) {
      // Distinguish role-gate refusal from generic storage error so a
      // demoted editor sees actionable "view only" copy rather than
      // generic "save failed". See entry/new.tsx for the same pattern.
      if (err instanceof Error && err.name === "CreditMutationAdmissionError") {
        setSaveError(
          t(
            (err as Error & { status: string }).status === "pending"
              ? "credit.pendingChange"
              : "credit.refusedChange",
          ),
        );
      } else if (err instanceof SettledChapterError) {
        // Closed-period guard: this entry sits under a ruled-off line.
        setSaveError(t("entry.settledLocked"));
      } else if (err instanceof TabLinkedEntryError) {
        // The contact was linked while this form was open (or the probe
        // above missed): the row is frozen behind the tab's opening tally.
        setTabLocked(true);
        setSaveError(t("tab.editLocked"));
      } else if (err instanceof RoleGateRejectionError) {
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

  // Hoisted above the load branches so the loading header can carry the same
  // title the loaded one will. `type` defaults to "debt", so a payment entry
  // does re-word the title once on resolve — the chrome's geometry doesn't
  // move, which is what the jump was.
  const verb = type === "debt" ? t("person.action.iGave") : t("person.action.iReceived");

  if (!loaded) {
    return (
      <ScreenLoading
        title={t("entry.edit.title", { verb })}
        onBack={() => router.back()}
        isRTL={isRTL}
        edges={MODAL_EDGES}
      />
    );
  }

  if (!found) {
    // Title stays the screen's own not-found wording, unchanged from before.
    return (
      <ScreenLoading
        title={t("personEdit.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        message={t("entry.notFound")}
        edges={MODAL_EDGES}
      />
    );
  }

  const otherVerb = type === "debt" ? t("person.action.iReceived") : t("person.action.iGave");

  return (
    <SafeAreaView style={styles.container}>
      {/* The "Cancel" word becomes the shared chevron; it survives as the a11y
          label so TalkBack still announces "Cancel", not "Back". */}
      <ScreenHeader
        title={t("entry.edit.title", { verb })}
        onBack={() => router.back()}
        isRTL={isRTL}
        backLabel={t("common.cancel")}
      />
      <KeyboardAvoidingView
        style={styles.keyboardAvoider}
        behavior="height"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        >
          <Text style={[styles.hint, textDir(isRTL)]}>{t("entry.edit.hint", { otherVerb })}</Text>

          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>
              {t("entry.amount.labelTemplate", { code: getCurrentCurrencySymbol() })}{" "}
              <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              ref={amountRef}
              style={[styles.amountInput, amountError ? styles.inputError : null]}
              value={amount}
              onChangeText={(raw) => {
                setAmountError(null);
                setAmount(normalizeAmountInput(raw));
              }}
              placeholder="0"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              inputMode="decimal"
              // Keep over-precise pasted input intact so validation can reject
              // it rather than quietly saving a truncated amount.
              accessibilityLabel={t("entry.amount.labelTemplate", {
                code: getCurrentCurrencySymbol(),
              })}
              selectTextOnFocus
              returnKeyType="next"
              onSubmitEditing={() => noteRef.current?.focus()}
              submitBehavior="submit"
            />
            {amountError ? (
              <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {amountError}
              </Text>
            ) : overLimit && !tabLocked ? (
              <Text style={[styles.creditHint, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {t("credit.warning")}
              </Text>
            ) : null}
          </View>
          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>{t("entry.note.label")}</Text>
            <TextInput
              ref={noteRef}
              style={[styles.noteInput, textDir(isRTL)]}
              value={note}
              onChangeText={setNote}
              placeholder={t("entry.note.placeholder")}
              placeholderTextColor={colors.textMuted}
              maxLength={ENTRY_NOTE_MAX_LENGTH}
              accessibilityLabel={t("entry.note.label")}
              multiline
              keyboardType="default"
              inputMode="text"
              submitBehavior="newline"
              scrollEnabled
            />
          </View>
          {saveError ? (
            <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {saveError}
            </Text>
          ) : null}
          <View style={{ height: 24 }} />
          <Button
            label={t("entry.saveChanges")}
            onPress={onSave}
            loading={busy}
            disabled={tabLocked}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  keyboardAvoider: { flex: 1 },
  body: { flexGrow: 1, padding: 16, paddingTop: 20, paddingBottom: 24 },
  hint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginBottom: 20,
    lineHeight: sansLineHeight(12, 18),
  },
  field: { marginBottom: 20 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
  noteInput: {
    minHeight: 104,
    maxHeight: 200,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    lineHeight: sansLineHeight(15, 22),
    textAlignVertical: "top",
    overflow: "hidden",
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
  // Mirrors FormField's error treatment — see entry/new.tsx.
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
  creditHint: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.reviewPending,
    marginTop: 6,
  },
});
