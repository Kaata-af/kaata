import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { applyForUnchangedLocalSession, captureCurrentSession } from "../lib/auth";
import { type CreditIntent, listCreditIntents } from "../lib/credit-limits";
import { getActiveVaultIdSyncMaybe } from "../lib/db-tx";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { getLocale, t } from "../lib/i18n";
import { onLedgerApplied } from "../lib/ledger-events";
import { formatMoneyAmount } from "../lib/money";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { formatRelative } from "../lib/format";
import { useToast } from "./Toast";
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
  // Signed out, a waiting attempt can never be sent: say so instead of
  // "Waiting for server confirmation" forever (audit #24).
  const [signedIn, setSignedIn] = useState(true);
  const isRTL = useIsRTL();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // A waiting attempt the server later refuses is announced once, while the
  // page is up, instead of changing grey words at the bottom (audit #24).
  const statuses = useRef(new Map<string, CreditIntent["admission_status"]>());
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      let generation = 0;
      setRows([]);
      statuses.current = new Map();
      async function load() {
        const request = ++generation;
        if (!vaultId || getActiveVaultIdSyncMaybe() !== vaultId) return;
        const session = await captureCurrentSession();
        const next = await listCreditIntents(personId, vaultId).catch(() => []);
        await applyForUnchangedLocalSession(session, async () => {
          if (!alive || request !== generation || getActiveVaultIdSyncMaybe() !== vaultId) return;
          const refusedNow = next.filter(
            (row) =>
              row.admission_status === "refused" && statuses.current.get(row.id) === "pending",
          );
          statuses.current = new Map(next.map((row) => [row.id, row.admission_status]));
          setSignedIn(session.jwt != null);
          if (refusedNow.length > 0) toastRef.current.push(t("credit.blocked"), "error");
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
      {rows.map((r) => {
        const refused = r.admission_status === "refused";
        return (
          <View key={r.id} style={styles.row}>
            <Text style={[styles.amount, textDir(isRTL)]}>
              {r.type === "debt" ? t("person.action.iGave") : t("person.action.iReceived")} ·{" "}
              {formatMoneyAmount(r.amount_afn)} {getCurrentCurrencySymbol()}
            </Text>
            {r.note ? <Text style={[styles.note, textDir(isRTL)]}>{r.note}</Text> : null}
            {/* Refused and waiting no longer look alike: a red or amber dot,
                and when it was tried. */}
            <View style={[styles.statusRow, isRTL && { flexDirection: "row-reverse" }]}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: refused ? colors.danger : colors.reviewPending },
                ]}
              />
              <Text
                style={[
                  styles.status,
                  textDir(isRTL),
                  { color: refused ? colors.danger : colors.textMuted },
                ]}
              >
                {t(
                  refused ? "credit.refused" : signedIn ? "credit.pending" : "credit.signInToSend",
                )}
                {/* A middle dot beside Persian digits reads as a zero. */}
                {getLocale() === "fa" ? "، " : " · "}
                {formatRelative(r.created_at)}
              </Text>
            </View>
          </View>
        );
      })}
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
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  status: { fontFamily: fonts.sansRegular, color: colors.textMuted, fontSize: 12, flexShrink: 1 },
});
