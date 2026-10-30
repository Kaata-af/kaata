import { useFocusEffect, useLocalSearchParams, usePreventRemove, useRouter } from "expo-router";
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
import { Button } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import {
  CreditAlertRuleEditor,
  creditAlertDraftGroups,
  type CreditAlertDraft,
} from "../../../components/CreditAlertRuleEditor";
import { ScreenHeader } from "../../../components/SettingsScreen";
import { useToast } from "../../../components/Toast";
import {
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../../lib/auth";
import { colors } from "../../../lib/colors";
import {
  creditAlertBalancesInTx,
  deleteCreditAlertPolicy,
  readCreditAlertSettings,
  refreshCreditAlerts,
  saveCreditAlertPolicy,
} from "../../../lib/credit-alerts";
import type { CreditAlertBalances, CreditAlertGroup } from "../../../lib/credit-alert-policy";
import {
  CreditOnlineSaveRequiredError,
  listCreditCurrencySettings,
  relationshipForCredit,
} from "../../../lib/credit-limits";
import { KAATA_DEFAULT_CREDIT_ID, KAATA_DEFAULT_ROUTE_ID } from "../../../lib/credit-policy";
import { getPerson } from "../../../lib/db";
import { getActiveVaultIdSyncMaybe, getDb } from "../../../lib/db-tx";
import { textDir, useIsRTL } from "../../../lib/direction";
import { fonts, sansLineHeight } from "../../../lib/fonts";
import { t } from "../../../lib/i18n";
import { fromMinorUnits } from "../../../lib/money";
import { useLedgerRefresh } from "../../../lib/ledger-events";
import { applyEventMutex } from "../../../lib/projection";
import { readVaultRole, useActiveVaultWriteCaps } from "../../../lib/use-vault-role";

type Context = {
  vaultId: string;
  relationshipId: string;
  session: SessionSnapshot;
  lifetime: number;
};
type Settings = Awaited<ReturnType<typeof readCreditAlertSettings>>;
const draftText = (drafts: CreditAlertDraft[]) =>
  JSON.stringify(
    drafts.map((g) => ({
      direction: g.direction,
      conditions: g.conditions.map((c) => ({ currency: c.currency, amount: c.amount })),
    })),
  );

export default function CreditAlertsScreen() {
  const { id, vaultId: routeVaultId } = useLocalSearchParams<{ id: string; vaultId?: string }>();
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const isDefault = id === KAATA_DEFAULT_ROUTE_ID;
  const [context, setContext] = useState<Context | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drafts, setDrafts] = useState<CreditAlertDraft[]>([]);
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [balances, setBalances] = useState<CreditAlertBalances | null>(null);
  const [canSave, setCanSave] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [ledgerRevision, setLedgerRevision] = useState(0);
  const lifetime = useRef(0);
  const saving = useRef<symbol | null>(null);
  const touched = useRef(false);
  const original = useRef("");
  const key = useRef(0);
  const nextKey = () => ++key.current;
  const draftsRef = useRef(drafts);
  const leave = useRef<(() => void) | null>(null);
  const caps = useActiveVaultWriteCaps(context?.vaultId ?? null);
  const editable =
    !!context &&
    canSave &&
    caps.resolved &&
    caps.canConfigureCredit &&
    getActiveVaultIdSyncMaybe() === context.vaultId;
  const controlsDisabled = !editable || busy;
  useLedgerRefresh(context?.vaultId ?? null, () => setLedgerRevision((revision) => revision + 1));
  const current = (scope: Context) =>
    lifetime.current === scope.lifetime && getActiveVaultIdSyncMaybe() === scope.vaultId;
  const disablePrevention = usePreventRemove(
    !!context && getActiveVaultIdSyncMaybe() === context.vaultId && (dirty || busy),
    ({ repeat }) => {
      if (saving.current) return;
      leave.current = repeat;
      setDiscardOpen(true);
    },
  );

  function install(value: Settings, baseCurrencies: string[]) {
    setSettings(value);
    const groups = value.effective?.groups ?? [];
    const codes = [
      ...new Set([
        ...baseCurrencies,
        ...groups.flatMap((g) => g.conditions.map((c) => c.currency)),
      ]),
    ];
    setCurrencies(codes);
    const next = groups.map((g) => ({
      key: nextKey(),
      direction: g.direction,
      conditions: g.conditions.map((c) => ({
        key: nextKey(),
        currency: c.currency,
        amount: String(fromMinorUnits(c.threshold_minor)),
      })),
    }));
    original.current = draftText(next);
    draftsRef.current = next;
    setDrafts(next);
    setDirty(false);
  }

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const focus = ++lifetime.current;
      const vaultId = getActiveVaultIdSyncMaybe();
      saving.current = null;
      touched.current = false;
      leave.current = null;
      draftsRef.current = [];
      setContext(null);
      setSettings(null);
      setDrafts([]);
      setCurrencies([]);
      setBalances(null);
      setCustomerName(null);
      setBusy(false);
      setDirty(false);
      setError(null);
      setValidation(false);
      setCanSave(false);
      setDiscardOpen(false);
      const focused = () =>
        alive && lifetime.current === focus && getActiveVaultIdSyncMaybe() === vaultId;
      void (async () => {
        if (!id || !vaultId || (routeVaultId && vaultId !== routeVaultId)) return;
        const session = await captureCurrentSession();
        const relationshipId = isDefault
          ? KAATA_DEFAULT_CREDIT_ID
          : await relationshipForCredit(id, vaultId);
        const [value, rows, role, person] = await Promise.all([
          readCreditAlertSettings(relationshipId, vaultId),
          listCreditCurrencySettings(relationshipId, vaultId),
          readVaultRole(vaultId, session.accountId),
          isDefault ? null : getPerson(id),
        ]);
        await applyForUnchangedLocalSession(session, async () => {
          if (!focused()) return;
          setContext({ vaultId, relationshipId, session, lifetime: focus });
          setCustomerName(person?.name ?? null);
          setCanSave(role === "owner" || role === "manager");
          install(
            value,
            rows.map((r) => r.currency),
          );
        });
        if (!focused()) return;
        await refreshCreditAlerts(vaultId, session).catch(() => undefined);
        const fresh = await readCreditAlertSettings(relationshipId, vaultId);
        await applyForUnchangedLocalSession(session, async () => {
          if (focused() && !touched.current)
            install(
              fresh,
              rows.map((r) => r.currency),
            );
        });
      })().catch((err) => {
        if (focused() && !(err instanceof SessionChangedError)) setError(t("credit.loadFailed"));
      });
      return () => {
        alive = false;
        lifetime.current++;
      };
    }, [id, routeVaultId, isDefault]),
  );

  // A single locked vector prevents mixing balances from different ledger revisions.
  const balanceCodes = [...new Set(drafts.flatMap((g) => g.conditions.map((c) => c.currency)))]
    .sort()
    .join(",");
  useEffect(() => {
    let alive = true;
    setBalances(null);
    if (!context || isDefault || !balanceCodes) return;
    const scope = context;
    const groups: CreditAlertGroup[] = [
      {
        direction: "collect",
        conditions: balanceCodes.split(",").map((currency) => ({ currency, threshold_minor: 1 })),
      },
    ];
    void (async () => {
      const value = await applyEventMutex.runExclusive(async () =>
        creditAlertBalancesInTx(await getDb(), scope.vaultId, scope.relationshipId, groups),
      );
      await applyForUnchangedLocalSession(scope.session, async () => {
        if (alive && current(scope)) setBalances(value);
      });
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [context, isDefault, balanceCodes, ledgerRevision]);

  function change(next: CreditAlertDraft[]) {
    if (!context || !editable || saving.current || !current(context)) return;
    touched.current = true;
    draftsRef.current = next;
    setDrafts(next);
    setDirty(draftText(next) !== original.current);
    setError(null);
  }

  async function persist(reset = false) {
    if (!context || !editable || saving.current || !current(context)) return;
    const scope = context;
    const groups = creditAlertDraftGroups(draftsRef.current);
    if (!reset && !groups) {
      setValidation(true);
      setError(t("creditAlerts.invalid"));
      return;
    }
    const attempt = Symbol("credit-alert-save");
    saving.current = attempt;
    setBusy(true);
    setError(null);
    Keyboard.dismiss();
    try {
      if (reset) await deleteCreditAlertPolicy(scope.vaultId, scope.relationshipId, scope.session);
      else
        await saveCreditAlertPolicy(
          scope.vaultId,
          { relationship_id: scope.relationshipId, groups: groups!, updated_at_ms: 0 },
          scope.session,
        );
      const value = await readCreditAlertSettings(scope.relationshipId, scope.vaultId);
      let savedHere = false;
      await applyForUnchangedLocalSession(scope.session, async () => {
        if (!current(scope)) return;
        touched.current = true;
        install(value, currencies);
        setValidation(false);
        toast.push(t(reset ? "creditAlerts.resetDone" : "creditAlerts.saved"), "success");
        savedHere = true;
      });
      if (savedHere && !reset && groups?.length) {
        // Permission is requested only after an intentional rule save.
        const { requestReminderNotifications } =
          await import("../../../lib/reminder-notifications");
        const latest = await captureCurrentSession();
        if (
          current(scope) &&
          latest.accountId === scope.session.accountId &&
          latest.bindingVersion === scope.session.bindingVersion
        )
          await requestReminderNotifications().catch(() => undefined);
        const { syncCreditAlertPushSubscriptions } = await import("../../../lib/credit-alert-push");
        if (current(scope)) void syncCreditAlertPushSubscriptions(true).catch(() => undefined);
      }
    } catch (err) {
      if (current(scope) && !(err instanceof SessionChangedError))
        setError(
          t(
            err instanceof CreditOnlineSaveRequiredError
              ? "credit.onlineSave"
              : "credit.saveFailed",
          ),
        );
    } finally {
      if (saving.current === attempt) {
        saving.current = null;
        if (current(scope)) setBusy(false);
      }
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScreenHeader
        title={t("creditAlerts.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backDisabled={busy}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {customerName ? (
            <Text style={[styles.label, textDir(isRTL)]}>
              {t("credit.forCustomer", { name: customerName })}
            </Text>
          ) : null}
          {!context && !error ? <ActivityIndicator color={colors.textDefault} /> : null}
          <Text style={[styles.help, textDir(isRTL)]}>{t("creditAlerts.help")}</Text>
          <Text style={[styles.help, textDir(isRTL)]}>{t("creditAlerts.baseline")}</Text>
          {isDefault ? (
            <Text style={[styles.label, textDir(isRTL)]}>{t("creditAlerts.defaultHelp")}</Text>
          ) : settings?.effective ? (
            <Text style={[styles.label, textDir(isRTL)]}>
              {t(settings.policy ? "creditAlerts.custom" : "creditAlerts.usesDefault")}
            </Text>
          ) : null}
          {context ? (
            <CreditAlertRuleEditor
              drafts={drafts}
              currencies={currencies}
              disabled={controlsDisabled}
              validation={validation}
              balances={balances}
              onChange={change}
              nextKey={nextKey}
            />
          ) : null}
          {!isDefault && settings?.policy ? (
            <Button
              label={t("creditAlerts.reset")}
              variant="secondary"
              wrapLabel
              disabled={controlsDisabled}
              onPress={() => void persist(true)}
            />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={[styles.error, textDir(isRTL)]}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
        <View style={styles.footer}>
          <Button
            label={t("creditAlerts.save")}
            wrapLabel
            disabled={controlsDisabled}
            loading={busy}
            onPress={() => void persist()}
          />
        </View>
      </KeyboardAvoidingView>
      <ConfirmDialog
        visible={discardOpen && !!context && getActiveVaultIdSyncMaybe() === context.vaultId}
        title={t("credit.discardTitle")}
        description={t("credit.discardHelp")}
        confirmLabel={t("credit.discard")}
        onCancel={() => {
          leave.current = null;
          setDiscardOpen(false);
        }}
        onConfirm={() => {
          setDiscardOpen(false);
          disablePrevention();
          const action = leave.current;
          leave.current = null;
          action?.();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgDefault },
  flex: { flex: 1 },
  body: { padding: 20, gap: 16 },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  label: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    lineHeight: sansLineHeight(14, 22),
    color: colors.textDefault,
  },
  help: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    lineHeight: sansLineHeight(13, 20),
    color: colors.textSubtle,
  },
  error: {
    fontFamily: fonts.sansRegular,
    fontSize: 14,
    lineHeight: sansLineHeight(14, 22),
    color: colors.danger,
  },
});
