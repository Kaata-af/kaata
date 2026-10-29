import assert from "node:assert/strict";
import {
  ensureCurrencySyncSupported,
  currencyRequestHeaders,
  supportsPersonDefaultCurrencySync,
  supportsPersonNotesSync,
  supportsEntryCurrencyEditSync,
} from "../currency-sync";
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
  assert.equal(headers["X-Kaata-Entry-Currency-Edit"], "1");
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
    let personCapability: unknown = false;
    globalThis.fetch = async () =>
      Response.json({ multi_currency: true, person_default_currency: personCapability });
    assert.equal(
      await supportsPersonDefaultCurrencySync("https://currency-test.invalid", "jwt"),
      false,
      "the cached multi-currency capability does not authorize a new event type",
    );
    personCapability = "true";
    assert.equal(
      await supportsPersonDefaultCurrencySync("https://currency-test.invalid", "jwt"),
      false,
    );
    for (const flag of [undefined, false, "true", 1, true]) {
      globalThis.fetch = async () => Response.json({ multi_currency: true, person_notes: flag });
      assert.equal(await supportsPersonNotesSync("https://notes.invalid", "jwt"), flag === true);
    }
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal(await supportsPersonNotesSync("https://notes.invalid", "jwt"), false);
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    assert.equal(await supportsPersonNotesSync("https://notes.invalid", "jwt"), false);
    for (const flag of [undefined, false, "true", 1, true]) {
      globalThis.fetch = async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>)["X-Kaata-Entry-Currency-Edit"], "1");
        return Response.json({ multi_currency: true, entry_currency_edit: flag });
      };
      assert.equal(
        await supportsEntryCurrencyEditSync("https://currency-edit.invalid", "jwt"),
        flag === true,
      );
    }
    globalThis.fetch = async () =>
      Response.json({ multi_currency: false, entry_currency_edit: true });
    assert.equal(
      await supportsEntryCurrencyEditSync("https://currency-edit.invalid", "jwt"),
      false,
    );
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    assert.equal(
      await supportsEntryCurrencyEditSync("https://currency-edit.invalid", "jwt"),
      false,
      "Offline and rolling-server failures never authorize an unsupported edit upload",
    );
    globalThis.fetch = async () =>
      Response.json({ multi_currency: true, person_default_currency: personCapability });
    personCapability = true;
    assert.equal(
      await supportsPersonDefaultCurrencySync("https://currency-test.invalid", "jwt"),
      true,
    );
    personCapability = false;
    assert.equal(
      await supportsPersonDefaultCurrencySync("https://currency-test.invalid", "jwt"),
      false,
      "a server rollback cannot reuse an earlier affirmative response",
    );
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    assert.equal(
      await supportsPersonDefaultCurrencySync("https://currency-test.invalid", "jwt"),
      false,
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
