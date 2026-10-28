import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const text = (value: any): string =>
  Array.isArray(value)
    ? value.map(text).join(" ")
    : value && typeof value === "object"
      ? text(value.props?.children)
      : value == null
        ? ""
        : String(value);
function fixture() {
  const hooks = uiHooks();
  let selected = "AFN";
  const ledger = new Set<(...args: any[]) => void>();
  const calls: { policy: string[]; balance: string[]; intents: any[] } = {
    policy: [],
    balance: [],
    intents: [],
  };
  let hold: ReturnType<typeof deferred<any>> | null = null;
  const native = {
    AppState: { addEventListener: () => ({ remove() {} }) },
    Text: "Text",
    View: "View",
    StyleSheet: { create: (s: any) => s },
  };
  const session = { accountId: "owner", jwt: "jwt", bindingVersion: 1 };
  const common: Record<string, any> = {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": native,
    "expo-router": { useFocusEffect: (effect: any) => hooks.react.useEffect(effect, [effect]) },
    "../lib/colors": require("../colors"),
    "../lib/currency": {
      useCurrency: () => selected,
      getCurrencyLabel: (code: string) => code,
    },
    "../lib/direction": {
      bidiIsolate: (s: string) => s,
      useIsRTL: () => false,
      textDir: () => ({}),
    },
    "../lib/format": { formatAmount: String, formatRelative: () => "now" },
    "../lib/jalali": { faDigits: String },
    "../lib/money": require("../money"),
    "../lib/auth": {
      captureCurrentSession: async () => session,
      applyForUnchangedLocalSession: async (_s: any, work: any) => work(),
    },
    "../lib/db-tx": { getActiveVaultIdSyncMaybe: () => "v", getDb: async () => ({}) },
    "../lib/fonts": { fonts: {} },
    "../lib/i18n": {
      getLocale: () => "en",
      t: (key: string, params: any) => key + (params ? JSON.stringify(params) : ""),
    },
    "../lib/ledger-events": {
      onLedgerApplied: (fn: any) => {
        ledger.add(fn);
        return () => ledger.delete(fn);
      },
    },
    "../lib/tabs/events": { onTabApplied: () => () => {} },
    "../lib/credit-policy-events": { onCreditPoliciesChanged: () => () => {} },
    "./Toast": { useToast: () => ({ push() {} }) },
    "../lib/credit-limits": {
      relationshipForCredit: async () => "r",
      refreshCreditPolicies: async () => {},
      fetchCreditRefusals: async () => [],
      readEffectiveCreditPolicy: async (_r: string, _v: string, code: string) => {
        calls.policy.push(code);
        if (hold && code === "USD") return hold.promise;
        return { max_collect_minor: code === "USD" ? 10000 : 20000, max_pay_minor: 0 };
      },
      creditBalanceInTx: async (_db: any, _v: string, _r: string, code: string) => {
        calls.balance.push(code);
        return code === "USD" ? 9000 : 0;
      },
      listCreditIntents: async (...args: any[]) => {
        calls.intents.push(args);
        return args[3]?.allCurrencies
          ? [
              {
                id: "afn",
                currency: "AFN",
                type: "debt",
                amount_afn: 1,
                created_at: 1,
                admission_status: "pending",
              },
              {
                id: "usd",
                currency: "USD",
                type: "payment",
                amount_afn: 2,
                created_at: 2,
                admission_status: "refused",
              },
              {
                id: "gbp",
                currency: "GBP",
                type: "debt",
                amount_afn: 3,
                created_at: 3,
                admission_status: "pending",
              },
            ]
          : [];
      },
    },
  };
  return {
    hooks,
    calls,
    ledger,
    common,
    hold: (value: ReturnType<typeof deferred<any>> | null) => {
      hold = value;
    },
    select: (value: string) => {
      selected = value;
    },
    settle: async () => {
      for (let i = 0; i < 3; i++) {
        await settleUI();
        hooks.render();
      }
    },
  };
}
async function main() {
  const badge = fixture();
  const Badge = compileUI("../../components/CreditStatusBadge", badge.common).CreditStatusBadge;
  let code = "USD";
  const renderBadge = () => {
    const child = Badge({ personId: "p", vaultId: "v", currency: code });
    return child.type(child.props);
  };
  badge.hooks.render(renderBadge);
  await badge.settle();
  assert.ok(badge.calls.policy.every((c) => c === "USD"));
  assert.ok(badge.calls.balance.every((c) => c === "USD"));
  assert.match(text(badge.hooks.tree), /100 USD/);
  assert.match(text(badge.hooks.tree), /10 USD/);
  assert.doesNotMatch(text(badge.hooks.tree), /\$/);
  const slow = deferred<any>();
  badge.hold(slow);
  for (const emit of badge.ledger) emit("v");
  await settleUI();
  code = "EUR";
  badge.hooks.render();
  assert.doesNotMatch(text(badge.hooks.tree), /USD/);
  await badge.settle();
  slow.resolve({ max_collect_minor: 10000, max_pay_minor: 0 });
  await badge.settle();
  assert.match(text(badge.hooks.tree), /200 EUR/);
  assert.doesNotMatch(text(badge.hooks.tree), /USD/);
  const refusalNode = nodes(badge.hooks.tree).find(
    (node) => typeof node.type === "function" && node.type.name === "CreditRefusalsText",
  );
  assert.equal(
    refusalNode?.props.currency,
    "EUR",
    "refusal cache/query/display receives the same explicit currency",
  );
  badge.hooks.unmount();

  const intent = fixture();
  const List = compileUI("../../components/CreditIntentList", intent.common).CreditIntentList;
  let all = true;
  intent.hooks.render(() => List({ personId: "p", vaultId: "v", allCurrencies: all }));
  await intent.settle();
  assert.equal(intent.calls.intents[0][3].allCurrencies, true);
  assert.match(text(intent.hooks.tree), /1\s+AFN/);
  assert.match(text(intent.hooks.tree), /2\s+USD/);
  assert.doesNotMatch(text(intent.hooks.tree), /[؋$]/);
  assert.match(text(intent.hooks.tree), /3\s+GBP/);
  const reads = intent.calls.intents.length;
  intent.select("USD");
  intent.hooks.render();
  await intent.settle();
  assert.equal(
    intent.calls.intents.length,
    reads,
    "all-currency requests stay independent of the selected view",
  );
  assert.match(text(intent.hooks.tree), /1\s+AFN/);
  all = false;
  intent.hooks.render();
  assert.equal(
    intent.hooks.tree,
    null,
    "scope change hides old multi-currency intents immediately",
  );
  await intent.settle();
  assert.equal(intent.hooks.tree, null);
  intent.hooks.unmount();
  assert.equal(intent.hooks.lateWrites, 0);
  assert.equal(badge.hooks.lateWrites, 0);
  console.log(
    "PASS currency credit adapters: explicit policy/exposure/refusal scope, immutable labels, delayed response guards and all-currency deferred/refused intents",
  );
}
void main();
