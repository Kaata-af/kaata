// Actual acceptance API, durable journal, append helpers, Ed25519 signatures,
// membership SQL loader and chain fold. Isolated SQLite; no user data/network.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import * as ed from "@noble/ed25519";
import * as chain from "../trust/chain";
import { compileUI, deferred, settleUI, uiHooks, jsx, nodes } from "./ui-fixture";

const eventSig = compileUI("../event-sig", {
  "@noble/hashes/sha512": require("@noble/hashes/sha512"),
  "@noble/ed25519": ed,
  "expo-crypto": { getRandomBytes: randomBytes },
});
const runtime = compileUI("../trust/crypto-runtime", { "../event-sig": eventSig });
const ownerSeed = new Uint8Array(32).fill(4),
  peerSeed = new Uint8Array(32).fill(5),
  serverSeed = new Uint8Array(32).fill(6);
const key = (seed: Uint8Array) => Buffer.from(ed.getPublicKey(seed)).toString("base64");
const ownerKey = key(ownerSeed),
  peerKey = key(peerSeed),
  serverKey = key(serverSeed);

async function fixture() {
  const store = new Database(":memory:");
  store.exec(`
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE pending_invitations(token TEXT,accepted_at INTEGER);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,vault_trust_anchor_pubkey TEXT,archived_at INTEGER);
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,event_type TEXT,vault_id TEXT,target_id TEXT,
      relationship_id TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT,
      device_id TEXT,actor_account_id TEXT,payload_json TEXT,payload_schema INTEGER,event_sig_b64 TEXT,
      signer_device_pubkey TEXT,author_seq INTEGER,tombstone_reason TEXT,rejected_at INTEGER,server_acked_at INTEGER);
    INSERT INTO pending_invitations VALUES('invite',NULL);
  `);
  store.prepare("INSERT INTO vaults VALUES('vault',?,NULL)").run(ownerKey);
  let account = "peer",
    version = 0,
    locked = false,
    now = 1000000,
    attempts = 0,
    offline = false,
    refuse = false,
    nextWitnessStatus = 0;
  let tail = Promise.resolve();
  const calls: string[] = [];
  class SessionChangedError extends Error {}
  const session = () => ({ accountId: account, jwt: `jwt-${account}`, bindingVersion: version });
  const auth = {
    SessionChangedError,
    captureCurrentSession: async () => session(),
    getSessionJWT: async () => session().jwt,
    applyForCurrentSession: async (before: any, work: () => Promise<any>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      if (before.accountId !== account || before.bindingVersion !== version) {
        release();
        throw new SessionChangedError();
      }
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
        release();
      }
    },
  };
  const db = {
    getFirstAsync: async (sql: string, ...args: any[]) => store.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: any[]) => store.prepare(sql).all(...args),
    runAsync: async (sql: string, ...args: any[]) => store.prepare(sql).run(...args),
    withTransactionAsync: async (work: () => Promise<any>) => {
      store.exec("BEGIN");
      try {
        const result = await work();
        store.exec("COMMIT");
        return result;
      } catch (err) {
        store.exec("ROLLBACK");
        throw err;
      }
    },
  };
  const getMeta = async (name: string) =>
    (store.prepare("SELECT value FROM app_meta WHERE key=?").get(name) as any)?.value ?? null;
  const setMeta = async (name: string, value: string) => {
    store.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(name, value);
  };
  await setMeta("mesh_server_pubkey_primary", serverKey);
  const dbModule = {
    getDb: async () => db,
    getAppMeta: getMeta,
    setAppMeta: setMeta,
    getLocalSelf: async () => ({ name: "Ahmad" }),
  };
  const dbTx = {
    getDb: async () => db,
    getAccountIdSync: () => account,
    getInstallIdSync: () => "peer-device",
    getLocalSelfUserIdSync: () => "self",
    getActiveVaultIdSync: () => "vault",
    getAppMetaInTx: async (_: any, name: string) => getMeta(name),
    setAppMetaInTx: async (_: any, name: string, value: string) => setMeta(name, value),
  };
  const proof = compileUI("../trust/proof", {
    "../db": dbModule,
    "./chain": chain,
    "./crypto-runtime": runtime,
  });
  let seq = 0,
    dropNext = false;
  async function append(event: any, seed = peerSeed, ack = false) {
    event.relationship_id = null;
    event.hlc = { pms: now, l: seq++, did: event.device_id };
    event.event_sig_b64 = Buffer.from(ed.sign(eventSig.canonicalizeEvent(event), seed)).toString(
      "base64",
    );
    event.signer_device_pubkey = key(seed);
    store
      .prepare("INSERT INTO event_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)")
      .run(
        event.event_id,
        event.event_type,
        "vault",
        event.target_id,
        null,
        event.hlc.pms,
        event.hlc.l,
        event.device_id,
        event.device_id,
        event.actor_account_id,
        JSON.stringify(event.payload),
        event.payload_schema,
        event.event_sig_b64,
        event.signer_device_pubkey,
        seq,
        ack ? now : null,
      );
  }
  await append(
    {
      event_id: "genesis",
      event_type: "vault_member_added",
      vault_id: "vault",
      target_id: "owner",
      device_id: "owner-device",
      actor_account_id: "owner",
      payload_schema: 1,
      payload: { account_id: "owner", role: "owner" },
    },
    ownerSeed,
    true,
  );
  const device = {
    ensureDeviceKey: async () => ({ pubkey_b64: peerKey }),
    getDevicePubkey: () => peerKey,
    META_REBIND_PENDING_KEY: "rebind",
    META_REREGISTER_PENDING_KEY: "reregister",
    registerDeviceKey: async () => {
      calls.push("register-key");
      await setMeta("reregister", "");
      return "registered";
    },
    signWithDeviceKey: async (msg: Uint8Array) => ed.sign(msg, peerSeed),
  };
  const events = compileUI("../event-log", {
    "expo-crypto": { randomUUID },
    "./db-tx": dbTx,
    "./mesh/device-key": device,
    "./event-sig": eventSig,
    "./projection": {
      applyEvent: async (event: any) => {
        assert.ok(locked, "join appends must own the original session guard");
        if (dropNext) {
          dropNext = false;
          return { applied: false };
        }
        await append(event);
        const folded = await proof.getLocalMembershipState("vault");
        const conflict = folded.conflicts.find((c: any) => c.event_id === event.event_id);
        return conflict
          ? {
              applied: false,
              reason: "role_gate",
              role_gate: { reason: "unknown_actor", current_role: null, required_role: "owner" },
            }
          : { applied: true };
      },
    },
    "./money": {},
    "./money-sql": {},
    "./tabs/errors": { TabLinkedEntryError: class extends Error {} },
  });
  class ApiError extends Error {
    constructor(public status: number) {
      super("refused");
    }
  }
  const witness = () => {
    const sig = (tuple: any) =>
      Buffer.from(
        ed.sign(new TextEncoder().encode(eventSig.canonicalize(tuple)), serverSeed),
      ).toString("base64");
    return {
      server_key_id: "key",
      member_witness: {
        role: "viewer",
        inviter_account_id: "owner",
        issued_at_ms: now,
        sig_b64: sig(
          chain.memberWitnessTuple({
            vault_id: "vault",
            account_id: "peer",
            inviter_account_id: "owner",
            role: "viewer",
            issued_at_ms: now,
          }),
        ),
      },
      device_witness: {
        issued_at_ms: now,
        sig_b64: sig(
          chain.deviceWitnessTuple({
            vault_id: "vault",
            account_id: "peer",
            device_id: "peer-device",
            device_pubkey_b64: peerKey,
            issued_at_ms: now,
          }),
        ),
      },
    };
  };
  const witnessGate = deferred<any>();
  let holdWitness = false;
  const backfill = compileUI(
    "../trust/backfill",
    {
      "../auth": auth,
      "../db": dbModule,
      "../db-tx": dbTx,
      "../i18n": { isPlaceholderSelfName: () => false },
      "../event-log": events,
      "../vault-roles": { parseVaultRole: (role: string) => role },
      "../mesh/device-key": device,
      "./account-id": { buildLocalAccountId: () => "local" },
      "./proof": proof,
      "./chain": chain,
      "../recovery": {
        pinServerWitnessKeys: async (before: any) => {
          assert.equal(locked, false, "key check-in must not hold session mutex");
          calls.push("pin-keys");
          await auth.applyForCurrentSession(before, () =>
            setMeta("mesh_server_pubkey_primary", serverKey),
          );
        },
      },
      "../projection/sweep": {
        sweepVaultNow: async () => {
          assert.ok(locked);
          calls.push("sweep-after-pin");
        },
      },
      "../vault-api": {
        ApiError,
        fetchMembershipWitness: async () => {
          assert.equal(locked, false, "HTTP cannot hold session mutex");
          attempts++;
          if (nextWitnessStatus) {
            const status = nextWitnessStatus;
            nextWitnessStatus = 0;
            throw new ApiError(status);
          }
          if (offline) throw Error("offline");
          if (refuse) throw new ApiError(403);
          return holdWitness ? witnessGate.promise : witness();
        },
      },
    },
    { Date: { now: () => now } },
  );
  let responseMode = "ok";
  let timeoutCallback: (() => void) | undefined;
  const requestGate = deferred<any>();
  const api = compileUI(
    "../vault-api",
    {
      "./api": { getBackendUrl: async () => "https://test.invalid" },
      "./auth": auth,
      "./db": dbModule,
      "./db-tx": dbTx,
      "./projection": { applyEventMutex: { runExclusive: (work: any) => work() } },
      "./recovery": {
        recoverJoinedVault: async () => {
          calls.push("recover");
          return false;
        },
      },
    },
    {
      __DEV__: false,
      AbortController,
      clearTimeout: () => {
        timeoutCallback = undefined;
      },
      setTimeout: (fn: () => void) => {
        timeoutCallback = fn;
        return 1;
      },
      fetch: async (_: string, opts: any) => {
        calls.push(`post:${opts.headers.Authorization}`);
        assert.ok(await getMeta("invite_accept_pending:peer"), "intent precedes consuming POST");
        if (responseMode === "lost") throw Error("lost response after server commit");
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () =>
            responseMode === "hold"
              ? requestGate.promise
              : { vault_id: "vault", vault_name: "Shop", role: "viewer" },
        };
      },
    },
  );
  return {
    store,
    proof,
    backfill,
    api,
    getMeta,
    setMeta,
    calls,
    session,
    SessionChangedError,
    append,
    witnessStatus: (status: number) => {
      nextWitnessStatus = status;
    },
    advance: () => {
      now += 61_000;
    },
    attempts: () => attempts,
    offline: () => {
      offline = true;
    },
    online: () => {
      offline = false;
    },
    refuse: () => {
      refuse = true;
    },
    ack: () => store.exec("UPDATE event_log SET server_acked_at=1"),
    noAnchor: () => store.exec("UPDATE vaults SET vault_trust_anchor_pubkey=NULL"),
    dropAppend: () => {
      dropNext = true;
    },
    holdWitness: () => {
      holdWitness = true;
    },
    releaseWitness: () => witnessGate.resolve(witness()),
    switchAccount: () => {
      account = "other";
      version++;
    },
    response: (mode: string) => {
      responseMode = mode;
    },
    expire: () => {
      assert.ok(timeoutCallback);
      timeoutCallback!();
    },
    releaseResponse: () =>
      requestGate.resolve({ vault_id: "vault", vault_name: "Shop", role: "viewer" }),
  };
}

async function main() {
  const healthy = await fixture();
  await assert.rejects(healthy.backfill.emitWitnessedSelfAdmission("vault"), /server confirmation/);
  const folded = await healthy.proof.getLocalMembershipState("vault");
  assert.equal(folded.members.get("peer").role, "viewer");
  assert.equal(folded.devices.get(peerKey).account_id, "peer");
  assert.equal(
    folded.conflicts.length,
    0,
    "real signed append helpers produce valid witness chain",
  );
  healthy.ack();
  healthy.offline();
  await healthy.backfill.emitWitnessedSelfAdmission("vault");
  assert.equal(
    healthy.attempts(),
    1,
    "already-published proof completes offline without new witness",
  );

  const retry = await fixture();
  await retry.backfill.ensureChainBackfill("vault"); // startup before invite
  await retry.setMeta("witness_emit_pending:vault", "1");
  retry.offline();
  await retry.backfill.ensureChainBackfill("vault");
  assert.equal(retry.attempts(), 1, "early one-shot pass must not consume later join retry");
  retry.online();
  retry.advance();
  await retry.backfill.ensureChainBackfill("vault");
  assert.equal(
    await retry.getMeta("witness_emit_pending:vault"),
    "1",
    "local append is not published success",
  );
  retry.ack();
  retry.advance();
  await retry.backfill.ensureChainBackfill("vault");
  assert.equal(await retry.getMeta("witness_emit_pending:vault"), "");

  const missing = await fixture();
  missing.noAnchor();
  await assert.rejects(missing.backfill.emitWitnessedSelfAdmission("vault"), /owner proof/);
  assert.equal(
    (missing.store.prepare("SELECT COUNT(*) n FROM event_log").get() as any).n,
    1,
    "no mirror-only fake admission",
  );
  const declined = await fixture();
  declined.dropAppend();
  await assert.rejects(declined.backfill.emitWitnessedSelfAdmission("vault"));
  const blocked = await fixture();
  blocked.refuse();
  await assert.rejects(
    blocked.backfill.emitWitnessedSelfAdmission("vault"),
    blocked.backfill.JoinAdmissionBlockedError,
  );
  blocked.advance();
  await assert.rejects(
    blocked.backfill.emitWitnessedSelfAdmission("vault"),
    blocked.backfill.JoinAdmissionBlockedError,
  );
  assert.equal(blocked.attempts(), 1, "removed permission does not hammer witness endpoint");
  const registration = await fixture();
  registration.witnessStatus(412);
  await assert.rejects(registration.backfill.emitWitnessedSelfAdmission("vault"));
  assert.equal(await registration.getMeta("reregister"), "1");
  registration.advance();
  await assert.rejects(
    registration.backfill.emitWitnessedSelfAdmission("vault"),
    /server confirmation/,
  );
  assert.ok(
    registration.calls.includes("register-key"),
    "failed first registration is repaired before requesting witness again",
  );
  const unpinned = await fixture();
  await unpinned.setMeta("mesh_server_pubkey_primary", "");
  await assert.rejects(
    unpinned.backfill.emitWitnessedSelfAdmission("vault"),
    /server confirmation/,
  );
  assert.deepEqual(
    unpinned.calls,
    ["pin-keys", "sweep-after-pin"],
    "failed initial check-in is repaired before verifying the join",
  );
  assert.equal(
    (await unpinned.proof.getLocalMembershipState("vault")).members.get("peer").role,
    "viewer",
  );
  const rejected = await fixture();
  await assert.rejects(
    rejected.backfill.emitWitnessedSelfAdmission("vault"),
    /server confirmation/,
  );
  rejected.store.exec("UPDATE event_log SET rejected_at=1 WHERE actor_account_id='peer'");
  await assert.rejects(
    rejected.backfill.emitWitnessedSelfAdmission("vault"),
    rejected.backfill.JoinAdmissionBlockedError,
  );
  const oversized = await fixture();
  const clone = oversized.store.prepare(
    "INSERT INTO event_log SELECT ?,event_type,vault_id,target_id,relationship_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,actor_account_id,payload_json,payload_schema,event_sig_b64,signer_device_pubkey,author_seq,tombstone_reason,rejected_at,server_acked_at FROM event_log WHERE event_id='genesis'",
  );
  for (let i = 0; i < 500; i++) clone.run(`extra-${i}`);
  await assert.rejects(
    oversized.backfill.emitWitnessedSelfAdmission("vault"),
    oversized.backfill.JoinAdmissionBlockedError,
  );
  assert.equal(oversized.attempts(), 0, "a truncated chain cannot authorize successful readiness");
  const synthetic = await fixture();
  await synthetic.append(
    {
      event_id: "synthetic",
      event_type: "vault_member_added",
      vault_id: "vault",
      target_id: "owner",
      device_id: "owner-device",
      actor_account_id: "owner",
      payload_schema: 1,
      payload: { account_id: "owner", role: "owner", backfill_synthetic: true },
    },
    ownerSeed,
    true,
  );
  assert.equal(
    (await synthetic.proof.loadLocalMembershipEvents("vault", 500, true)).length,
    1,
    "a local recovery suppression ack is not publication",
  );
  assert.equal(
    (await synthetic.proof.loadLocalMembershipEvents("vault")).length,
    2,
    "normal chain authority stays unchanged",
  );
  const changed = await fixture();
  changed.holdWitness();
  const old = changed.backfill.emitWitnessedSelfAdmission("vault");
  await settleUI();
  changed.switchAccount();
  changed.releaseWitness();
  await assert.rejects(old, changed.SessionChangedError);
  assert.equal((changed.store.prepare("SELECT COUNT(*) n FROM event_log").get() as any).n, 1);

  const lost = await fixture();
  lost.response("lost");
  await assert.rejects(lost.api.acceptVaultInvite("invite"), /lost response/);
  assert.ok(await lost.getMeta("invite_accept_pending:peer"));
  lost.response("ok");
  await lost.api.retryPendingVaultMaterialize();
  assert.equal(await lost.getMeta("witness_emit_pending:vault"), "1");
  assert.equal(await lost.getMeta("vault_materialize_pending"), "vault");
  const resumed = await lost.api.resumePendingVaultInvite("invite", lost.session());
  assert.equal(resumed.vault_id, "vault");
  assert.equal(
    lost.calls.filter((s) => s.startsWith("post")).length,
    2,
    "consumed-link remount uses receipt, not a third POST",
  );

  const late = await fixture();
  late.response("hold");
  const accept = late.api.acceptVaultInvite("invite");
  await settleUI();
  late.switchAccount();
  late.releaseResponse();
  await assert.rejects(accept, late.SessionChangedError);
  assert.equal(await late.getMeta("witness_emit_pending:vault"), null);
  const stalled = await fixture();
  stalled.response("hold");
  const request = stalled.api.acceptVaultInvite("invite");
  await settleUI();
  stalled.expire();
  await assert.rejects(request, /timed out/);
  assert.ok(
    await stalled.getMeta("invite_accept_pending:peer"),
    "body timeout retains replayable intent",
  );
  await screenCases();
  console.log(
    "invite join: 18 regression scenarios passed (real append/signatures/fold + SQLite journal + route reuse)",
  );
}

async function screenCases() {
  for (const mode of ["pending", "late-success", "late-error"]) {
    const hooks = uiHooks();
    let token = "A",
      published = false;
    const posts: string[] = [],
      toasts: string[] = [],
      navigations: string[] = [];
    const gate = deferred<any>();
    const router = { replace: (path: string) => navigations.push(path) };
    const toast = { push: (label: string) => toasts.push(label) };
    const session = { accountId: "peer", jwt: "jwt", bindingVersion: 0 };
    const result = (id: string) => ({ vault_id: id, vault_name: `Kaata ${id}`, role: "viewer" });
    let poll: (() => void) | undefined;
    const colors = new Proxy({}, { get: () => "black" });
    const screen = compileUI(
      "../../app/invite/[token]",
      {
        react: hooks.react,
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "@expo/vector-icons": { Ionicons: "Icon" },
        "expo-router": { useRouter: () => router, useLocalSearchParams: () => ({ token }) },
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
        "../../lib/colors": { colors },
        "../../lib/db-tx": { setActiveVaultId: async () => {} },
        "../../lib/db": {
          getLocalSelf: async () => ({ name: "Ahmad" }),
          setAppMeta: async () => {},
        },
        "../../lib/direction": { textDir: () => ({}), useIsRTL: () => false },
        "../../lib/fonts": { fonts: {} },
        "../../lib/i18n": { t: (key: string) => key },
        "../../lib/tokens": { gutter: 16, icon: { hero: 40 }, typography: {} },
        "../../lib/trust/backfill": {
          JoinAdmissionBlockedError: class extends Error {},
          isSelfAdmissionPublished: async () => published,
          witnessEmitPendingKey: (id: string) => id,
          emitWitnessedSelfAdmission: async () => {
            if (!published) throw Error("still pending");
          },
        },
        "../../lib/recovery": {
          seedJoinedVaultMinimal: async () => {},
          recoverJoinedVault: async () => true,
        },
        "../../lib/tabs/sync": { syncAllTabs: async () => {} },
        "../../lib/vault-api": {
          ApiError: class extends Error {},
          retryPendingVaultMaterialize: async () => {},
          resumePendingVaultInvite: async () => null,
          lookupPendingInvite: async () => null,
          fetchInviteInfo: async (id: string) => ({
            vault_name: `Kaata ${id}`,
            role: "viewer",
            expires_at: Date.now() + 100000,
          }),
          acceptVaultInvite: async (id: string) => {
            posts.push(id);
            return id === "A" && mode !== "pending" ? gate.promise : result(id);
          },
          clearPendingVaultInvite: async () => {},
          clearVaultMaterializePending: async () => {},
        },
      },
      {
        setTimeout: () => 1,
        clearTimeout: () => {},
        setInterval: (fn: () => void) => {
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
    const press = () => {
      const button = nodes(hooks.tree).find(
        (n) => n.type === "Button" && n.props.label === "inviteAccept.confirm.accept",
      );
      assert.ok(button, `${mode}: expected confirmation for ${token}`);
      return button.props.onPress();
    };
    const a = press();
    if (mode === "pending") {
      await a;
      await flush();
    }
    token = "B";
    hooks.render(screen);
    await flush();
    if (mode === "late-success") gate.resolve(result("A"));
    if (mode === "late-error") gate.reject(Error("old A request failed"));
    await a;
    await flush();
    await press();
    await flush();
    assert.deepEqual(
      posts,
      ["A", "B"],
      `${mode}: a fresh link cannot reuse the old accepted result`,
    );
    assert.equal(toasts.length, 0, "unfinished proof never shows joined success");
    assert.ok(nodes(hooks.tree).some((n) => n.props.children === "inviteAccept.pending.title"));
    published = true;
    assert.ok(poll);
    poll();
    await flush();
    assert.equal(
      toasts.length,
      1,
      "local server acknowledgement completes without another network retry",
    );
    assert.deepEqual(navigations, ["/"]);
    hooks.unmount();
  }
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
