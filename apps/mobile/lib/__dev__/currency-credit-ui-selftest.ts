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
  const balances: Record<string, number> = { USD: 9000 };
  const policies: Record<
    string,
    { max_collect_minor: number | null; max_pay_minor: number | null }
  > = {};
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
    "../lib/credit-policy": require("../credit-policy"),
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
        return (
          policies[code] ?? { max_collect_minor: code === "USD" ? 10000 : 20000, max_pay_minor: 0 }
        );
      },
      creditBalanceInTx: async (_db: any, _v: string, _r: string, code: string) => {
        calls.balance.push(code);
        return balances[code] ?? 0;
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
    setBalance: (currency: string, minor: number) => {
      balances[currency] = minor;
    },
    setPolicy: (currency: string, collect: number | null, pay: number | null) => {
      policies[currency] = { max_collect_minor: collect, max_pay_minor: pay };
    },
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
  for (const [status, key] of [
    ["near", "credit.statusNear"],
    ["reached", "credit.statusReached"],
    ["over", "credit.statusOver"],
  ] as const) {
    const statusNode = Badge({ status });
    assert.equal(
      text(statusNode.type(statusNode.props)),
      key,
      `Direct ${status} badges use their own label`,
    );
  }
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

  const reached = fixture();
  const ReachedBadge = compileUI(
    "../../components/CreditStatusBadge",
    reached.common,
  ).CreditStatusBadge;
  let reachedCurrency = "USD";
  const loadedStatus = () => {
    const node = nodes(reached.hooks.tree).find(
      (candidate) =>
        typeof candidate.type === "function" && candidate.type.name === "CreditStatusText",
    );
    return node ? text(node.type(node.props)) : "";
  };
  reached.setBalance("USD", 10000);
  reached.hooks.render(() => {
    const node = ReachedBadge({ personId: "p", vaultId: "v", currency: reachedCurrency });
    return node.type(node.props);
  });
  await reached.settle();
  assert.equal(
    loadedStatus(),
    "credit.statusReached",
    "Loaded exact-cap customers say reached, not near",
  );
  assert.match(text(reached.hooks.tree), /credit\.limitLeft.*"left":"0 USD"/);
  const delayedReached = deferred<any>();
  reached.hold(delayedReached);
  for (const emit of reached.ledger) emit("v");
  await settleUI();
  reachedCurrency = "AFN";
  reached.setBalance("AFN", 10000);
  reached.hooks.render();
  assert.equal(
    loadedStatus(),
    "",
    "Changing currency immediately removes another currency's reached status",
  );
  await reached.settle();
  delayedReached.resolve({ max_collect_minor: 10000, max_pay_minor: 0 });
  await reached.settle();
  assert.equal(
    loadedStatus(),
    "",
    "A delayed USD limit cannot turn a below-limit AFN account into reached",
  );
  assert.match(text(reached.hooks.tree), /200 AFN/);
  assert.doesNotMatch(text(reached.hooks.tree), /USD/);
  reached.setBalance("AFN", 20000);
  for (const emit of reached.ledger) emit("v");
  await reached.settle();
  assert.equal(loadedStatus(), "credit.statusReached", "AFN uses its own exact collect cap");
  reached.setPolicy("AFN", 20000, 30000);
  reached.setBalance("AFN", -30000);
  for (const emit of reached.ledger) emit("v");
  await reached.settle();
  assert.equal(loadedStatus(), "credit.statusReached", "Exact pay exposure also says reached");
  reached.setPolicy("AFN", 0, 0);
  reached.setBalance("AFN", 0);
  for (const emit of reached.ledger) emit("v");
  await reached.settle();
  assert.equal(loadedStatus(), "", "A settled account with a zero cap has no limit warning");
  reached.hooks.unmount();
  assert.equal(reached.hooks.lateWrites, 0);

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
    "PASS currency credit adapters: near/reached/over labels, exact directional caps, explicit policy/exposure/refusal scope, immutable labels, delayed response guards and all-currency deferred/refused intents",
  );
}
void main();
