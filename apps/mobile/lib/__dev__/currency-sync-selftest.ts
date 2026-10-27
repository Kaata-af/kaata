import assert from "node:assert/strict";
import { ensureCurrencySyncSupported, currencyRequestHeaders } from "../currency-sync";
import { compileUI } from "./ui-fixture";

async function main() {
  const headers = await currencyRequestHeaders(
    { getFirstAsync: async () => ({ legacy_currency: "USD" }) } as any,
    "vault",
  );
  assert.equal(
    headers["X-Kaata-Legacy-Currency"],
    "USD",
    "sync asserts frozen currency, not selected view",
  );
  const priorFetch = globalThis.fetch;
  try {
    let requests = 0;
    let enabled = false;
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      requests++;
      assert.equal((options?.headers as Record<string, string>)["X-Kaata-Currencies"], "1");
      return enabled
        ? new Response(JSON.stringify({ multi_currency: true }))
        : new Response("", { status: 404 });
    }) as typeof fetch;
    await assert.rejects(
      ensureCurrencySyncSupported("https://currency-test.invalid", "jwt"),
      /server needs an update/,
    );
    enabled = true;
    await ensureCurrencySyncSupported("https://currency-test.invalid", "jwt");
    await ensureCurrencySyncSupported("https://currency-test.invalid", "jwt");
    assert.equal(requests, 2, "only successful capability checks are cached");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      ensureCurrencySyncSupported("https://currency-test.invalid", "jwt", controller.signal),
      /cancelled/,
    );
  } finally {
    globalThis.fetch = priorFetch;
  }

  const routed: any[] = [],
    selected: any[] = [];
  const tab = "00000000-0000-4000-8000-000000000001";
  const notification = compileUI("../tabs/open-notification", {
    "expo-router": { router: { push: (route: any) => routed.push(route) } },
    "../db-tx": { getAccountIdSync: () => "account", setActiveVaultId: async () => {} },
    "../currency": {
      applyVaultCurrency: async () => {},
      selectLedgerCurrency: async (...args: any[]) => selected.push(args),
    },
    "./db": {
      getTabLink: async () => ({ vault_id: "vault", relationship_id: "r", currency: "USD" }),
      getPersonIdForRelationship: async () => "person",
    },
    "./inbox-reads": {},
    "./sync": { syncTab: async () => ({ ok: true }) },
  }) as typeof import("../tabs/open-notification");
  await notification.openTabNotification(tab);
  assert.deepEqual(selected, [["USD", "vault"]]);
  assert.equal(routed[0].params.currency, "USD");
  console.log(
    "PASS: unsupported-server currency sync protection, capability caching and notification currency routing",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
