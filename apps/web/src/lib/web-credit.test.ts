import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { clearWebSession, createWebAuthNonce, signInWithGoogle, WebApiError } from "./web-auth";
import type { WebLedger, WebPerson } from "./web-ledger";
import {
  effectiveWebCreditPolicy,
  loadWebCreditPolicies,
  parseWebCreditAmount,
  saveWebCreditPolicy,
  WEB_DEFAULT_CREDIT_ID,
  webCreditAmount,
  webCreditDetail,
  webCreditExposureKnown,
  WebCreditError,
  type WebCreditInput,
  type WebCreditPolicy,
} from "./web-credit";

const VAULT = "10000000-0000-4000-8000-000000000001";
const PERSON = "20000000-0000-4000-8000-000000000001";
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();
const browser = Object.assign(new EventTarget(), {
  sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });

const person: WebPerson = {
  relationship_id: PERSON,
  user_id: "30000000-0000-4000-8000-000000000001",
  name: "Fixture",
  phone_e164: null,
  default_entry_currency: null,
  archived_at: null,
  read_only: false,
  read_only_reason: null,
};
const ledger: WebLedger = {
  vault_id: VAULT,
  name: "Fixture",
  role: "owner",
  currency: "AFN",
  legacy_currency: "AFN",
  default_entry_currency: "USD",
  enabled_currencies: ["AFN", "USD"],
  archived_at_ms: null,
  server_seq: 1,
  hlc_last: { pms: 1, l: 0, did: "fixture" },
  device_registered: true,
  people: [person],
  entries: [],
  incomplete_people: 0,
  credit_balances_complete: true,
};
function policy(override: Partial<WebCreditPolicy> = {}): WebCreditPolicy {
  return {
    relationship_id: PERSON,
    currency: "USD",
    max_collect_minor: 10_000,
    max_pay_minor: null,
    mode: "clerk_block",
    restrict_editors: true,
    updated_at_ms: 100,
    ...override,
  };
}
const input = (): WebCreditInput => {
  const { updated_at_ms: _time, ...value } = policy();
  return value;
};
async function login() {
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const claims = {
      account_id: "fixture-account",
      install_id: body.install_id,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    return Response.json({
      account_id: claims.account_id,
      default_vault_id: VAULT,
      user: { has_password: false },
      session_jwt: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
    });
  }) as typeof fetch;
  return signInWithGoogle("fixture-provider-token", createWebAuthNonce());
}
beforeEach(() => {
  clearWebSession();
  storage.clear();
});
after(() => {
  clearWebSession();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("credit inputs preserve unlimited, zero and exact localized hundredths", () => {
  assert.equal(parseWebCreditAmount("  "), null);
  assert.equal(parseWebCreditAmount("۰"), 0);
  assert.equal(parseWebCreditAmount("۱۲٫۵۰"), 1250);
  assert.equal(parseWebCreditAmount("١٢,٥"), 1250);
  assert.equal(parseWebCreditAmount(".01"), 1);
  assert.equal(parseWebCreditAmount("9999999999.99"), 999_999_999_999);
  assert.equal(webCreditAmount(null), "");
  assert.equal(webCreditAmount(0), "0");
  assert.equal(webCreditAmount(1250), "12.50");
  for (const raw of ["-1", "1.001", "1,000", "NaN", "1e2", "10000000000", "1 000"])
    assert.throws(
      () => parseWebCreditAmount(raw),
      (error: unknown) => error instanceof WebCreditError && error.code === "invalid_credit_amount",
    );
});

test("effective credit rules stay per-currency and explicit unlimited wins over defaults", () => {
  const usdDefault = policy({ relationship_id: WEB_DEFAULT_CREDIT_ID });
  const afnDefault = policy({
    relationship_id: WEB_DEFAULT_CREDIT_ID,
    currency: "AFN",
    max_collect_minor: 500_000,
  });
  const own = policy({
    max_collect_minor: null,
    max_pay_minor: 0,
    mode: "warn",
    restrict_editors: false,
  });
  assert.equal(effectiveWebCreditPolicy([usdDefault, afnDefault], PERSON, "USD"), usdDefault);
  assert.equal(effectiveWebCreditPolicy([usdDefault, afnDefault, own], PERSON, "USD"), own);
  assert.equal(effectiveWebCreditPolicy([usdDefault, afnDefault, own], PERSON, "AFN"), afnDefault);
  assert.equal(effectiveWebCreditPolicy([usdDefault, afnDefault, own], PERSON, "EUR"), null);
});

test("credit display distinguishes near, exactly reached and exceeded without rounding money", () => {
  assert.equal(webCreditDetail(100, 79n).status, "none");
  assert.equal(webCreditDetail(100, 80n).status, "near");
  assert.equal(webCreditDetail(100, 100n).status, "reached");
  assert.equal(webCreditDetail(100, 101n).status, "over");
  assert.equal(webCreditDetail(100, 101n).remaining, -1n);
  assert.equal(webCreditDetail(0, 0n).status, "none");
  assert.equal(webCreditDetail(0, 1n).status, "over");
  assert.equal(webCreditDetail(null, 999_999_999_999_999_999_999n).status, "none");
  assert.equal(
    webCreditDetail(1, 999_999_999_999_999_999_999n).remaining,
    -999_999_999_999_999_999_998n,
  );
});

test("missing credit completeness and shared history cannot become a known zero balance", () => {
  assert.equal(webCreditExposureKnown(ledger, person, [{ currency: "USD", balance: 0n }]), true);
  assert.equal(
    webCreditExposureKnown({ ...ledger, credit_balances_complete: undefined }, person, []),
    false,
  );
  assert.equal(webCreditExposureKnown(ledger, person, undefined), false);
  assert.equal(webCreditExposureKnown(ledger, undefined, []), false);
  assert.equal(
    webCreditExposureKnown(ledger, { ...person, read_only: true, read_only_reason: "shared_tab" }, [
      { currency: "USD", balance: 0n },
    ]),
    false,
  );
  assert.equal(webCreditExposureKnown(ledger, { ...person, archived_at: 1 }, []), false);
});

test("credit reads are authenticated, currency-aware, abortable and scoped to one vault", async () => {
  const signedIn = await login();
  globalThis.fetch = (async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/v1/sync/credit-limits");
    assert.equal(parsed.search, `?vault_id=${VAULT}`);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${signedIn.session_jwt}`);
    assert.equal(new Headers(init?.headers).get("X-Kaata-Currencies"), "1");
    assert.equal(new Headers(init?.headers).get("X-Kaata-Entry-Currency-Edit"), "1");
    assert.equal(new Headers(init?.headers).get("X-Kaata-Tab-Group"), "1");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return Response.json([{ ...policy(), restrict_editors: undefined }]);
  }) as typeof fetch;
  assert.deepEqual(await loadWebCreditPolicies(VAULT), [policy({ restrict_editors: false })]);
  await assert.rejects(() => loadWebCreditPolicies("../other-vault"), WebCreditError);
  const controller = new AbortController();
  globalThis.fetch = ((_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
  const pending = loadWebCreditPolicies(VAULT, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("malformed or duplicate policies fail instead of silently removing a saved limit", async () => {
  await login();
  for (const response of [
    {},
    null,
    [policy({ max_collect_minor: -1 })],
    [policy({ max_pay_minor: 0.5 })],
    [policy(), policy()],
    [policy({ restrict_editors: "yes" as unknown as boolean })],
  ]) {
    globalThis.fetch = (async () => Response.json(response)) as typeof fetch;
    await assert.rejects(
      () => loadWebCreditPolicies(VAULT),
      (error: unknown) =>
        (error instanceof WebCreditError && error.code === "invalid_credit_response") ||
        (error instanceof WebApiError && error.code === "invalid_response"),
    );
  }
});

test("saving writes just the chosen currency and preserves explicit zero/unlimited/editor restriction", async () => {
  await login();
  const calls: string[] = [];
  const saved = { ...input(), max_collect_minor: 0, max_pay_minor: null };
  globalThis.fetch = (async (_url, init) => {
    calls.push(init?.method ?? "GET");
    if (!init?.method)
      return Response.json([policy(), policy({ currency: "AFN", max_collect_minor: 4500 })]);
    assert.equal(init.method, "PUT");
    assert.deepEqual(JSON.parse(String(init.body)), saved);
    return Response.json({ ...saved, updated_at_ms: 200 });
  }) as typeof fetch;
  assert.deepEqual(await saveWebCreditPolicy(ledger, saved, policy()), {
    ...saved,
    updated_at_ms: 200,
  });
  assert.deepEqual(calls, ["GET", "PUT"]);
});

test("corrected-currency and shared-account books can refresh and save their credit rules", async () => {
  await login();
  let current: WebCreditPolicy[] = [];
  const calls: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    calls.push(init?.method ?? "GET");
    const headers = new Headers(init?.headers);
    if (headers.get("X-Kaata-Entry-Currency-Edit") !== "1")
      return Response.json({ error_code: "entry_currency_upgrade_required" }, { status: 426 });
    if (headers.get("X-Kaata-Tab-Group") !== "1")
      return Response.json({ error_code: "shared_account_upgrade_required" }, { status: 426 });
    if (init?.method === "PUT") {
      const saved = { ...JSON.parse(String(init.body)), updated_at_ms: 200 };
      current = [saved];
      return Response.json(saved);
    }
    return Response.json(current);
  }) as typeof fetch;
  assert.deepEqual(await loadWebCreditPolicies(VAULT), []);
  assert.deepEqual(await saveWebCreditPolicy(ledger, input(), null), {
    ...input(),
    updated_at_ms: 200,
  });
  assert.deepEqual(await loadWebCreditPolicies(VAULT), current);
  assert.deepEqual(calls, ["GET", "GET", "PUT", "GET"]);
});

test("client role/archive gates and freshly changed policy prevent an unauthorized replacement", async () => {
  await login();
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json([policy({ max_collect_minor: 25_000 })]);
  }) as typeof fetch;
  for (const role of ["editor", "clerk", "viewer"] as const)
    await assert.rejects(
      () => saveWebCreditPolicy({ ...ledger, role }, input(), policy()),
      (error: unknown) => error instanceof WebCreditError && error.code === "permission_denied",
    );
  await assert.rejects(
    () => saveWebCreditPolicy({ ...ledger, archived_at_ms: 1 }, input(), policy()),
    WebCreditError,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    () => saveWebCreditPolicy(ledger, input(), policy()),
    (error: unknown) => error instanceof WebCreditError && error.code === "stale_credit_policy",
  );
  assert.equal(requests, 1, "conflicting settings are not overwritten with a PUT");
});

test("a lost settings response is an error and a server role refusal is retained", async () => {
  await login();
  const changed = { ...input(), max_pay_minor: 2500 };
  globalThis.fetch = (async (_url, init) => {
    if (!init?.method) return Response.json([policy()]);
    throw new TypeError("connection lost");
  }) as typeof fetch;
  await assert.rejects(
    () => saveWebCreditPolicy(ledger, changed, policy()),
    (error: unknown) => error instanceof WebApiError && error.code === "network",
  );
  globalThis.fetch = (async (_url, init) =>
    !init?.method
      ? Response.json([policy()])
      : Response.json({ error_code: "insufficient_role" }, { status: 403 })) as typeof fetch;
  await assert.rejects(
    () => saveWebCreditPolicy(ledger, changed, policy()),
    (error: unknown) => error instanceof WebApiError && error.status === 403,
  );
});

test("retry confirms an already committed policy after a lost response without saving twice", async () => {
  await login();
  let current = policy();
  let puts = 0;
  const changed = { ...input(), max_pay_minor: 2500 };
  globalThis.fetch = (async (_url, init) => {
    if (!init?.method) return Response.json([current]);
    puts++;
    current = { ...changed, updated_at_ms: 200 };
    throw new TypeError("response lost after commit");
  }) as typeof fetch;
  await assert.rejects(() => saveWebCreditPolicy(ledger, changed, policy()), WebApiError);
  assert.deepEqual(await saveWebCreditPolicy(ledger, changed, policy()), current);
  assert.equal(puts, 1);
});

test("locking settings during the fresh read aborts the save before a PUT", async () => {
  await login();
  const controller = new AbortController();
  let puts = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") puts++;
    // A completed read can still arrive after the settings dialog is locked.
    controller.abort();
    return Response.json([policy()]);
  }) as typeof fetch;
  await assert.rejects(
    () =>
      saveWebCreditPolicy(ledger, { ...input(), max_pay_minor: 2500 }, policy(), controller.signal),
    { name: "AbortError" },
  );
  assert.equal(puts, 0);
});

test("a signed-out account cannot receive an old policy read or report an old save as current", async () => {
  await login();
  let resolve!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((done) => {
      resolve = done;
    })) as typeof fetch;
  const pending = loadWebCreditPolicies(VAULT);
  clearWebSession();
  resolve(Response.json([policy()]));
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof WebCreditError && error.code === "session_changed",
  );
  await login();
  let putStarted!: () => void;
  const started = new Promise<void>((done) => {
    putStarted = done;
  });
  globalThis.fetch = (async (_url, init) => {
    if (!init?.method) return Response.json([policy()]);
    putStarted();
    return new Promise<Response>((done) => {
      resolve = done;
    });
  }) as typeof fetch;
  const saving = saveWebCreditPolicy(ledger, { ...input(), max_pay_minor: 2500 }, policy());
  await started;
  clearWebSession();
  resolve(Response.json(policy({ updated_at_ms: 200 })));
  await assert.rejects(
    saving,
    (error: unknown) => error instanceof WebCreditError && error.code === "session_changed",
  );
});
