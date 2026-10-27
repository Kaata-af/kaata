import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState, Text } from "react-native";
import { colors } from "../lib/colors";
import { getCurrencyLabel, useCurrency } from "../lib/currency";
import { bidiIsolate, useIsRTL } from "../lib/direction";
import { formatAmount, formatRelative } from "../lib/format";
import { faDigits } from "../lib/jalali";
import { fromMinorUnits } from "../lib/money";
import { applyForUnchangedLocalSession, captureCurrentSession } from "../lib/auth";
import {
  creditBalanceInTx,
  type CreditRefusal,
  fetchCreditRefusals,
  readEffectiveCreditPolicy,
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
type CreditDetail = { status: CreditStatus; cap: number | null; exposure: number };
const NO_DETAIL: CreditDetail = { status: "none", cap: null, exposure: 0 };

export function useCreditStatus(
  personId: string,
  vaultId: string | null,
  currency?: string,
): CreditStatus {
  const selected = useCurrency();
  return useCreditDetail(personId, vaultId, currency ?? selected).status;
}

/** The status plus the cap in force and the exposure against it (minor
 *  units), so every role, clerks included, can see how much credit is left. */
function useCreditDetail(personId: string, vaultId: string | null, currency: string): CreditDetail {
  const scope = JSON.stringify([personId, vaultId, currency]);
  const [detail, setDetail] = useState<{ scope: string; value: CreditDetail }>({
    scope: "",
    value: NO_DETAIL,
  });
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      let generation = 0;
      setDetail({ scope, value: NO_DETAIL });
      async function load(refresh = false) {
        const request = ++generation;
        if (!vaultId || getActiveVaultIdSyncMaybe() !== vaultId) return;
        const session = await captureCurrentSession();
        if (refresh) await refreshCreditPolicies(vaultId, session).catch(() => undefined);
        const rel = await relationshipForCredit(personId, vaultId);
        const p = await readEffectiveCreditPolicy(rel, vaultId, currency);
        const balance = await creditBalanceInTx(await getDb(), vaultId, rel, currency);
        // A zero balance shows the "they owe us" cap: that is the credit a
        // shopkeeper or clerk is about to give.
        const cap =
          balance > 0
            ? p?.max_collect_minor
            : balance < 0
              ? p?.max_pay_minor
              : (p?.max_collect_minor ?? p?.max_pay_minor);
        const exposure = Math.abs(balance);
        const next: CreditStatus =
          cap != null && exposure > cap
            ? "over"
            : cap != null && exposure > 0 && exposure * 5 >= cap * 4
              ? "near"
              : "none";
        await applyForUnchangedLocalSession(session, async () => {
          if (alive && request === generation && getActiveVaultIdSyncMaybe() === vaultId)
            setDetail({ scope, value: { status: next, cap: cap ?? null, exposure } });
        }).catch(() => undefined);
      }
      // Paint from this phone's cached policy first, then refresh it: the
      // label used to vanish on every visit until the network answered
      // (up to 10 s, audit #24).
      void load(false)
        .then(() => load(true))
        .catch(() => undefined);
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
    }, [personId, vaultId, currency]),
  );
  return detail.scope === scope ? detail.value : NO_DETAIL;
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
/** Owner/manager only (the server answers no one else): what the limit
 *  stopped for this customer in the last 30 days, newest first. */
function useCustomerRefusals(
  personId: string,
  vaultId: string | null,
  currency: string,
): CreditRefusal[] {
  const scope = JSON.stringify([personId, vaultId, currency]);
  const [rows, setRows] = useState<{ scope: string; value: CreditRefusal[] }>({
    scope: "",
    value: [],
  });
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setRows({ scope, value: [] });
      void (async () => {
        if (!vaultId || getActiveVaultIdSyncMaybe() !== vaultId) return;
        const session = await captureCurrentSession();
        const all = await fetchCreditRefusals(vaultId, session, currency);
        if (all.length === 0) return;
        const rel = await relationshipForCredit(personId, vaultId);
        await applyForUnchangedLocalSession(session, async () => {
          if (alive && getActiveVaultIdSyncMaybe() === vaultId)
            setRows({
              scope,
              value: all.filter(
                (r) => r.relationship_id === rel && (!r.currency || r.currency === currency),
              ),
            });
        });
      })().catch(() => undefined);
      return () => {
        alive = false;
      };
    }, [personId, vaultId, currency]),
  );
  return rows.scope === scope ? rows.value : [];
}
function CreditRefusalsText({
  personId,
  vaultId,
  currency,
}: {
  personId: string;
  vaultId: string | null;
  currency: string;
}) {
  const rows = useCustomerRefusals(personId, vaultId, currency);
  const isRTL = useIsRTL();
  if (rows.length === 0) return null;
  const latest = rows[0];
  const amount = `${formatAmount(fromMinorUnits(latest.amount_minor))} ${getCurrencyLabel(latest.currency ?? currency)}`;
  const params = {
    name: latest.actor_name.trim() || t("credit.refusalSomeone"),
    what: `${t(latest.type === "debt" ? "person.action.iGave" : "person.action.iReceived")} ${bidiIsolate(amount)}`,
    when: formatRelative(latest.refused_at_ms),
    count: isRTL ? faDigits(String(rows.length)) : rows.length,
  };
  return (
    <Text
      style={{
        fontFamily: fonts.sansRegular,
        fontSize: 12,
        color: colors.textSubtle,
        writingDirection: "auto",
      }}
    >
      {t(rows.length === 1 ? "credit.refusalOne" : "credit.refusalMany", params)}
    </Text>
  );
}
function PersonCreditStatus({
  personId,
  vaultId,
  currency,
}: {
  personId: string;
  vaultId: string | null;
  currency?: string;
}) {
  const selected = useCurrency();
  const code = currency ?? selected;
  const { status, cap, exposure } = useCreditDetail(personId, vaultId, code);
  if (cap == null)
    return (
      <>
        <CreditStatusText status={status} />
        <CreditRefusalsText personId={personId} vaultId={vaultId} currency={code} />
      </>
    );
  const symbol = getCurrencyLabel(code);
  const money = (minor: number) => `${formatAmount(fromMinorUnits(minor))} ${symbol}`;
  return (
    <>
      <CreditStatusText status={status} />
      <Text
        style={{
          fontFamily: fonts.sansRegular,
          fontSize: 12,
          color: colors.textSubtle,
          writingDirection: "auto",
        }}
      >
        {t(exposure > cap ? "credit.limitOver" : "credit.limitLeft", {
          limit: bidiIsolate(money(cap)),
          left: bidiIsolate(money(Math.max(0, cap - exposure))),
          over: bidiIsolate(money(Math.max(0, exposure - cap))),
        })}
      </Text>
      <CreditRefusalsText personId={personId} vaultId={vaultId} currency={code} />
    </>
  );
}
export function CreditStatusBadge(
  props: { status: CreditStatus } | { personId: string; vaultId: string | null; currency?: string },
) {
  return "status" in props ? (
    <CreditStatusText status={props.status} />
  ) : (
    <PersonCreditStatus {...props} />
  );
}
