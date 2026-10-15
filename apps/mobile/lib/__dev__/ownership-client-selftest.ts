// Real ownership invitation API/journal and signing; native/network boundaries
// are isolated. No user account or server is changed by these checks.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import * as ed from "@noble/ed25519";
import * as transfer from "../trust/ownership-transfer";
import { buildLocalAccountId } from "../trust/account-id";
import { compileUI, deferred, settleUI, uiHooks, jsx, nodes } from "./ui-fixture";

const OWNER = "10000000-0000-4000-8000-000000000001";
const TARGET = "10000000-0000-4000-8000-000000000002";
const VAULT = "20000000-0000-4000-8000-000000000001";
const EVENT = "30000000-0000-4000-8000-000000000001";
const seed = new Uint8Array(32).fill(23);
const sig = compileUI("../event-sig", {
  "@noble/hashes/sha512": require("@noble/hashes/sha512"),
  "@noble/ed25519": ed,
  "expo-crypto": { getRandomBytes: randomBytes },
});
const pub = Buffer.from(ed.getPublicKey(seed)).toString("base64");

function fixture() {
  const store = new Database(":memory:");
  store.exec(`CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE vaults(id TEXT,name TEXT,currency TEXT,created_at INTEGER,vault_trust_anchor_pubkey TEXT);
    CREATE TABLE pending_invitations(token TEXT,accepted_at INTEGER);
    CREATE TABLE event_log(vault_id TEXT,event_id TEXT,event_type TEXT,payload_json TEXT,
      applied_at INTEGER,quarantine_reason TEXT,tombstone_reason TEXT);`);
  let account = OWNER,
    version = 0,
    chainAccount = OWNER,
    ownerPublished = true;
  let memberRole = "owner",
    lost = false,
    confirmTransfer = true,
    held: ReturnType<typeof deferred<any>> | null = null;
  const calls: { path: string; method: string; body: any }[] = [];
  const session = () => ({ accountId: account, jwt: `jwt-${account}`, bindingVersion: version });
  class SessionChangedError extends Error {}
  const apply = async (before: any, work: any) => {
    if (before.accountId !== account || before.bindingVersion !== version)
      throw new SessionChangedError();
    return work();
  };
  const meta = async (name: string) =>
    (store.prepare("SELECT value FROM app_meta WHERE key=?").get(name) as any)?.value ?? null;
  const setMeta = async (name: string, value: string) => {
    store.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(name, value);
  };
  const db = {
    getFirstAsync: async (sql: string, ...args: any[]) => store.prepare(sql).get(...args) ?? null,
    runAsync: async (sql: string, ...args: any[]) => store.prepare(sql).run(...args),
    withTransactionAsync: async (work: any) => {
      store.exec("BEGIN");
      try {
        await work();
        store.exec("COMMIT");
      } catch (error) {
        store.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const state = () => ({
    hasGenesis: true,
    conflicts: [],
    members: new Map([
      [chainAccount, { role: memberRole, removed: false }],
      [TARGET, { role: "owner", removed: false }],
    ]),
    devices: new Map([[pub, { account_id: chainAccount, device_id: "install", removed: false }]]),
  });
  const result = () => ({
    vault_id: VAULT,
    vault_name: "Household",
    role: "owner",
    ...(confirmTransfer ? { ownership_transferred: true, ownership_event_id: EVENT } : {}),
  });
  const api = compileUI(
    "../vault-api",
    {
      "./api": { getBackendUrl: async () => "https://example.test" },
      "./auth": {
        captureCurrentSession: async () => session(),
        getSessionJWT: async () => session().jwt,
        applyForCurrentSession: apply,
      },
      "./db": { getAppMeta: meta, setAppMeta: setMeta },
      "./db-tx": {
        getDb: async () => db,
        getInstallIdSync: () => "install",
        getAppMetaInTx: (_: any, key: string) => meta(key),
        setAppMetaInTx: (_: any, key: string, value: string) => setMeta(key, value),
      },
      "expo-crypto": { randomUUID },
      "./mesh/device-key": {
        getDeviceSigner: async () => ({
          pubkey_b64: pub,
          sign: async (bytes: Uint8Array) => ed.sign(bytes, seed),
        }),
      },
      "./trust/proof": { getLocalMembershipState: async () => (ownerPublished ? state() : null) },
      "./trust/backfill": {
        ensureChainBackfill: async () => {},
        isSelfAdmissionPublished: async () => true,
      },
      "./event-sig": sig,
      "./trust/ownership-transfer": transfer,
      "./sync/push": { pushEvents: async () => ({ pushed: 0, rejected: 0, duplicates: 0 }) },
      "./projection": { applyEventMutex: { runExclusive: (work: any) => work() } },
      "./recovery": { recoverJoinedVault: async () => false },
    },
    {
      fetch: async (url: string, init: any) => {
        const path = new URL(url).pathname;
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ path, method: init.method, body });
        if (held) return held.promise;
        if (path === "/v1/vaults") return Response.json({});
        if (path.endsWith("/accept")) {
          if (lost) {
            lost = false;
            throw Error("response lost after server acceptance");
          }
          return Response.json(result());
        }
        if (init.method === "GET")
          return Response.json({
            pending: { invite_email: "dad@example.test", expires_at: "2026-10-22T00:00:00Z" },
          });
        if (init.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({
          invite_url: "https://kaata.af/i/secret",
          invite_email: body.authorization.grant.recipient_email_normalized,
          expires_at: new Date(body.authorization.grant.expires_at_ms).toISOString(),
        });
      },
    },
  );
  return {
    api,
    calls,
    store,
    session,
    meta,
    SessionChangedError,
    recipient: () => {
      account = TARGET;
      version++;
    },
    switchAccount: () => {
      account = TARGET;
      version++;
    },
    alias: () => {
      chainAccount = buildLocalAccountId(pub);
      return chainAccount;
    },
    unready: () => {
      ownerPublished = false;
    },
    notOwner: () => {
      memberRole = "editor";
    },
    loseReply: () => {
      lost = true;
    },
    unconfirmed: () => {
      confirmTransfer = false;
    },
    registerAnchor: () => {
      store.prepare("INSERT INTO vaults VALUES(?,?,?,?,?)").run(VAULT, "Household", "AFN", 1, pub);
    },
    hold: () => {
      held = deferred();
      return held;
    },
  };
}

async function apiCases() {
  for (const alias of [false, true]) {
    const f = fixture();
    const chainAlias = alias ? f.alias() : undefined;
    const created = await f.api.createOwnershipTransferInvite(
      VAULT,
      " A.Da+family@googlemail.com ",
    );
    assert.equal(created.invite_email, "ada@gmail.com");
    const authorization = f.calls[0].body.authorization;
    assert.equal(authorization.grant.from_account_id, OWNER);
    assert.equal(authorization.grant.from_chain_account_id, chainAlias);
    assert.equal(authorization.grant.demote_self_to, "editor");
    assert.equal(
      authorization.grant.expires_at_ms - authorization.grant.issued_at_ms,
      7 * 86400000,
    );
    assert.ok(
      sig.verifyRawSignature(
        transfer.ownershipTransferGrantBytes(authorization.grant, sig.canonicalize),
        authorization.sig_b64,
        pub,
      ),
    );
    assert.equal(
      (await f.api.fetchOwnershipTransferInvite(VAULT)).recipient_email,
      "dad@example.test",
    );
    await f.api.cancelOwnershipTransferInvite(VAULT);
    assert.equal(f.calls.at(-1)?.method, "DELETE");
    f.store.close();
  }
  for (const fault of ["email", "unready", "role"] as const) {
    const f = fixture();
    if (fault === "unready") f.unready();
    if (fault === "role") f.notOwner();
    await assert.rejects(
      f.api.createOwnershipTransferInvite(
        VAULT,
        fault === "email" ? "not an email" : "dad@example.test",
      ),
    );
    assert.equal(
      f.calls.length,
      0,
      "no offer may be sent without owner proof and recipient identity",
    );
    f.store.close();
  }
  const legacy = fixture();
  legacy.registerAnchor();
  await legacy.api.createOwnershipTransferInvite(VAULT, "dad@example.test");
  assert.equal(
    legacy.calls[0].path,
    "/v1/vaults",
    "normal registration repairs a missing server anchor before invitation",
  );
  assert.equal(legacy.calls[0].body.vault_trust_anchor_pubkey, pub);
  assert.ok(legacy.calls[1].path.endsWith("/ownership-invites"));
  legacy.store.close();
  const late = fixture(),
    gate = late.hold();
  const creating = late.api.createOwnershipTransferInvite(VAULT, "dad@example.test");
  await settleUI();
  late.switchAccount();
  gate.resolve(
    Response.json({
      invite_url: "https://kaata.af/i/old-secret",
      invite_email: "dad@example.test",
      expires_at: "2026-10-22T00:00:00Z",
    }),
  );
  await assert.rejects(creating, late.SessionChangedError);
  late.store.close();

  const lost = fixture();
  lost.recipient();
  lost.loseReply();
  await assert.rejects(
    lost.api.acceptVaultInvite("offer", lost.session(), "ownership_transfer"),
    /response lost/,
  );
  assert.equal(
    JSON.parse((await lost.meta(`invite_accept_pending:${TARGET}`))!)[0].kind,
    "ownership_transfer",
  );
  assert.equal(
    await lost.meta("pending_invite_token"),
    "offer",
    "cold launch resumes a transfer whose response was lost",
  );
  await lost.api.retryPendingVaultMaterialize();
  assert.ok(
    lost.calls.every((call) => call.path.endsWith("/ownership-invites/accept")),
    "restart retries must use the transfer endpoint",
  );
  const accepted = await lost.api.resumePendingVaultInvite("offer", lost.session());
  assert.equal(accepted.ownership_event_id, EVENT);
  assert.equal(lost.calls.length, 2, "known server receipt never consumes the offer again");
  assert.equal(
    await lost.api.isOwnershipTransferApplied(accepted, lost.session()),
    false,
    "old published membership is insufficient",
  );
  lost.store
    .prepare("INSERT INTO event_log VALUES(?,?,?,?,1,NULL,NULL)")
    .run(VAULT, EVENT, "vault_member_added", "{}");
  assert.equal(await lost.api.isOwnershipTransferApplied(accepted, lost.session()), true);
  lost.store.close();
  const unconfirmed = fixture();
  unconfirmed.unconfirmed();
  await assert.rejects(
    unconfirmed.api.acceptVaultInvite("offer", unconfirmed.session(), "ownership_transfer"),
    /unconfirmed ownership/,
  );
  assert.equal(await unconfirmed.meta("vault_materialize_pending"), null);
  unconfirmed.store.close();
}

async function screenCase() {
  const hooks = uiHooks();
  let applied = false,
    poll: (() => void) | undefined;
  const calls: string[] = [],
    toasts: string[] = [],
    navigation: string[] = [];
  const session = { accountId: TARGET, jwt: "jwt", bindingVersion: 0 };
  const router = { replace: (path: string) => navigation.push(path) };
  const toast = { push: (label: string) => toasts.push(label) };
  const accepted = {
    vault_id: VAULT,
    vault_name: "Household",
    role: "owner",
    ownership_transferred: true,
    ownership_event_id: EVENT,
  };
  const screen = compileUI(
    "../../app/invite/[token]",
    {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "expo-router": { useRouter: () => router, useLocalSearchParams: () => ({ token: "offer" }) },
      "react-native": {
        ActivityIndicator: "Spinner",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (v: any) => v },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
      "../../components/Button": { Button: "Button" },
      "../../components/SettingsScreen": { ScreenHeader: "Header" },
      "../../components/Toast": { useToast: () => toast },
      "../../lib/auth": {
        getSessionJWT: async () => "jwt",
        captureCurrentSession: async () => session,
        applyForCurrentSession: async (_: any, work: any) => work(),
        SessionChangedError: class extends Error {},
      },
      "../../lib/checkin-trigger": { requestImmediateCheckIn: () => {} },
      "../../lib/colors": { colors: {} },
      "../../lib/db-tx": { setActiveVaultId: async () => {} },
      "../../lib/db": { getLocalSelf: async () => ({}), setAppMeta: async () => {} },
      "../../lib/direction": { useIsRTL: () => false, textDir: () => ({}) },
      "../../lib/fonts": { fonts: {} },
      "../../lib/i18n": { t: (k: string) => k },
      "../../lib/tokens": { icon: {}, gutter: {}, typography: {} },
      "../../lib/trust/backfill": {
        isSelfAdmissionPublished: async () => true,
        JoinAdmissionBlockedError: class extends Error {},
        emitWitnessedSelfAdmission: async () => {},
        witnessEmitPendingKey: () => "pending",
      },
      "../../lib/recovery": {
        seedJoinedVaultMinimal: async () => {},
        recoverJoinedVault: async () => {
          calls.push("recover");
          return true;
        },
      },
      "../../lib/tabs/sync": { syncAllTabs: async () => {} },
      "../../lib/vault-api": {
        ApiError: class extends Error {},
        retryPendingVaultMaterialize: async () => {},
        resumePendingVaultInvite: async () => null,
        lookupPendingInvite: async () => null,
        fetchInviteInfo: async () => ({
          kind: "ownership_transfer",
          vault_name: "Household",
          role: "owner",
          expires_at: Date.now() + 100000,
        }),
        acceptVaultInvite: async (_: any, __: any, kind: string) => {
          assert.equal(kind, "ownership_transfer");
          calls.push("accept");
          return accepted;
        },
        isOwnershipTransferApplied: async () => applied,
        clearPendingVaultInvite: async () => {},
        clearVaultMaterializePending: async () => {},
      },
    },
    {
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: (fn: any) => {
        poll = fn;
        return 2;
      },
      clearInterval: () => {
        poll = undefined;
      },
    },
  ).default;
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await settleUI();
      hooks.render(screen);
    }
  };
  hooks.render(screen);
  await flush();
  const button = nodes(hooks.tree).find(
    (n) => n.type === "Button" && n.props.label === "ownershipAccept.accept",
  );
  assert.ok(button);
  await button.props.onPress();
  await flush();
  assert.deepEqual(calls, ["accept", "recover"], "existing members still pull the ownership proof");
  assert.equal(toasts.length, 0, "old Editor admission must never announce ownership success");
  assert.ok(poll);
  poll();
  await flush();
  assert.equal(calls.length, 2, "pending polling waits without hammering full restore");
  applied = true;
  assert.ok(poll);
  poll();
  await flush();
  assert.equal(calls.filter((c) => c === "accept").length, 1);
  assert.deepEqual(toasts, ["ownershipAccept.done"]);
  assert.deepEqual(navigation, ["/"]);
  hooks.unmount();
}

void (async () => {
  await apiCases();
  await screenCase();
  console.log(
    "Ownership client: signed/email-bound offers, alias ownership, permission/session guards, durable acceptance and proof-gated completion passed.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
