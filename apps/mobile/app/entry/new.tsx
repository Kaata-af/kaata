import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ScreenLoading } from "../../components/ScreenLoading";
import { ScreenHeader } from "../../components/SettingsScreen";
import { queuePendingToast, useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import {
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../lib/auth";
import { getAccountIdSync, getActiveVaultIdSyncMaybe, getInstallIdSync } from "../../lib/db-tx";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import { createEntryDetailed, getActiveVaultArchivedState, getPerson } from "../../lib/db";
import { textDir, trackingSafe, useIsRTL } from "../../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../lib/event-log";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";
import { normalizeAmountInput, parseAmountInput } from "../../lib/money";
import { getTabLinkForPerson } from "../../lib/tabs/db";
import { creditWarning } from "../../lib/credit-limits";
import { noteSavedEntry } from "../../lib/recent-entry";
import {
  TabAuthUnavailableError,
  TabApiError,
  TabClosedError,
  TabInputError,
  TabPermissionError,
} from "../../lib/tabs/errors";
import { radius, TOUCH_MIN, typography } from "../../lib/tokens";
import { ENTRY_NOTE_MAX_LENGTH, type EntryType, type PersonWithBalance } from "../../lib/types";

// presentation:"modal" screen: the loaded branch is a bare <SafeAreaView>,
// which insets all four edges. ScreenLoading defaults to ["top"] (the pushed-
// screen case), so the pre-content branches have to spell this out or the
// header shifts the moment the read resolves.
const MODAL_EDGES = ["top", "bottom", "left", "right"] as const;
type ScreenScope = {
  personId: string;
  type: EntryType;
  vaultId: string | null;
  accountId: string | null;
  installId: string;
};
type UIAttempt = ScreenScope & { focus: number };

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
  // Said while typing, not only after the save (audit #24): the same check
  // the save makes, on the amount as it stands.
  const [overLimit, setOverLimit] = useState(false);
  useEffect(() => {
    const parsed = parseAmountInput(amount);
    if (parsed === null || parsed <= 0 || !personId) {
      setOverLimit(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      creditWarning(personId, type, parsed)
        .then((over) => {
          if (alive) setOverLimit(over);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [amount, personId, type]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const amountRef = useRef<TextInput>(null);
  const noteRef = useRef<TextInput>(null);
  // Synchronous re-entry guard. `busy` state alone can't stop a double-tap:
  // setState doesn't apply within the same frame, so two rapid taps (or a
  // note-field "done" + button tap) both observe busy === false and each
  // write an entry. The ref flips synchronously before any await.
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const focused = useRef(false);
  const focusGeneration = useRef(0);
  const [focusVersion, setFocusVersion] = useState(0);
  const scope: ScreenScope = {
    personId,
    type,
    vaultId: getActiveVaultIdSyncMaybe(),
    accountId: getAccountIdSync(),
    installId: getInstallIdSync(),
  };
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const isCurrent = (attempt: UIAttempt) =>
    mounted.current &&
    focused.current &&
    attempt.focus === focusGeneration.current &&
    scopeRef.current.personId === attempt.personId &&
    scopeRef.current.type === attempt.type &&
    getActiveVaultIdSyncMaybe() === attempt.vaultId &&
    getAccountIdSync() === attempt.accountId &&
    getInstallIdSync() === attempt.installId;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // D-DEFENSIVE-ARCHIVED-GUARD: D-POST-ARCHIVE-SWITCH should already
  // have moved the user off any archived vault before they can land here,
  // but a remote vault_setting_set arriving via mesh between the home
  // screen's load() and this screen's mount can still drop us into an
  // archived state. Bail to the right place instead of silently writing
  // entries into a tombstone vault (which would be discarded the moment
  // the user sync'd, and is incoherent meanwhile).
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const focus = ++focusGeneration.current;
      const attempt = { ...scopeRef.current, focus };
      setFocusVersion(focus);
      setBusy(savingRef.current);
      setLoading(true);
      setPerson(null);
      setSaveError(null);
      void (async () => {
        try {
          const guard = await getActiveVaultArchivedState();
          if (!isCurrent(attempt)) return;
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
          if (!attempt.personId) {
            setLoading(false);
            return;
          }
          const p = await getPerson(attempt.personId);
          if (!isCurrent(attempt)) return;
          setPerson(p);
          setLoading(false);
        } catch (err) {
          // A rejected SQLite read must not leave a permanent spinner with no
          // back affordance on this modal — clear loading so the screen renders.
          if (!isCurrent(attempt)) return;
          console.warn("[entry/new] load failed", err);
          setLoading(false);
        }
      })();
      return () => {
        focused.current = false;
        focusGeneration.current++;
      };
      // A changed route or local identity needs a new scoped read; a completed
      // read from a previous focus must never redirect the newly visible screen.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [personId, type, scope.vaultId, scope.accountId, scope.installId]),
  );

  // Reliable keyboard pop-up on Android — autoFocus on a modally-presented
  // screen fires before the slide-in finishes and the soft keyboard never
  // opens. Defer past the animation; see entry/[id]/edit for the pattern.
  useEffect(() => {
    if (loading || !person) return;
    const attempt = { ...scopeRef.current, focus: focusGeneration.current };
    const focusTimer = setTimeout(() => {
      if (isCurrent(attempt)) amountRef.current?.focus();
    }, 280);
    return () => clearTimeout(focusTimer);
  }, [loading, person, focusVersion]);

  async function onSave() {
    const attempt = { ...scope, focus: focusGeneration.current };
    if (savingRef.current || !attempt.personId || !isCurrent(attempt)) return;
    const parsedAmount = parseAmountInput(amount);
    if (parsedAmount === null) {
      setAmountError(t("entry.invalidAmount"));
      return;
    }
    const savedNote = note.trim().slice(0, ENTRY_NOTE_MAX_LENGTH) || null;
    savingRef.current = true;
    setBusy(true);
    setSaveError(null);
    let session: SessionSnapshot | null = null;
    const present = async (work: () => void) => {
      if (!isCurrent(attempt)) return;
      if (session) {
        await applyForUnchangedLocalSession(session, async () => {
          if (isCurrent(attempt)) work();
        });
      } else work();
    };
    try {
      session = await captureCurrentSession();
      const vaultId = attempt.vaultId;
      if (!vaultId || !isCurrent(attempt) || session.accountId !== attempt.accountId) return;
      // Re-check at save time: the user may have sat on this screen long
      // enough for a mesh-sourced archive event to land. Cheaper than
      // hand-rolling a subscription and good enough for a defensive guard.
      const guard = await getActiveVaultArchivedState();
      if (!isCurrent(attempt)) return;
      if (guard.state === "none") {
        await present(() => {
          toast.push(t("entry.noActiveVault"), "error");
          router.replace("/");
        });
        return;
      }
      if (guard.state === "archived") {
        await present(() => {
          toast.push(t("entry.vaultArchived"), "error");
          router.replace("/vault/archived");
        });
        return;
      }
      // createEntryDetailed routes a LINKED contact's tally to the mutual tab
      // (docs/mutual-tab-design.md §4.3) with no branching here; the only
      // extra it hands back is the D17 duplicate hint.
      const saved = await createEntryDetailed(
        attempt.personId,
        attempt.type,
        parsedAmount,
        savedNote,
        { session, vaultId },
      );
      // A refused clerk tally is not in the ledger; anything else should be
      // visible when the customer's page comes back, filters or not.
      if (saved.admission_status !== "refused") noteSavedEntry(attempt.personId, saved.entry_id);
      // Signed out, a shared tally waits on this phone until sign-in; "Saved"
      // alone hid that it has not reached the other side (audit #24).
      const waitingLink =
        !session.jwt && saved.admission_status == null
          ? await getTabLinkForPerson(attempt.personId).catch(() => null)
          : null;
      let duplicateName: string | null = null;
      if (saved.duplicate_hint && isCurrent(attempt)) {
        // The other party recorded the same transfer within a day. Queued,
        // not pushed: this modal is about to close, and a toast pushed from
        // under it would never be seen (Toast.tsx). It surfaces on the person
        // screen right after the save toast.
        const link = await getTabLinkForPerson(attempt.personId).catch(() => null);
        duplicateName = link?.other_label || t("tab.them");
      }
      await present(() => {
        if (waitingLink)
          toast.push(
            t("tab.savedSignIn", { name: waitingLink.other_label || t("tab.them") }),
            "info",
          );
        else
          toast.push(
            t(
              saved.admission_status === "refused"
                ? "credit.blocked"
                : saved.admission_status === "pending"
                  ? // Goods handed over now cannot be taken back if the
                    // server refuses (audit #24).
                    attempt.type === "debt"
                    ? "credit.pendingHold"
                    : "credit.pending"
                  : "entry.saved",
            ),
            saved.admission_status === "refused"
              ? "error"
              : saved.admission_status === "pending"
                ? "info"
                : "success",
          );
        if (saved.credit_warning && !saved.admission_status)
          queuePendingToast(t("credit.warning"), "info");
        if (duplicateName)
          queuePendingToast(t("tab.duplicateHint", { name: duplicateName }), "info");
        router.back();
      });
    } catch (err) {
      // Distinguish "you don't have permission to edit this Kaata"
      // (role-gate refusal — caused by a demotion that landed via
      // mesh/sync between the screen load and the save tap) from a
      // generic storage error. Without this branch the user sees the
      // same generic "couldn't save" copy in both cases and assumes the
      // app is broken, when the real story is "you're now a viewer".
      if (err instanceof SessionChangedError || !isCurrent(attempt)) return;
      let errorKey: Parameters<typeof t>[0];
      if (err instanceof RoleGateRejectionError) {
        errorKey = "entry.roleDenied";
      } else if (err instanceof EventSigningUnavailableError) {
        // Mythos Fix Set C: signing-unavailable gets an actionable message.
        errorKey = "entry.signingUnavailable";
      } else if (err instanceof TabAuthUnavailableError) {
        // Linked contact, signed out, and the party token is gone (reinstall
        // without an account — D10): the phone cannot reach the tab at all.
        errorKey = "tab.needsConnection";
      } else if (err instanceof TabClosedError) {
        // The other side closed the shared account since this screen loaded.
        errorKey = "tab.closed";
      } else if (err instanceof TabPermissionError) {
        errorKey = "entry.roleDenied";
      } else if (err instanceof TabApiError && err.code === "credit_limit_exceeded") {
        errorKey = "credit.blocked";
      } else if (err instanceof TabInputError) {
        errorKey = "entry.saveFailed";
      } else {
        errorKey = "entry.saveFailed";
      }
      // A failed admission can finish after a same-account sign-in replaced
      // the session, too. Only the original session may paint its error.
      try {
        await present(() => setSaveError(t(errorKey)));
      } catch {
        /* stale session */
      }
    } finally {
      savingRef.current = false;
      // Returning while a durable save is still running keeps double-taps
      // blocked. Its completion releases that busy flag without reviving any
      // expired feedback; a later focus also reads the synchronous flag.
      if (mounted.current && focused.current) setBusy(false);
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
            onChangeText={(raw) => {
              setAmountError(null);
              setAmount(normalizeAmountInput(raw));
            }}
            placeholder="0"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
            inputMode="decimal"
            // Validate the amount instead of truncating pasted extra digits
            // with maxLength, which could silently change a financial value.
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
          ) : overLimit ? (
            <Text style={[styles.creditHint, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {t("credit.warning")}
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
  creditHint: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.reviewPending,
    marginTop: 6,
  },
});
