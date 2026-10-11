import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState, Text } from "react-native";
import { colors } from "../lib/colors";
import { applyForUnchangedLocalSession, captureCurrentSession } from "../lib/auth";
import {
  creditBalanceInTx,
  readCreditPolicy,
  refreshCreditPolicies,
  relationshipForCredit,
} from "../lib/credit-limits";
import { getActiveVaultIdSyncMaybe, getDb } from "../lib/db-tx";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";
import { onLedgerApplied } from "../lib/ledger-events";
import { onTabApplied } from "../lib/tabs/events";
import { onCreditPoliciesChanged } from "../lib/credit-policy-events";

export type CreditStatus = "none" | "near" | "over";
export function useCreditStatus(personId: string, vaultId: string | null): CreditStatus {
  const [status, setStatus] = useState<CreditStatus>("none");
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      let generation = 0;
      setStatus("none");
      async function load(refresh = false) {
        const request = ++generation;
        if (!vaultId || getActiveVaultIdSyncMaybe() !== vaultId) return;
        const session = await captureCurrentSession();
        if (refresh) await refreshCreditPolicies(vaultId, session).catch(() => undefined);
        const rel = await relationshipForCredit(personId, vaultId);
        const p = await readCreditPolicy(rel, vaultId);
        const balance = await creditBalanceInTx(await getDb(), vaultId, rel);
        const cap = balance > 0 ? p?.max_collect_minor : p?.max_pay_minor;
        const exposure = Math.abs(balance);
        const next: CreditStatus =
          cap != null && exposure > cap
            ? "over"
            : cap != null && exposure > 0 && exposure * 5 >= cap * 4
              ? "near"
              : "none";
        await applyForUnchangedLocalSession(session, async () => {
          if (alive && request === generation && getActiveVaultIdSyncMaybe() === vaultId)
            setStatus(next);
        }).catch(() => undefined);
      }
      void load(true).catch(() => undefined);
      const ledger = onLedgerApplied((eventVaultId) => {
        if (eventVaultId === vaultId) void load().catch(() => undefined);
      });
      const tabs = onTabApplied((e) => {
        if (e.vaultId === vaultId) void load().catch(() => undefined);
      });
      const policies = onCreditPoliciesChanged((changedVault) => {
        if (changedVault === vaultId) void load().catch(() => undefined);
      });
      const app = AppState.addEventListener("change", (s) => {
        if (s === "active") void load(true).catch(() => undefined);
      });
      return () => {
        alive = false;
        generation++;
        ledger();
        tabs();
        policies();
        app.remove();
      };
    }, [personId, vaultId]),
  );
  return status;
}
function CreditStatusText({ status }: { status: CreditStatus }) {
  return status === "none" ? null : (
    <Text
      style={{
        fontFamily: fonts.sansRegular,
        fontSize: 12,
        color: status === "over" ? colors.danger : colors.reviewPending,
      }}
    >
      {t(status === "over" ? "credit.statusOver" : "credit.statusNear")}
    </Text>
  );
}
function PersonCreditStatus({ personId, vaultId }: { personId: string; vaultId: string | null }) {
  const status = useCreditStatus(personId, vaultId);
  return <CreditStatusText status={status} />;
}
export function CreditStatusBadge(
  props: { status: CreditStatus } | { personId: string; vaultId: string | null },
) {
  return "status" in props ? (
    <CreditStatusText status={props.status} />
  ) : (
    <PersonCreditStatus {...props} />
  );
}
