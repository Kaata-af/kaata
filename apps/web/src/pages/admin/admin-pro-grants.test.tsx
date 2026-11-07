import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminProGrants } from "./AdminProGrants";
import type { AdminProStatus } from "./admin-pro";
import {
  AdminProGrantError,
  changeAdminProGrant,
  parseAdminProGrant,
  proGrantExpiry,
  proGrantReason,
  type AdminProGrantAction,
} from "./admin-pro-grants";
import { AdminTokenContext, AuthError } from "./api";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const GRANT = "00000000-0000-4000-8000-000000000002";
const REVOKE = "00000000-0000-4000-8000-000000000003";
const TOKEN = "test-operator-key";
const GRANTED = "2026-11-07T09:30:00Z";
const EXPIRES = "2026-12-07T19:29:59Z";
const PAID = "2026-12-08T12:30:00Z";
const grant = { id: GRANT, granted_at: GRANTED, expires_at: EXPIRES, reason: "Support trial" };
const revoked = { ...grant, revoked_at: "2026-11-10T12:00:00Z", revoke_reason: "Trial ended" };
const grantAction: AdminProGrantAction = {
  kind: "grant",
  operation_id: GRANT,
  expires_at: EXPIRES,
  reason: "Support trial",
};
const revokeAction: AdminProGrantAction = {
  kind: "revoke",
  operation_id: REVOKE,
  grant_id: GRANT,
  reason: "Trial ended",
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("complimentary access end dates are interpreted in Kabul and calendar rollover is rejected", () => {
  const now = Date.parse("2026-12-07T05:00:00Z");
  assert.equal(proGrantExpiry("2026-12-07", now), "2026-12-07T19:29:59.000Z");
  assert.equal(proGrantExpiry("2026-12-06", now), null);
  assert.equal(proGrantExpiry("2027-02-29", now), null);
  assert.equal(proGrantExpiry("2028-02-29", now), "2028-02-29T19:29:59.000Z");
  assert.equal(proGrantExpiry("2026-12-07", Date.parse(EXPIRES)), null);
  assert.equal(proGrantReason("  Support trial  "), "Support trial");
  assert.equal(proGrantReason(""), null);
  assert.equal(proGrantReason("Support\ntrial"), null);
  assert.equal(proGrantReason("ص".repeat(241)), null);
});

test("a grant request can be retried with the same operation ID after a lost response", async () => {
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, `/v1/admin/users/${ACCOUNT}/pro/grants`);
    assert.equal(url.search, "");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${TOKEN}`);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    writes.push(String(init?.body));
    if (writes.length === 1) throw new TypeError("Connection dropped");
    return Response.json({ grant, duplicate: true });
  };
  await assert.rejects(
    () => changeAdminProGrant(TOKEN, ACCOUNT, grantAction),
    (error: unknown) => error instanceof AdminProGrantError && error.kind === "unconfirmed",
  );
  assert.deepEqual(await changeAdminProGrant(TOKEN, ACCOUNT, grantAction), {
    grant,
    duplicate: true,
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0], writes[1]);
  assert.deepEqual(JSON.parse(writes[0]), {
    operation_id: GRANT,
    expires_at: EXPIRES,
    reason: grant.reason,
  });
});

test("a revoke targets one grant and rejects another grant's confirmation", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(
      new URL(String(input)).pathname,
      `/v1/admin/users/${ACCOUNT}/pro/grants/${GRANT}/revoke`,
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      operation_id: REVOKE,
      reason: "Trial ended",
    });
    return Response.json({ grant: revoked, duplicate: false });
  };
  assert.deepEqual(await changeAdminProGrant(TOKEN, ACCOUNT, revokeAction), {
    grant: revoked,
    duplicate: false,
  });
  globalThis.fetch = async () =>
    Response.json({ grant: { ...revoked, id: REVOKE }, duplicate: false });
  await assert.rejects(
    () => changeAdminProGrant(TOKEN, ACCOUNT, revokeAction),
    (error: unknown) => error instanceof AdminProGrantError && error.kind === "unconfirmed",
  );
  assert.throws(() => parseAdminProGrant({ ...grant, revoked_at: revoked.revoked_at }));
});

test("outdated access and operator authentication failures remain distinct", async () => {
  globalThis.fetch = async () => Response.json({}, { status: 409 });
  await assert.rejects(
    () => changeAdminProGrant(TOKEN, ACCOUNT, revokeAction),
    (error: unknown) => error instanceof AdminProGrantError && error.kind === "conflict",
  );
  globalThis.fetch = async () => Response.json({}, { status: 401 });
  await assert.rejects(() => changeAdminProGrant(TOKEN, ACCOUNT, grantAction), AuthError);
});

test("admin shows paid time separately and offers grant or revoke according to the current grant", () => {
  const status: AdminProStatus = {
    account_id: ACCOUNT,
    status: "active",
    subscription_expires_at: PAID,
    plans: [],
    payments: [],
    pending_checkout: false,
    grants_available: true,
    paid_expires_at: PAID,
    manual_grant: grant,
    grant_history: [grant],
  };
  const client = new QueryClient();
  const render = (data: AdminProStatus) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AdminTokenContext.Provider value={TOKEN}>
          <AdminProGrants accountID={ACCOUNT} accountName="Customer" status={data} />
        </AdminTokenContext.Provider>
      </QueryClientProvider>,
    );
  const active = render(status);
  assert.match(active, /Paid through/);
  assert.match(active, /Dec 8, 2026, 17:00 Kabul time/);
  assert.match(active, /Through Dec 7, 2026, 23:59 Kabul time/);
  assert.match(active, /Revoke manual grant/);
  assert.doesNotMatch(active, /Grant Pro until/);
  const history = render({ ...status, manual_grant: null, grant_history: [revoked] });
  assert.match(history, /Grant Pro until/);
  assert.match(history, /No active grant/);
  assert.match(history, /Complimentary access history/);
  assert.match(history, /Trial ended/);
  assert.match(history, /Dec 8, 2026, 17:00 Kabul time/);
  assert.doesNotMatch(history, /Revoke manual grant/);
  client.clear();
});
