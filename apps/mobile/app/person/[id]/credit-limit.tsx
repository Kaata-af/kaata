import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { SelectionMark } from "../../../components/SelectionMark";
import { ScreenHeader } from "../../../components/SettingsScreen";
import { useToast } from "../../../components/Toast";
import { colors } from "../../../lib/colors";
import { currencyNeedsPrecisionHint, getCurrencyLabel, useCurrency } from "../../../lib/currency";
import {
  type CreditPolicy,
  KAATA_DEFAULT_CREDIT_ID,
  readCreditPolicy,
  refreshCreditPolicies,
  relationshipForCredit,
  saveCreditPolicy,
  ClerkCloudEnrollmentRequiredError,
  CreditOnlineSaveRequiredError,
} from "../../../lib/credit-limits";
import { KAATA_DEFAULT_ROUTE_ID } from "../../../lib/credit-policy";
import { getActiveVaultIdSyncMaybe } from "../../../lib/db-tx";
import {
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../../lib/auth";
import { rowDir, textDir, useIsRTL } from "../../../lib/direction";
import { getPerson } from "../../../lib/db";
import { fonts, sansLineHeight } from "../../../lib/fonts";
import { t } from "../../../lib/i18n";
import { fromMinorUnits, normalizeAmountInput, toMinorUnits } from "../../../lib/money";
import { readVaultRole, useActiveVaultWriteCaps } from "../../../lib/use-vault-role";

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
  const currencyCode = useCurrency();
  const currency = getCurrencyLabel(currencyCode);
  const [collect, setCollect] = useState("");
  const [pay, setPay] = useState("");
  const [mode, setMode] = useState<CreditPolicy["mode"]>("warn");
  const [restrictEditors, setRestrictEditors] = useState(false);
  const [context, setContext] = useState<{
    vaultId: string;
    relationshipId: string;
    session: SessionSnapshot;
    lifetime: number;
    currency: string;
  } | null>(null);
  const [canSave, setCanSave] = useState(false);
  // Whose limits these are: the screen used to name no one (audit #24).
  const [customerName, setCustomerName] = useState<string | null>(null);
  // The kaata-wide default (no customer), and for a customer whether the
  // default covers them while they have no limit of their own.
  const isDefault = id === KAATA_DEFAULT_ROUTE_ID;
  const [inheritsDefault, setInheritsDefault] = useState(false);
  const liveVaultId = context?.vaultId ?? null;
  const caps = useActiveVaultWriteCaps(liveVaultId);
  const editable =
    !!context &&
    canSave &&
    caps.resolved &&
    caps.canConfigureCredit &&
    context.currency === currencyCode &&
    getActiveVaultIdSyncMaybe() === liveVaultId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const lifetime = useRef(0);
  const editVersion = useRef(0);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const focus = ++lifetime.current;
      editVersion.current = 0;
      const vaultId = getActiveVaultIdSyncMaybe();
      setContext(null);
      setCanSave(false);
      void (async () => {
        if (!id || !vaultId || (routeVaultId && routeVaultId !== vaultId)) return;
        const session = await captureCurrentSession();
        const relationshipId = isDefault
          ? KAATA_DEFAULT_CREDIT_ID
          : await relationshipForCredit(id, vaultId);
        const p = await readCreditPolicy(relationshipId, vaultId, currencyCode);
        const covered =
          !isDefault &&
          !p &&
          (await readCreditPolicy(KAATA_DEFAULT_CREDIT_ID, vaultId, currencyCode)) != null;
        const role = await readVaultRole(vaultId, session.accountId);
        const customer = isDefault ? null : await getPerson(id);
        await applyForUnchangedLocalSession(session, async () => {
          if (!alive || lifetime.current !== focus || getActiveVaultIdSyncMaybe() !== vaultId)
            return;
          setCustomerName(customer?.name ?? null);
          setContext({ vaultId, relationshipId, session, lifetime: focus, currency: currencyCode });
          setCollect(
            p?.max_collect_minor == null ? "" : String(fromMinorUnits(p.max_collect_minor)),
          );
          setPay(p?.max_pay_minor == null ? "" : String(fromMinorUnits(p.max_pay_minor)));
          setMode(p?.mode ?? "warn");
          setRestrictEditors(!!p?.restrict_editors);
          setInheritsDefault(covered);
          setCanSave(role === "owner" || role === "manager");
        });
        await refreshCreditPolicies(vaultId, session).catch(() => undefined);
        const fresh = await readCreditPolicy(relationshipId, vaultId, currencyCode);
        await applyForUnchangedLocalSession(session, async () => {
          if (
            !alive ||
            lifetime.current !== focus ||
            editVersion.current !== 0 ||
            getActiveVaultIdSyncMaybe() !== vaultId
          )
            return;
          setCollect(
            fresh?.max_collect_minor == null ? "" : String(fromMinorUnits(fresh.max_collect_minor)),
          );
          setPay(fresh?.max_pay_minor == null ? "" : String(fromMinorUnits(fresh.max_pay_minor)));
          setMode(fresh?.mode ?? "warn");
          setRestrictEditors(!!fresh?.restrict_editors);
        });
      })().catch((err) => {
        // A failed LOAD is not a failed save.
        if (alive && lifetime.current === focus && !(err instanceof SessionChangedError))
          setError(t("credit.loadFailed"));
      });
      return () => {
        alive = false;
        lifetime.current++;
      };
    }, [id, routeVaultId, isDefault, currencyCode]),
  );
  async function save() {
    if (!context || !editable || saving.current) return;
    const maxCollect = parseCap(collect);
    const maxPay = parseCap(pay);
    if (maxCollect === undefined || maxPay === undefined) {
      setError(t("credit.limitInvalid"));
      return;
    }
    if (getActiveVaultIdSyncMaybe() !== context.vaultId) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await saveCreditPolicy(
        context.vaultId,
        {
          relationship_id: context.relationshipId,
          currency: context.currency,
          max_collect_minor: maxCollect,
          max_pay_minor: maxPay,
          mode,
          restrict_editors: restrictEditors,
          updated_at_ms: 0,
        },
        context.session,
      );
      await applyForUnchangedLocalSession(context.session, async () => {
        if (
          lifetime.current === context.lifetime &&
          getActiveVaultIdSyncMaybe() === context.vaultId
        ) {
          toast.push(t("credit.saved"), "success");
          router.back();
        }
      });
    } catch (err) {
      if (lifetime.current === context.lifetime && !(err instanceof SessionChangedError))
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
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={styles.screen}>
      <ScreenHeader
        title={t(isDefault ? "credit.defaultTitle" : "credit.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backDisabled={busy}
      />
      {/* Android does not resize for the keyboard; without this the decimal
          pad covered Save (audit #24). iOS adjusts the ScrollView insets. */}
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
          ) : inheritsDefault ? (
            <Text style={[styles.help, textDir(isRTL)]}>{t("credit.usesDefault")}</Text>
          ) : null}
          <Text style={[styles.label, textDir(isRTL)]}>
            {t("credit.maxCollect")} ({currency})
          </Text>
          <TextInput
            style={[styles.input, textDir(isRTL)]}
            value={collect}
            onChangeText={(v) => {
              editVersion.current++;
              setCollect(normalizeAmountInput(v));
            }}
            placeholder={t("credit.unlimited")}
            keyboardType="decimal-pad"
            editable={editable && !busy}
            accessibilityLabel={`${t("credit.maxCollect")} (${currency})`}
          />
          <Text style={[styles.label, textDir(isRTL)]}>
            {t("credit.maxPay")} ({currency})
          </Text>
          <TextInput
            style={[styles.input, textDir(isRTL)]}
            value={pay}
            onChangeText={(v) => {
              editVersion.current++;
              setPay(normalizeAmountInput(v));
            }}
            placeholder={t("credit.unlimited")}
            keyboardType="decimal-pad"
            editable={editable && !busy}
            accessibilityLabel={`${t("credit.maxPay")} (${currency})`}
          />
          {currencyNeedsPrecisionHint(currencyCode) ? (
            <Text style={[styles.help, textDir(isRTL)]}>{t("currency.precisionHint")}</Text>
          ) : null}
          <Text style={[styles.help, textDir(isRTL)]}>{t("credit.zeroHelp")}</Text>
          <Text style={[styles.help, textDir(isRTL)]}>{t("credit.modeHelp")}</Text>
          <View style={styles.modeCard} accessibilityRole="radiogroup">
            {(["warn", "clerks", "editors"] as const).map((choice, index) => {
              const selected =
                choice === "warn"
                  ? mode === "warn"
                  : mode === "clerk_block" && restrictEditors === (choice === "editors");
              return (
                <Pressable
                  key={choice}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: !editable || busy }}
                  disabled={!editable || busy}
                  style={({ pressed }) => [
                    styles.modeRow,
                    rowDir(isRTL),
                    index > 0 && styles.modeDivider,
                    selected && styles.modeSelected,
                    pressed && { opacity: 0.65 },
                  ]}
                  onPress={() => {
                    editVersion.current++;
                    setMode(choice === "warn" ? "warn" : "clerk_block");
                    setRestrictEditors(choice === "editors");
                  }}
                >
                  <SelectionMark selected={selected} />
                  <Text style={[styles.modeLabel, textDir(isRTL)]}>
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
            label={t("credit.save")}
            onPress={() => void save()}
            disabled={!editable || busy}
            loading={busy}
          />
        </ScrollView>
      </KeyboardAvoidingView>
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
  modeLabel: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.textEmphasis, flex: 1 },
  screen: { flex: 1, backgroundColor: colors.bgDefault },
  body: { padding: 20, gap: 12 },
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
  help: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    lineHeight: sansLineHeight(13, 20),
    color: colors.textMuted,
  },
  error: { fontFamily: fonts.sansRegular, color: colors.danger, fontSize: 14 },
  gap: { height: 0 },
});
