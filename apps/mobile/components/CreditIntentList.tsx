import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { applyForUnchangedLocalSession, captureCurrentSession } from "../lib/auth";
import { type CreditIntent, listCreditIntents } from "../lib/credit-limits";
import { getActiveVaultIdSyncMaybe } from "../lib/db-tx";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { onLedgerApplied } from "../lib/ledger-events";
import { formatMoneyAmount } from "../lib/money";
import { onTabApplied } from "../lib/tabs/events";

// Intent is deliberately a separate surface: it is not money in the ledger,
// cannot be reviewed/exported, and no cancellation promises a server rollback.
export function CreditIntentList({
  personId,
  vaultId,
}: {
  personId: string;
  vaultId: string | null;
}) {
  const [rows, setRows] = useState<CreditIntent[]>([]);
  const isRTL = useIsRTL();
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      let generation = 0;
      setRows([]);
      async function load() {
        const request = ++generation;
        if (!vaultId || getActiveVaultIdSyncMaybe() !== vaultId) return;
        const session = await captureCurrentSession();
        const next = await listCreditIntents(personId, vaultId).catch(() => []);
        await applyForUnchangedLocalSession(session, async () => {
          if (alive && request === generation && getActiveVaultIdSyncMaybe() === vaultId)
            setRows(next);
        }).catch(() => undefined);
      }
      void load();
      const ledger = onLedgerApplied((eventVaultId) => {
        if (eventVaultId === vaultId) void load();
      });
      const tabs = onTabApplied((e) => {
        if (e.vaultId === vaultId) void load();
      });
      const app = AppState.addEventListener("change", (s) => {
        if (s === "active") void load();
      });
      return () => {
        alive = false;
        generation++;
        ledger();
        tabs();
        app.remove();
      };
    }, [personId, vaultId]),
  );
  if (!rows.length) return null;
  return (
    <View style={styles.box}>
      <Text style={[styles.title, textDir(isRTL)]}>{t("credit.intentsTitle")}</Text>
      {rows.map((r) => (
        <View key={r.id} style={styles.row}>
          <Text style={[styles.amount, textDir(isRTL)]}>
            {r.type === "debt" ? t("person.action.iGave") : t("person.action.iReceived")} ·{" "}
            {formatMoneyAmount(r.amount_afn)}
          </Text>
          {r.note ? <Text style={[styles.note, textDir(isRTL)]}>{r.note}</Text> : null}
          <Text style={[styles.status, textDir(isRTL)]}>
            {t(r.admission_status === "refused" ? "credit.refused" : "credit.pending")}
          </Text>
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  box: {
    marginHorizontal: 16,
    marginVertical: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    backgroundColor: colors.bgDefault,
  },
  title: { fontFamily: fonts.sansMedium, color: colors.textDefault, fontSize: 14 },
  row: { marginTop: 12 },
  amount: { fontFamily: fonts.sansMedium, color: colors.textDefault, fontSize: 15 },
  note: { fontFamily: fonts.sansRegular, color: colors.textMuted, fontSize: 14, marginTop: 3 },
  status: { fontFamily: fonts.sansRegular, color: colors.textMuted, fontSize: 12, marginTop: 4 },
});
