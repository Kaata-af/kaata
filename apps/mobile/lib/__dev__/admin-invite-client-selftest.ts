// Real owner signing across mocked storage/session/native boundaries.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sha512 } from "@noble/hashes/sha512";
import * as ed from "@noble/ed25519";
import * as grants from "../trust/admin-invite";
import { compileUI } from "./ui-fixture";

ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));
const OWNER = "10000000-0000-4000-8000-000000000001";
const TARGET = "10000000-0000-4000-8000-000000000002";
const VAULT = "10000000-0000-4000-8000-000000000003";
const seed = new Uint8Array(32).fill(17);
const publicKey = Buffer.from(ed.getPublicKey(seed)).toString("base64");
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
};
class SessionChangedError extends Error {}
class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function fixture() {
  let currentAccount = OWNER, currentVault = VAULT, ownerRole = "owner", chainAccount = OWNER;
  let latest = Date.now() + 20;
  let deviceRemoved = false;
  let localRole: string | null = null, pendingMembership = false;
  let beforePush: (() => void) | undefined;
  let beforeSign: (() => void) | undefined;
  let pushes = 0, registrations = 0;
  const helper = compileUI("../admin-invite-authorization", {
    "./auth": {
      applyForCurrentSession: async (session: any, work: () => Promise<unknown>) => {
        if (session.accountId !== currentAccount) throw new SessionChangedError();
        return work();
      },
    },
    "./db-tx": {
      getInstallIdSync: () => "install",
      getDb: async () => ({
        getFirstAsync: async (sql: string) => sql.startsWith("SELECT 1")
          ? pendingMembership ? { pending: 1 } : null
          : sql.startsWith("SELECT MAX") ? { latest } : {
          id: VAULT, name: "Shop", currency: "AFN", created_at: 100,
          vault_trust_anchor_pubkey: publicKey,
        },
      }),
    },
    "expo-crypto": { randomUUID },
    "./mesh/device-key": {
      getDeviceSigner: async () => ({
        pubkey_b64: publicKey,
        sign: async (bytes: Uint8Array) => { beforeSign?.(); return ed.sign(bytes, seed); },
      }),
    },
    "./trust/proof": {
      getLocalMembershipState: async (_vault: string, publishedOnly: boolean) => ({
        hasGenesis: true,
        members: new Map([[chainAccount, { role: !publishedOnly && localRole ? localRole : ownerRole, removed: false }]]),
        devices: new Map([[publicKey, { account_id: chainAccount, device_id: "install", removed: deviceRemoved }]]),
      }),
    },
    "./trust/backfill": { ensureChainBackfill: async () => {} },
    "./event-sig": { canonicalize },
    "./trust/admin-invite": grants,
    "./sync/push": { pushEvents: async () => {
      pushes++;
      beforePush?.();
      return { pushed: pushes < 3 ? 1 : 0, duplicates: 0, rejected: 0 };
    } },
    "./vault-api": { ApiError, createVaultOnServer: async () => { registrations++; } },
  }) as typeof import("../admin-invite-authorization");
  const guard = () => { if (currentVault !== VAULT) throw new SessionChangedError(); };
  const create = () => helper.createAdminInviteAuthorization(VAULT, TARGET,
    { accountId: OWNER, jwt: "session", bindingVersion: 1 }, guard);
  return {
    create, get latest() { return latest; }, get pushes() { return pushes; },
    get registrations() { return registrations; },
    alias: () => { chainAccount = "local:abcdefghijklmnop"; },
    role: (role: string) => { ownerRole = role; },
    removeDevice: () => { deviceRemoved = true; },
    localDemotion: () => { localRole = "manager"; },
    pending: () => { pendingMembership = true; },
    demoteWhileSigning: () => { beforeSign = () => { ownerRole = "manager"; }; },
    race: (boundary: "push" | "sign", scope: "vault" | "account") => {
      const change = () => { if (scope === "vault") currentVault = TARGET; else currentAccount = TARGET; };
      if (boundary === "push") beforePush = change; else beforeSign = change;
    },
  };
}

async function main() {
  const owner = fixture();
  const authorization = await owner.create();
  assert.equal(authorization.grant.recipient_account_id, TARGET);
  assert.equal(authorization.grant.from_account_id, OWNER);
  assert.equal(authorization.grant.vault_id, VAULT);
  assert.equal(authorization.grant.role, "manager");
  assert.ok(authorization.grant.issued_at_ms >= owner.latest + 1, "ordering follows local owner/device proof");
  assert.equal(authorization.grant.expires_at_ms - authorization.grant.issued_at_ms, grants.MAX_ADMIN_INVITE_LIFETIME_MS);
  assert.equal(owner.pushes, 3, "existing proof still drains preceding queued batches before signing");
  assert.equal(owner.registrations, 1);
  assert.ok(ed.verify(Buffer.from(authorization.sig_b64, "base64"),
    grants.adminInviteGrantBytes(authorization.grant, canonicalize), Buffer.from(publicKey, "base64")));
  const alias = fixture();
  alias.alias();
  assert.equal((await alias.create()).grant.from_chain_account_id, "local:abcdefghijklmnop");
  for (const role of ["manager", "editor", "clerk", "viewer"]) {
    const denied = fixture(); denied.role(role);
    await assert.rejects(denied.create(), (error: any) => error.code === "admin_invite_unavailable");
  }
  const removed = fixture(); removed.removeDevice();
  await assert.rejects(removed.create(), (error: any) => error.code === "admin_invite_unavailable");
  for (const prepare of ["localDemotion", "pending", "demoteWhileSigning"] as const) {
    const changed = fixture(); changed[prepare]();
    await assert.rejects(changed.create(), (error: any) => error.code === "admin_invite_unavailable");
  }
  for (const boundary of ["push", "sign"] as const)
    for (const scope of ["vault", "account"] as const) {
      const raced = fixture(); raced.race(boundary, scope);
      await assert.rejects(raced.create(), SessionChangedError);
    }
  console.log("PASS Admin intent creation: real owner signature, exact recipient, proof ordering, alias, role/device refusals and session/vault races");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
