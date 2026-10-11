import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../components/Button";
import { ScreenHeader } from "../../../components/SettingsScreen";
import { useToast } from "../../../components/Toast";
import { colors } from "../../../lib/colors";
import { getCurrentCurrencySymbol } from "../../../lib/currency";
import {
  type CreditPolicy,
  readCreditPolicy,
  refreshCreditPolicies,
  relationshipForCredit,
  saveCreditPolicy,
  ClerkCloudEnrollmentRequiredError,
  CreditOnlineSaveRequiredError,
} from "../../../lib/credit-limits";
import { getActiveVaultIdSyncMaybe } from "../../../lib/db-tx";
import {
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "../../../lib/auth";
import { textDir, useIsRTL } from "../../../lib/direction";
import { fonts } from "../../../lib/fonts";
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
  const currency = getCurrentCurrencySymbol();
  const [collect, setCollect] = useState("");
  const [pay, setPay] = useState("");
  const [mode, setMode] = useState<CreditPolicy["mode"]>("warn");
  const [context, setContext] = useState<{
    vaultId: string;
    relationshipId: string;
    session: SessionSnapshot;
    lifetime: number;
  } | null>(null);
  const [canSave, setCanSave] = useState(false);
  const liveVaultId = context?.vaultId ?? null;
  const caps = useActiveVaultWriteCaps(liveVaultId);
  const editable =
    !!context &&
    canSave &&
    caps.resolved &&
    caps.canConfigureCredit &&
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
        const relationshipId = await relationshipForCredit(id, vaultId);
        const p = await readCreditPolicy(relationshipId, vaultId);
        const role = await readVaultRole(vaultId, session.accountId);
        await applyForUnchangedLocalSession(session, async () => {
          if (!alive || lifetime.current !== focus || getActiveVaultIdSyncMaybe() !== vaultId)
            return;
          setContext({ vaultId, relationshipId, session, lifetime: focus });
          setCollect(
            p?.max_collect_minor == null ? "" : String(fromMinorUnits(p.max_collect_minor)),
          );
          setPay(p?.max_pay_minor == null ? "" : String(fromMinorUnits(p.max_pay_minor)));
          setMode(p?.mode ?? "warn");
          setCanSave(role === "owner" || role === "manager");
        });
        await refreshCreditPolicies(vaultId, session).catch(() => undefined);
        const fresh = await readCreditPolicy(relationshipId, vaultId);
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
        });
      })().catch((err) => {
        if (alive && lifetime.current === focus && !(err instanceof SessionChangedError))
          setError(t("credit.saveFailed"));
      });
      return () => {
        alive = false;
        lifetime.current++;
      };
    }, [id, routeVaultId]),
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
          max_collect_minor: maxCollect,
          max_pay_minor: maxPay,
          mode,
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
        title={t("credit.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        backDisabled={busy}
      />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
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
        <Button
          label={t("credit.warnMode")}
          variant={mode === "warn" ? "primary" : "secondary"}
          onPress={() => {
            editVersion.current++;
            setMode("warn");
          }}
          disabled={!editable || busy}
        />
        <View style={styles.gap} />
        <Button
          label={t("credit.hardMode")}
          variant={mode === "clerk_block" ? "primary" : "secondary"}
          onPress={() => {
            editVersion.current++;
            setMode("clerk_block");
          }}
          disabled={!editable || busy}
        />
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
  help: { fontFamily: fonts.sansRegular, fontSize: 13, lineHeight: 20, color: colors.textMuted },
  error: { fontFamily: fonts.sansRegular, color: colors.danger, fontSize: 14 },
  gap: { height: 0 },
});
