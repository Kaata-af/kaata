import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, usePreventRemove, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { CurrencyPickerSheet } from "../../../components/CurrencyPickerSheet";
import { SelectionMark } from "../../../components/SelectionMark";
import { ScreenHeader } from "../../../components/SettingsScreen";
import { useToast } from "../../../components/Toast";
import { colors } from "../../../lib/colors";
import {
  currencyNeedsPrecisionHint,
  getCurrencyLabel,
  getCurrencyName,
} from "../../../lib/currency";
import {
  type CreditCurrencySettings,
  type CreditPolicy,
  KAATA_DEFAULT_CREDIT_ID,
  listCreditCurrencySettings,
  creditBalanceInTx,
  refreshCreditPolicies,
  relationshipForCredit,
  saveCreditPolicy,
  ClerkCloudEnrollmentRequiredError,
  CreditOnlineSaveRequiredError,
} from "../../../lib/credit-limits";
import { KAATA_DEFAULT_ROUTE_ID } from "../../../lib/credit-policy";
import { getActiveVaultIdSyncMaybe, getDb } from "../../../lib/db-tx";
import {
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../../lib/auth";
import { rowDir, textDir, useIsRTL } from "../../../lib/direction";
import { getPerson } from "../../../lib/db";
import { fonts, sansLineHeight } from "../../../lib/fonts";
import { formatAmount } from "../../../lib/format";
import { t } from "../../../lib/i18n";
import { fromMinorUnits, normalizeAmountInput, toMinorUnits } from "../../../lib/money";
import { readVaultRole, useActiveVaultWriteCaps } from "../../../lib/use-vault-role";

type Draft = {
  collect: string;
  pay: string;
  mode: CreditPolicy["mode"];
  restrictEditors: boolean;
  dirty: boolean;
};
type Context = {
  vaultId: string;
  relationshipId: string;
  session: SessionSnapshot;
  lifetime: number;
};
function draftFor(row: CreditCurrencySettings): Draft {
  const policy = row.policy ?? row.defaultPolicy;
  return {
    collect:
      policy?.max_collect_minor == null ? "" : String(fromMinorUnits(policy.max_collect_minor)),
    pay: policy?.max_pay_minor == null ? "" : String(fromMinorUnits(policy.max_pay_minor)),
    mode: policy?.mode ?? "warn",
    restrictEditors: !!policy?.restrict_editors,
    dirty: false,
  };
}
function parseCap(raw: string): number | null | undefined {
  const normalized = normalizeAmountInput(raw);
  if (!normalized) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0 || value > 9999999999.99) return undefined;
  return toMinorUnits(value);
}

export default function CreditLimitScreen() {
  const { id, vaultId: routeVaultId } = useLocalSearchParams<{ id: string; vaultId?: string }>();
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const isDefault = id === KAATA_DEFAULT_ROUTE_ID;
  const [context, setContext] = useState<Context | null>(null);
  const [settings, setSettings] = useState<CreditCurrencySettings[]>([]);
  const settingsRef = useRef(settings);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftsRef = useRef(drafts);
  // Protect both unsaved edits and successful saves from an older in-flight refresh.
  const touched = useRef(new Set<string>());
  const [currencyCode, setCurrencyCode] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [canSave, setCanSave] = useState(false);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<{ currency: string; minor: number } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const leave = useRef<(() => void) | null>(null);
  const saving = useRef<symbol | null>(null);
  const lifetime = useRef(0);
  const liveVaultId = context?.vaultId ?? null;
  const caps = useActiveVaultWriteCaps(liveVaultId);
  const editable =
    !!context &&
    canSave &&
    caps.resolved &&
    caps.canConfigureCredit &&
    getActiveVaultIdSyncMaybe() === liveVaultId;
  const controlsDisabled = !editable || busy;
  const selected = settings.find((row) => row.currency === currencyCode);
  const draft = currencyCode ? drafts[currencyCode] : undefined;
  const dirtyCount = Object.values(drafts).filter((value) => value.dirty).length;
  const disablePrevention = usePreventRemove(
    !!context && getActiveVaultIdSyncMaybe() === context.vaultId && (busy || dirtyCount > 0),
    ({ repeat }) => {
      if (saving.current) return;
      leave.current = repeat;
      setDiscardOpen(true);
    },
  );

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const focus = ++lifetime.current;
      const vaultId = getActiveVaultIdSyncMaybe();
      saving.current = null;
      setBusy(false);
      setDiscardOpen(false);
      leave.current = null;
      touched.current = new Set();
      settingsRef.current = [];
      draftsRef.current = {};
      setSettings([]);
      setDrafts({});
      setContext(null);
      setCustomerName(null);
      setCurrencyCode(null);
      setPickerOpen(false);
      setCanSave(false);
      setError(null);
      const current = () =>
        alive && lifetime.current === focus && getActiveVaultIdSyncMaybe() === vaultId;
      const applyRows = (rows: CreditCurrencySettings[]) => {
        const next = rows.map((row) =>
          touched.current.has(row.currency)
            ? (settingsRef.current.find((old) => old.currency === row.currency) ?? row)
            : row,
        );
        for (const old of settingsRef.current) {
          if (
            touched.current.has(old.currency) &&
            !next.some((row) => row.currency === old.currency)
          )
            next.push(old);
        }
        const nextDrafts = Object.fromEntries(
          next.map((row) => [
            row.currency,
            touched.current.has(row.currency) && draftsRef.current[row.currency]
              ? draftsRef.current[row.currency]
              : draftFor(row),
          ]),
        );
        settingsRef.current = next;
        draftsRef.current = nextDrafts;
        setSettings(next);
        setDrafts(nextDrafts);
        setCurrencyCode((code) =>
          next.some((row) => row.currency === code) ? code : (next[0]?.currency ?? null),
        );
      };
      void (async () => {
        if (!id || !vaultId || (routeVaultId && routeVaultId !== vaultId)) return;
        const session = await captureCurrentSession();
        const relationshipId = isDefault
          ? KAATA_DEFAULT_CREDIT_ID
          : await relationshipForCredit(id, vaultId);
        const [rows, role, customer] = await Promise.all([
          listCreditCurrencySettings(relationshipId, vaultId),
          readVaultRole(vaultId, session.accountId),
          isDefault ? null : getPerson(id),
        ]);
        await applyForUnchangedLocalSession(session, async () => {
          if (!current()) return;
          setCustomerName(customer?.name ?? null);
          setContext({ vaultId, relationshipId, session, lifetime: focus });
          setCanSave(role === "owner" || role === "manager");
          applyRows(rows);
        });
        if (!current()) return;
        await refreshCreditPolicies(vaultId, session).catch(() => undefined);
        const fresh = await listCreditCurrencySettings(relationshipId, vaultId);
        await applyForUnchangedLocalSession(session, async () => {
          if (current()) applyRows(fresh);
        });
      })().catch((err) => {
        if (current() && !(err instanceof SessionChangedError)) setError(t("credit.loadFailed"));
      });
      return () => {
        alive = false;
        lifetime.current++;
      };
    }, [id, routeVaultId, isDefault]),
  );

  useEffect(() => {
    let alive = true;
    setBalance(null);
    if (!context || !currencyCode || isDefault) return;
    const scope = context;
    void (async () => {
      const minor = await creditBalanceInTx(
        await getDb(),
        scope.vaultId,
        scope.relationshipId,
        currencyCode,
      );
      await applyForUnchangedLocalSession(scope.session, async () => {
        if (
          alive &&
          lifetime.current === scope.lifetime &&
          getActiveVaultIdSyncMaybe() === scope.vaultId
        )
          setBalance({ currency: currencyCode, minor });
      });
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [context, currencyCode, isDefault]);

  function changeDraft(change: Partial<Draft>) {
    if (!editable || saving.current || !currencyCode || !draftsRef.current[currencyCode]) return;
    if (
      !context ||
      lifetime.current !== context.lifetime ||
      getActiveVaultIdSyncMaybe() !== context.vaultId
    )
      return;
    touched.current.add(currencyCode);
    const value = { ...draftsRef.current[currencyCode], ...change };
    const row = settingsRef.current.find((item) => item.currency === currencyCode);
    if (!row) return;
    const original = draftFor(row);
    value.dirty =
      parseCap(value.collect) !== parseCap(original.collect) ||
      parseCap(value.pay) !== parseCap(original.pay) ||
      value.mode !== original.mode ||
      value.restrictEditors !== original.restrictEditors;
    const next = {
      ...draftsRef.current,
      [currencyCode]: value,
    };
    draftsRef.current = next;
    setDrafts(next);
    setError(null);
  }
  async function save() {
    if (!context || !editable || saving.current || !currencyCode) return;
    if (lifetime.current !== context.lifetime || getActiveVaultIdSyncMaybe() !== context.vaultId)
      return;
    const code = currencyCode;
    const value = draftsRef.current[code];
    if (!value) return;
    const maxCollect = parseCap(value.collect);
    const maxPay = parseCap(value.pay);
    if (maxCollect === undefined || maxPay === undefined) {
      setError(t("credit.limitInvalid"));
      return;
    }
    const saveAttempt = Symbol("credit-save");
    saving.current = saveAttempt;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveCreditPolicy(
        context.vaultId,
        {
          relationship_id: context.relationshipId,
          currency: code,
          max_collect_minor: maxCollect,
          max_pay_minor: maxPay,
          mode: value.mode,
          restrict_editors: value.restrictEditors,
          updated_at_ms: 0,
        },
        context.session,
      );
      await applyForUnchangedLocalSession(context.session, async () => {
        if (
          lifetime.current !== context.lifetime ||
          getActiveVaultIdSyncMaybe() !== context.vaultId
        )
          return;
        touched.current.add(code);
        const rows = settingsRef.current.map((row) =>
          row.currency === code ? { ...row, policy: saved } : row,
        );
        settingsRef.current = rows;
        setSettings(rows);
        const next = {
          ...draftsRef.current,
          [code]: draftFor({ currency: code, policy: saved, defaultPolicy: null }),
        };
        draftsRef.current = next;
        setDrafts(next);
        toast.push(t("credit.saved"), "success");
        if (rows.length === 1) {
          disablePrevention();
          router.back();
        }
      });
    } catch (err) {
      if (
        lifetime.current === context.lifetime &&
        getActiveVaultIdSyncMaybe() === context.vaultId &&
        !(err instanceof SessionChangedError)
      )
        setError(
          t(
            err instanceof ClerkCloudEnrollmentRequiredError
              ? "credit.clerksNeedSignIn"
              : err instanceof CreditOnlineSaveRequiredError
                ? "credit.onlineSave"
                : "credit.saveFailed",
          ),
        );
    } finally {
      if (saving.current === saveAttempt) {
        saving.current = null;
        if (lifetime.current === context.lifetime) setBusy(false);
      }
    }
  }
  function usage(raw: string, direction: "collect" | "pay") {
    if (!balance || balance.currency !== currencyCode) return null;
    const outstanding = Math.max(0, direction === "collect" ? balance.minor : -balance.minor);
    const cap = parseCap(raw);
    return (
      <View style={styles.usage}>
        <Text style={[styles.help, textDir(isRTL)]}>
          {t("credit.outstanding", { amount: formatAmount(fromMinorUnits(outstanding)) })}
        </Text>
        {cap != null ? (
          <Text style={[styles.help, textDir(isRTL), outstanding > cap && styles.error]}>
            {t(outstanding > cap ? "credit.limitOver" : "credit.limitLeft", {
              limit: formatAmount(fromMinorUnits(cap)),
              [outstanding > cap ? "over" : "left"]: formatAmount(
                fromMinorUnits(Math.abs(cap - outstanding)),
              ),
            })}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <SafeAreaView style={styles.screen}>
      <ScreenHeader
        title={t(isDefault ? "credit.defaultTitle" : "credit.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backDisabled={busy}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="height"
        enabled={Platform.OS === "android"}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {customerName ? (
            <Text style={[styles.label, textDir(isRTL)]}>
              {t("credit.forCustomer", { name: customerName })}
            </Text>
          ) : null}
          {context === null && !error ? <ActivityIndicator color={colors.textDefault} /> : null}
          {isDefault ? (
            <Text style={[styles.help, textDir(isRTL)]}>{t("credit.defaultHelp")}</Text>
          ) : null}
          {context ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("creditAlerts.title")}
              disabled={busy}
              accessibilityState={{ disabled: busy }}
              style={[styles.currencySelect, rowDir(isRTL), busy && styles.inputDisabled]}
              onPress={() => {
                if (
                  !saving.current &&
                  lifetime.current === context.lifetime &&
                  getActiveVaultIdSyncMaybe() === context.vaultId
                ) {
                  Keyboard.dismiss();
                  router.push({
                    pathname: "/person/[id]/credit-alerts",
                    params: { id, vaultId: context.vaultId },
                  });
                }
              }}
            >
              <Ionicons name="git-branch-outline" size={20} color={colors.textSubtle} />
              <View style={styles.currencyText}>
                <Text style={[styles.label, textDir(isRTL)]}>{t("creditAlerts.title")}</Text>
                <Text style={[styles.help, textDir(isRTL)]}>{t("creditAlerts.linkHelp")}</Text>
              </View>
              <Ionicons
                name={isRTL ? "chevron-back" : "chevron-forward"}
                size={18}
                color={colors.textMuted}
              />
            </Pressable>
          ) : null}
          {selected && draft ? (
            <>
              <View style={styles.currencySection}>
                <Text style={[styles.label, textDir(isRTL)]}>{t("credit.currency")}</Text>
                {settings.length > 1 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("credit.currency")}
                    accessibilityState={{ expanded: pickerOpen, disabled: busy }}
                    disabled={busy}
                    onPress={() => {
                      if (!saving.current) {
                        Keyboard.dismiss();
                        setPickerOpen(true);
                      }
                    }}
                    style={[styles.currencySelect, rowDir(isRTL), busy && styles.inputDisabled]}
                  >
                    <View style={styles.currencyText}>
                      <Text style={[styles.currencyCode, textDir(isRTL)]}>
                        {getCurrencyLabel(selected.currency)}
                      </Text>
                      <Text style={[styles.help, textDir(isRTL)]}>
                        {getCurrencyName(selected.currency)}
                      </Text>
                    </View>
                    <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
                  </Pressable>
                ) : (
                  <Text style={[styles.currencyCode, textDir(isRTL)]}>
                    {getCurrencyLabel(selected.currency)}
                  </Text>
                )}
                <Text style={[styles.help, textDir(isRTL)]}>{t("credit.currencyHelp")}</Text>
                {dirtyCount > 0 && settings.length > 1 ? (
                  <Text style={[styles.help, textDir(isRTL)]}>
                    {t("credit.unsavedCurrencies", { count: dirtyCount })}
                  </Text>
                ) : null}
              </View>
              {!isDefault && !selected.policy && selected.defaultPolicy ? (
                <Text style={[styles.help, textDir(isRTL)]}>{t("credit.usesDefault")}</Text>
              ) : null}
              <Text style={[styles.help, textDir(isRTL)]}>{t("credit.balanceHelp")}</Text>
              <Text style={[styles.label, textDir(isRTL)]}>
                {t("credit.maxCollect")} ({getCurrencyLabel(selected.currency)})
              </Text>
              <TextInput
                style={[styles.input, textDir(isRTL), controlsDisabled && styles.inputDisabled]}
                value={draft.collect}
                onChangeText={(value) => changeDraft({ collect: normalizeAmountInput(value) })}
                placeholder={t("credit.unlimited")}
                keyboardType="decimal-pad"
                editable={!controlsDisabled}
                accessibilityState={{ disabled: controlsDisabled }}
                accessibilityLabel={`${t("credit.maxCollect")} (${selected.currency})`}
              />
              {usage(draft.collect, "collect")}
              <Text style={[styles.label, textDir(isRTL)]}>
                {t("credit.maxPay")} ({getCurrencyLabel(selected.currency)})
              </Text>
              <TextInput
                style={[styles.input, textDir(isRTL), controlsDisabled && styles.inputDisabled]}
                value={draft.pay}
                onChangeText={(value) => changeDraft({ pay: normalizeAmountInput(value) })}
                placeholder={t("credit.unlimited")}
                keyboardType="decimal-pad"
                editable={!controlsDisabled}
                accessibilityState={{ disabled: controlsDisabled }}
                accessibilityLabel={`${t("credit.maxPay")} (${selected.currency})`}
              />
              {usage(draft.pay, "pay")}
              {currencyNeedsPrecisionHint(selected.currency) ? (
                <Text style={[styles.help, textDir(isRTL)]}>{t("currency.precisionHint")}</Text>
              ) : null}
              <Text style={[styles.help, textDir(isRTL)]}>{t("credit.zeroHelp")}</Text>
              <Text style={[styles.help, textDir(isRTL)]}>{t("credit.modeHelp")}</Text>
              <View
                style={[styles.modeCard, controlsDisabled && styles.modeCardDisabled]}
                accessibilityRole="radiogroup"
              >
                {(["warn", "clerks", "editors"] as const).map((choice, index) => {
                  const checked =
                    choice === "warn"
                      ? draft.mode === "warn"
                      : draft.mode === "clerk_block" &&
                        draft.restrictEditors === (choice === "editors");
                  return (
                    <Pressable
                      key={choice}
                      accessibilityRole="radio"
                      accessibilityState={{ checked, disabled: controlsDisabled }}
                      disabled={controlsDisabled}
                      style={({ pressed }) => [
                        styles.modeRow,
                        rowDir(isRTL),
                        index > 0 && styles.modeDivider,
                        checked && styles.modeSelected,
                        controlsDisabled && styles.modeDisabled,
                        pressed && !controlsDisabled && { opacity: 0.65 },
                      ]}
                      onPress={() =>
                        changeDraft({
                          mode: choice === "warn" ? "warn" : "clerk_block",
                          restrictEditors: choice === "editors",
                        })
                      }
                    >
                      <SelectionMark selected={checked} disabled={controlsDisabled} />
                      <Text
                        style={[
                          styles.modeLabel,
                          textDir(isRTL),
                          controlsDisabled && { color: colors.textMuted },
                        ]}
                      >
                        {t(
                          choice === "warn"
                            ? "credit.warnMode"
                            : choice === "clerks"
                              ? "credit.hardMode"
                              : "credit.editorsMode",
                        )}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[styles.help, textDir(isRTL)]}>{t("credit.hardHelp")}</Text>
              <Text style={[styles.help, textDir(isRTL)]}>{t("credit.onlineSave")}</Text>
              {error ? <Text style={[styles.error, textDir(isRTL)]}>{error}</Text> : null}
              <Button
                label={
                  settings.length > 1
                    ? t("credit.saveCurrency", { currency: selected.currency })
                    : t("credit.save")
                }
                onPress={() => void save()}
                disabled={controlsDisabled}
                loading={busy}
              />
            </>
          ) : error ? (
            <Text style={[styles.error, textDir(isRTL)]}>{error}</Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <CurrencyPickerSheet
        visible={pickerOpen && !!context && getActiveVaultIdSyncMaybe() === context.vaultId}
        selectedCode={currencyCode ?? ""}
        title={t("credit.currency")}
        allowedCurrencies={settings.map((row) => row.currency)}
        disabled={busy}
        onSelect={(code) => {
          if (
            !context ||
            lifetime.current !== context.lifetime ||
            getActiveVaultIdSyncMaybe() !== context.vaultId
          )
            return;
          if (saving.current || !settingsRef.current.some((row) => row.currency === code)) return;
          setCurrencyCode(code);
          setPickerOpen(false);
          setError(null);
        }}
        onDismiss={() => setPickerOpen(false)}
      />
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
  modeCard: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    overflow: "hidden",
  },
  modeRow: { minHeight: 52, alignItems: "center", padding: 14, gap: 12 },
  modeDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
  modeSelected: { backgroundColor: colors.bgMuted },
  modeCardDisabled: { borderColor: colors.borderSubtle },
  modeDisabled: { backgroundColor: colors.bgMuted },
  modeLabel: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.textEmphasis, flex: 1 },
  screen: { flex: 1, backgroundColor: colors.bgDefault },
  body: { padding: 20, gap: 12 },
  currencySection: { gap: 8 },
  currencySelect: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    gap: 12,
  },
  currencyText: { flex: 1, gap: 4 },
  currencyCode: { fontFamily: fonts.sansMedium, fontSize: 18, color: colors.textEmphasis },
  usage: { gap: 2 },
  label: { fontFamily: fonts.sansMedium, fontSize: 15, color: colors.textDefault },
  input: {
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 10,
    padding: 14,
    color: colors.textDefault,
    backgroundColor: colors.bgDefault,
    fontFamily: fonts.sansRegular,
    fontSize: 18,
  },
  inputDisabled: {
    backgroundColor: colors.bgMuted,
    borderColor: colors.borderSubtle,
    color: colors.textMuted,
  },
  help: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    lineHeight: sansLineHeight(13, 20),
    color: colors.textMuted,
  },
  error: { fontFamily: fonts.sansRegular, color: colors.danger, fontSize: 14 },
});
