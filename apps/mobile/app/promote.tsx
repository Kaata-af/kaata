import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../components/Button";
import { CurrencyPickerSheet } from "../components/CurrencyPickerSheet";
import { FormField, LTR_INPUT } from "../components/FormField";
import { NavRow, ScreenHeader } from "../components/SettingsScreen";
import { colors } from "../lib/colors";
import { getCurrencyLabel } from "../lib/currency";
import { getInstallIdSync } from "../lib/db-tx";
import { textDir, useIsRTL } from "../lib/direction";
import { getLocale, t } from "../lib/i18n";
import {
  newProposalDraft,
  prepareProposal,
  ProposalDraftConflictError,
  ProposalSubmissionError,
  readProposalDraft,
  saveProposalDraft,
  submitProposal,
  validateProposal,
  type ProposalDraft,
  type ProposalDraftTransition,
  type ProposalErrors,
  type ProposalFields,
} from "../lib/promotion-proposals";
import { gutter, space, typography } from "../lib/tokens";

export default function PromoteScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const [installId] = useState(getInstallIdSync);
  const [draft, setDraft] = useState<ProposalDraft | null>(null);
  const current = useRef<ProposalDraft | null>(null);
  const mounted = useRef(true);
  const loadGeneration = useRef(0);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ProposalErrors>({});
  const [loadFailed, setLoadFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);

  const persist = useCallback(
    (next: ProposalDraft, transition?: ProposalDraftTransition) =>
      saveProposalDraft(installId, next, transition),
    [installId],
  );
  const apply = (next: ProposalDraft) => {
    current.current = next;
    if (mounted.current) setDraft(next);
  };
  function recoverConflict(failure: unknown, attempted: ProposalDraft): boolean {
    if (!(failure instanceof ProposalDraftConflictError)) return false;
    if (current.current?.draft_id === attempted.draft_id) {
      apply(failure.latest);
      if (mounted.current) {
        setSaved(true);
        setError(null);
      }
    }
    return true;
  }
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoadFailed(false);
    try {
      const stored = (await readProposalDraft(installId)) ?? newProposalDraft();
      if (!mounted.current || loadGeneration.current !== generation) return;
      current.current = stored;
      setDraft(stored);
    } catch {
      if (mounted.current && loadGeneration.current === generation) setLoadFailed(true);
    }
  }, [installId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadGeneration.current++;
      if (current.current) void persist(current.current).catch(() => {});
    };
  }, [load, persist]);

  useEffect(() => {
    if (!draft) return;
    const timer = setTimeout(() => {
      if (current.current !== draft) return;
      void persist(draft).then(
        () => {
          if (mounted.current && current.current === draft) setSaved(true);
        },
        (failure) => {
          if (current.current === draft && recoverConflict(failure, draft)) return;
          if (mounted.current && current.current === draft) setError(t("promotion.saveFailed"));
        },
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, persist]);

  function change(field: keyof ProposalFields, value: string) {
    const previous = current.current;
    if (!previous || previous.pending || previous.receipt || sending.current) return;
    apply({ ...previous, fields: { ...previous.fields, [field]: value } });
    setSaved(false);
    setError(null);
    setFieldErrors((errors) => ({ ...errors, [field]: undefined }));
  }

  async function send() {
    const previous = current.current;
    if (!previous || previous.receipt || sending.current) return;
    const errors = previous.pending ? {} : validateProposal(previous.fields);
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      setError(t("promotion.checkFields"));
      return;
    }
    sending.current = true;
    setBusy(true);
    setSaved(false);
    setError(null);
    Keyboard.dismiss();
    const pending = previous.pending ?? prepareProposal(previous.fields, getLocale());
    const next = { ...previous, pending };
    apply(next);
    let stored = false;
    try {
      // A retry always reuses this saved request and its UUID, including after
      // the server received it but the response was lost.
      await persist(next);
      stored = true;
      if (mounted.current) setSaved(true);
      const receipt = await submitProposal(pending);
      const received = { ...next, receipt };
      apply(received);
      try {
        await persist(received);
      } catch (failure) {
        if (recoverConflict(failure, received)) return;
        if (mounted.current) setError(t("promotion.receiptSaveFailed"));
      }
    } catch (failure) {
      if (recoverConflict(failure, next)) return;
      if (!stored) {
        apply(previous);
        if (mounted.current) setError(t("promotion.saveFailed"));
      } else if (
        failure instanceof ProposalSubmissionError &&
        [400, 413, 422].includes(failure.status)
      ) {
        const editable = { ...next, pending: null };
        try {
          await persist(editable, { rejectedSubmissionId: pending.submission_id });
        } catch (saveFailure) {
          if (recoverConflict(saveFailure, next)) return;
          if (mounted.current) setError(t("promotion.saveFailed"));
          return;
        }
        apply(editable);
        if (mounted.current) setError(t("promotion.rejected"));
      } else if (mounted.current) {
        setError(t("promotion.sendFailed"));
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function startAnother() {
    const previous = current.current;
    if (sending.current || !previous?.receipt) return;
    sending.current = true;
    setBusy(true);
    const next = newProposalDraft();
    try {
      await persist(next, { replaceDraftId: previous.draft_id });
      apply(next);
      setError(null);
      setSaved(true);
    } catch (failure) {
      if (recoverConflict(failure, previous)) return;
      if (mounted.current) setError(t("promotion.saveFailed"));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  const editable = Boolean(draft && !draft.pending && !draft.receipt && !busy);

  return (
    <SafeAreaView style={styles.screen}>
      <ScreenHeader title={t("promotion.title")} onBack={close} isRTL={isRTL} />
      {!draft ? (
        <View style={styles.center}>
          {loadFailed ? (
            <>
              <Text style={[styles.error, textDir(isRTL)]}>{t("promotion.loadFailed")}</Text>
              <Button label={t("common.tryAgain")} onPress={() => void load()} />
            </>
          ) : (
            <ActivityIndicator color={colors.textEmphasis} />
          )}
        </View>
      ) : draft.receipt ? (
        <ScrollView contentContainerStyle={styles.success}>
          <Ionicons name="checkmark-circle-outline" size={40} color={colors.textEmphasis} />
          <Text style={[styles.heading, textDir(isRTL)]}>{t("promotion.received")}</Text>
          <Text style={[styles.body, textDir(isRTL)]}>
            {t("promotion.receipt", { id: draft.receipt.id })}
          </Text>
          <Text style={[styles.body, textDir(isRTL)]}>{t("promotion.receivedBody")}</Text>
          {error ? <Text style={[styles.error, textDir(isRTL)]}>{error}</Text> : null}
          <Button label={t("common.done")} onPress={close} fullWidth />
          <Button
            label={t("promotion.another")}
            onPress={() => void startAnother()}
            variant="secondary"
            loading={busy}
            fullWidth
          />
        </ScrollView>
      ) : (
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={styles.form}
          >
            <Text style={[styles.intro, textDir(isRTL)]}>{t("promotion.intro")}</Text>
            <FormField
              label={t("promotion.business")}
              value={draft.fields.business_name}
              onChangeText={(value) => change("business_name", value)}
              maxLength={120}
              editable={editable}
              error={fieldErrors.business_name ? t(fieldErrors.business_name) : null}
              required
            />
            <FormField
              label={t("promotion.contact")}
              value={draft.fields.contact_name}
              onChangeText={(value) => change("contact_name", value)}
              maxLength={100}
              editable={editable}
              error={fieldErrors.contact_name ? t(fieldErrors.contact_name) : null}
              required
            />
            <FormField
              label={t("promotion.phone")}
              placeholder="+93 …"
              value={draft.fields.phone}
              onChangeText={(value) => change("phone", value)}
              maxLength={32}
              editable={editable}
              keyboardType="phone-pad"
              style={LTR_INPUT}
              error={fieldErrors.phone ? t(fieldErrors.phone) : null}
              required
            />
            <FormField
              label={t("promotion.proposal")}
              placeholder={t("promotion.proposalHint")}
              value={draft.fields.proposal}
              onChangeText={(value) => change("proposal", value)}
              multiline
              maxLength={3000}
              style={styles.multiline}
              editable={editable}
              error={fieldErrors.proposal ? t(fieldErrors.proposal) : null}
              required
            />
            <FormField
              label={t("promotion.budget")}
              value={draft.fields.budget_amount}
              onChangeText={(value) => change("budget_amount", value)}
              keyboardType="decimal-pad"
              style={LTR_INPUT}
              maxLength={15}
              editable={editable}
              error={fieldErrors.budget_amount ? t(fieldErrors.budget_amount) : null}
              required
            />
            <View style={styles.currency}>
              <NavRow
                icon="cash-outline"
                label={t("promotion.currency")}
                trailing={getCurrencyLabel(draft.fields.budget_currency)}
                style={styles.currencyRow}
                onPress={() => {
                  if (editable) {
                    Keyboard.dismiss();
                    setCurrencyOpen(true);
                  }
                }}
                disabled={!editable}
                isRTL={isRTL}
              />
              {fieldErrors.budget_currency ? (
                <Text style={[styles.error, textDir(isRTL)]}>{t(fieldErrors.budget_currency)}</Text>
              ) : null}
            </View>
            <FormField
              label={t("promotion.duration")}
              placeholder={t("promotion.durationHint")}
              value={draft.fields.duration}
              onChangeText={(value) => change("duration", value)}
              maxLength={120}
              editable={editable}
              error={fieldErrors.duration ? t(fieldErrors.duration) : null}
            />
            <Text style={[styles.hint, textDir(isRTL)]}>{t("promotion.contactNotice")}</Text>
            {draft.pending ? (
              <Text style={[styles.hint, textDir(isRTL)]}>{t("promotion.pending")}</Text>
            ) : saved ? (
              <Text style={[styles.hint, textDir(isRTL)]}>{t("promotion.saved")}</Text>
            ) : null}
            {error ? (
              <Text style={[styles.error, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {error}
              </Text>
            ) : null}
            <Button
              label={t(draft.pending ? "promotion.retry" : "promotion.submit")}
              onPress={() => void send()}
              loading={busy}
              fullWidth
            />
          </ScrollView>
          <CurrencyPickerSheet
            visible={currencyOpen}
            selectedCode={draft.fields.budget_currency}
            title={t("promotion.currency")}
            onSelect={(code) => {
              change("budget_currency", code);
              setCurrencyOpen(false);
            }}
            onDismiss={() => setCurrencyOpen(false)}
            disabled={!editable}
          />
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgDefault },
  fill: { flex: 1 },
  center: { flex: 1, justifyContent: "center", padding: gutter.settings, gap: space.lg },
  form: { padding: gutter.settings, paddingBottom: space.xxxl },
  success: { flexGrow: 1, padding: gutter.settings, gap: space.lg, justifyContent: "center" },
  heading: { ...typography.heading, color: colors.textEmphasis },
  intro: { ...typography.body, color: colors.textSubtle, marginBottom: space.xl },
  body: { ...typography.body, color: colors.textDefault },
  hint: { ...typography.hint, color: colors.textSubtle, marginBottom: space.md },
  error: { ...typography.bodySm, color: colors.danger, marginBottom: space.md },
  multiline: {
    minHeight: 112,
    paddingTop: space.md,
    paddingBottom: space.md,
    textAlignVertical: "top",
  },
  currency: { marginBottom: space.xl },
  currencyRow: { paddingHorizontal: 0 },
});
