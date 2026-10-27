// Run: npx tsx lib/__dev__/diagnostics-report-selftest.ts
// Actual report, proof loader/fold, signatures, identity resolution and SQL.
// Synthetic in-memory database only; no phone, private database or network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import * as ed from "@noble/ed25519";
import { compileUI } from "./ui-fixture";
import * as chain from "../trust/chain";
import * as accountIds from "../trust/account-id";
import * as verificationCache from "../trust/successful-verification-cache";
import * as ownershipTransfer from "../trust/ownership-transfer";
import { compactDiagnosticsForSms } from "../diagnostics-sms";

function smsChecks() {
  const installId = "12345678-1234-4abc-8def-1234567890ab";
  const full = [
    "Kaata — App health",
    "App (native): 2.2.0 (build 37)",
    "App (JS bundle): 2.1.9 (build 36)",
    "Platform: android 35",
    "Install: " + installId,
    "Active kaata: abcd1234",
    "Schema: 105_enabled_currencies (105 applied)",
    "Sync: push=10-27 11:12:13 pull=never seq=12345",
    "Unsent events: 12  ·  Rejected: 3",
    "Last sync error: VaultNotRegisteredError @ 10-27 11:12:13",
    "  Bearer PRIVATE_JWT customer=PRIVATE_CUSTOMER note=PRIVATE_NOTE",
    "Device key: NOT READY (read_failed), no mirror; rotated 2x, last 10-27 11:12:13, 1 retired; 3 consecutive read failures; pending re-register+re-bind",
    "Membership proof: anchor=yes genesis=yes currentMember=yes currentDevice=no activeMembers=2 conflicts=0",
    "Last contact save error: storage_busy (create_person) @ 10-27 11:12:13",
    "Recent exits (newest first):",
    "  10-26 01:02:03 LOW_MEMORY rss=145.5MB imp=100",
    "Account: PRIVATE_ACCOUNT",
    "Backend: https://PRIVATE_HOST.invalid/?token=PRIVATE_TOKEN",
    "Customer: PRIVATE_CUSTOMER",
    "Note: PRIVATE_NOTE",
    "Public key: PRIVATE_KEY",
    "people=9 entries=87 kaatas=2",
  ].join("\n");
  function basicGsm(text: string) {
    assert.ok(text.length <= 450, `SMS uses ${text.length} septets`);
    for (const char of text) {
      const code = char.charCodeAt(0);
      assert.ok(char === "\n" || (code >= 32 && code <= 126), "ASCII only");
      assert.equal(
        "^{}\\[~]|`".includes(char),
        false,
        `not a single-septet GSM character: ${char}`,
      );
    }
  }
  const compact = compactDiagnosticsForSms(full);
  basicGsm(compact);
  for (const line of [
    "Kaata App health",
    "Native:2.2.0 b37",
    "JS:2.1.9 b36",
    "Platform:android 35",
    `Install:${installId}`,
    "Kaata:abcd1234",
    "Schema:105/105",
    "Sync:p=10-27 11:12:13 q=never seq=12345",
    "Events:unsent=12 rejected=3",
    "SyncErr:VaultNotRegisteredError",
    "Key:NOT READY/read_failed no-mirror rot=2 read=3 pending",
    "Proof:m=yes d=no",
    "PersonErr:storage_busy/create_person",
    "Exit:10-26 01:02:03 LOW_MEMORY",
  ])
    assert.ok(compact.split("\n").includes(line), line);
  for (const privateValue of ["PRIVATE_", "Bearer", "people=", "entries=", "https://"])
    assert.equal(compact.includes(privateValue), false, privateValue);

  // Priorities survive even when every mandatory field reaches its maximum
  // valid size and optional fields no longer all fit. Never slice identifiers.
  const maxVersion = "1.2.3-" + "x".repeat(26);
  const crowded = full
    .replace("2.2.0 (build 37)", `${maxVersion} (build 123456789012)`)
    .replace("2.1.9 (build 36)", `${maxVersion} (build 123456789012)`)
    .replace("android 35", "android 1234567890.12345")
    .replace("105_enabled_currencies (105 applied)", "999999_long_name (999999999 applied)")
    .replace(
      "push=10-27 11:12:13 pull=never seq=12345",
      "push=10-27 11:12:13 pull=10-27 14:15:16 seq=999999999999",
    )
    .replace("12  ·  Rejected: 3", "999999999  ·  Rejected: 999999999");
  const bounded = compactDiagnosticsForSms(crowded);
  basicGsm(bounded);
  assert.ok(
    bounded.startsWith(
      `Kaata App health\nNative:${maxVersion} b123456789012\nJS:${maxVersion} b123456789012\n`,
    ),
  );
  assert.ok(bounded.includes(`Install:${installId}\n`));
  assert.ok(bounded.includes("Events:unsent=999999999 rejected=999999999"));
  assert.ok(bounded.includes("SyncErr:VaultNotRegisteredError"));
  assert.equal(
    bounded.endsWith("..."),
    false,
    "omit whole optional fields, never truncate report text",
  );

  // A malformed identity must not be shortened into a plausible correlation key.
  const unsupported = compactDiagnosticsForSms(
    [
      "App (native): 1.2.3` (build 37)",
      "App (JS bundle): نسخه😀 (build 36)",
      "Install: " + installId + " PRIVATE_TOKEN",
      "Platform: android 35😀",
      "Active kaata: customer name",
      "Schema: PRIVATE_SCHEMA (3 applied)",
      "Last sync error: eyJhbGciOiJIUzI1NiJ9.PRIVATE_JWT @ 10-27 11:12:13",
      "Device key: PRIVATE_KEY",
      "Last contact save error: PRIVATE_NOTE (create_person) @ 10-27 11:12:13",
      "Recent exits (newest first):",
      "  10-26 01:02:03 PRIVATE_CUSTOMER rss=1MB imp=100",
    ].join("\n"),
  );
  basicGsm(unsupported);
  assert.ok(unsupported.includes("Native:? b37"));
  assert.ok(unsupported.includes("JS:? b36"));
  assert.ok(unsupported.includes("Install:?\n"));
  assert.ok(unsupported.includes("SyncErr:other"));
  assert.equal(unsupported.includes(installId), false);
  assert.equal(unsupported.includes("PRIVATE_"), false);
  assert.equal(unsupported.includes("PersonErr:"), false);
  assert.equal(unsupported.includes("Exit:"), false);

  const duplicate = compactDiagnosticsForSms(
    full.replace(/\n/g, "\r\n") +
      [
        "\r\nInstall: 99999999-9999-4999-8999-999999999999",
        "\r\n  App (native): 9.9.9 (build 999)",
        "\r\nLast sync error: PRIVATE_JWT",
      ].join(""),
  );
  assert.equal(duplicate, compact, "first exact labels win; indented text cannot inject fields");
  const unavailable = compactDiagnosticsForSms(
    [
      "App (native): ? (build ?)",
      "App (JS bundle): 2.2.0 (build 37)",
      "Install: —",
      "Active kaata: none",
      "Unsent/rejected events: —",
      "Last sync error: none",
      "Membership proof: incomplete (event limit=2048); currentMember=unknown currentDevice=unknown",
      "Recent exits: none recorded",
    ].join("\n"),
  );
  basicGsm(unavailable);
  assert.ok(unavailable.includes("Native:? b?"));
  assert.ok(unavailable.includes("Kaata:none"));
  assert.ok(unavailable.includes("Events:?"));
  assert.ok(unavailable.includes("SyncErr:none"));
  assert.ok(unavailable.includes("Proof:m=unknown d=unknown"));
  assert.ok(unavailable.includes("Exit:none"));
  basicGsm(compactDiagnosticsForSms(""));
  basicGsm(compactDiagnosticsForSms(full + "\nUnknown: " + "😀PRIVATE_NOTE".repeat(10000)));
  console.log(
    "PASS diagnostics SMS: GSM septet budget, complete priority IDs/versions, structured statuses and private-content exclusion",
  );
}

const eventSig = compileUI("../event-sig", {
  "@noble/hashes/sha512": require("@noble/hashes/sha512"),
  "@noble/ed25519": ed,
  "expo-crypto": { getRandomBytes: randomBytes },
});
const runtimeCrypto = compileUI("../trust/crypto-runtime", {
  "../event-sig": eventSig,
  "./successful-verification-cache": verificationCache,
  "./chain": chain,
  "./ownership-transfer": ownershipTransfer,
  "kaata-bt-classic": { verifyEd25519BatchAsync: async () => null },
});
const ownerSeed = new Uint8Array(32).fill(7);
const peerSeed = new Uint8Array(32).fill(8);
const ownerKey = Buffer.from(ed.getPublicKey(ownerSeed)).toString("base64");
const peerKey = Buffer.from(ed.getPublicKey(peerSeed)).toString("base64");
const secretContent = "PRIVATE CUSTOMER NAME AND TALLY NOTE";

function fixture() {
  const store = new Database(":memory:");
  store.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE vaults (id TEXT PRIMARY KEY, vault_trust_anchor_pubkey TEXT,
                         registered_with_server_at INTEGER, archived_at INTEGER);
    CREATE TABLE event_log (
      event_id TEXT PRIMARY KEY, event_type TEXT, vault_id TEXT, target_id TEXT,
      relationship_id TEXT, hlc_physical_ms INTEGER, hlc_logical INTEGER,
      hlc_device_id TEXT, device_id TEXT, actor_account_id TEXT, payload_json TEXT,
      payload_schema INTEGER, event_sig_b64 TEXT, signer_device_pubkey TEXT,
      author_seq INTEGER, applied_at INTEGER, quarantine_reason TEXT,
      rejected_at INTEGER, tombstone_reason TEXT, server_acked_at INTEGER);
    INSERT INTO app_meta VALUES ('account_id', 'current-account');
    INSERT INTO app_meta VALUES ('witness_emit_pending:active-vault', '1');
  `);
  store.prepare("INSERT INTO vaults VALUES (?, ?, 1, NULL)").run("active-vault", ownerKey);
  store.prepare("INSERT INTO vaults VALUES (?, ?, 1, NULL)").run("other-vault", ownerKey);
  let activeVault: string | null = "active-vault";
  let account: string | null = "current-account";
  let version = 0;
  let ready = true;
  let signerKey = peerKey;
  let proofHook: (() => void) | null = null;
  let failCounts = false;
  let failProof = false;
  let statusCalls = 0;
  let seq = 0;
  const db = {
    getFirstAsync: async (sql: string, ...args: any[]) => {
      if (failCounts && sql.includes("COUNT(*) AS total")) throw Error(secretContent);
      return store.prepare(sql).get(...args) ?? null;
    },
    getAllAsync: async (sql: string, ...args: any[]) => store.prepare(sql).all(...args),
  };
  const meta = async (key: string) =>
    (store.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as any)?.value ?? null;
  const device = {
    getDevicePubkey: () => (ready ? signerKey : null),
    readOwnDevicePubkeys: async () => ({ current: peerKey, retired: [ownerKey] }),
    getDeviceKeyStatus: async () => {
      statusCalls++;
      return {
        ready,
        rotations: 0,
        lastRotatedAt: null,
        retiredCount: 1,
        readFailures: 0,
        reregisterPending: false,
        rebindPending: false,
        mirrored: true,
        lastFailure: null,
      };
    },
    ensureDeviceKey: () => {
      throw Error("diagnostics must not separately repair a key");
    },
  };
  const dbTx = { getDb: async () => db, getActiveVaultIdSyncMaybe: () => activeVault };
  const dbModule = { ...dbTx, getAppMeta: meta };
  const identity = compileUI("../effective-account", {
    "./db-tx": dbTx,
    "./mesh/device-key": device,
    "./trust/account-id": accountIds,
  });
  const proof = compileUI("../trust/proof", {
    "../db": dbModule,
    "./chain": chain,
    "./crypto-runtime": runtimeCrypto,
  });
  const report = compileUI("../diagnostics-report", {
    "expo-application": { nativeApplicationVersion: "2.2.0", nativeBuildVersion: "37" },
    "expo-constants": {
      __esModule: true,
      default: { expoConfig: { version: "2.2.0", ios: { buildNumber: "37" } } },
    },
    "react-native": { Platform: { OS: "ios", Version: "18" } },
    "../constants/env": { MESH_PARKED: true },
    "./api": { getBackendUrl: async () => "https://synthetic.invalid" },
    "./auth": {
      isSignedIn: async () => !!account,
      captureCurrentSession: async () => ({ accountId: account, bindingVersion: version }),
      applyForUnchangedLocalSession: async (before: any, work: () => Promise<any>) => {
        if (before.accountId !== account || before.bindingVersion !== version)
          throw Error("synthetic session changed");
        return work();
      },
    },
    "./db": dbModule,
    "./db-tx": dbTx,
    "./calendar": { getCalendarPref: () => "auto", getEffectiveCalendar: () => "jalali" },
    "./i18n": { getLocale: () => "fa" },
    "./sync/cursor": { getSyncIndicator: async () => ({ lastPulledServerSeq: 4 }) },
    "./sync/last-error": { getLastSyncError: async () => null },
    "./person-save-error": { getLastPersonSaveError: async () => null },
    "./mesh/device-key": device,
    "./effective-account": identity,
    "./trust/chain": chain,
    "./trust/proof": {
      PROOF_BUNDLE_CAP: proof.PROOF_BUNDLE_CAP,
      getLocalMembershipState: async (id: string) => {
        if (failProof) throw Error(secretContent);
        const value = await proof.getLocalMembershipState(id);
        proofHook?.();
        return value;
      },
    },
    "./tabs/sync": {
      tabDiscoveryStatus: () => ({
        failures: 0,
        lastOkAt: null,
        skips: { unbound: 0, waiting: 0, conflicts: 0 },
      }),
    },
    "./db-health": { probeDatabaseIntegrity: async () => "ok" },
    "./db-backup": { listLocalBackups: () => [] },
  });
  function add(type: string, payload: object, flags: Record<string, any> = {}) {
    const event = {
      event_id: `event-${++seq}`,
      event_type: type,
      vault_id: flags.vault ?? "active-vault",
      target_id: "target",
      relationship_id: null,
      hlc: { pms: seq, l: 0, did: "owner-device" },
      device_id: "owner-device",
      actor_account_id: "owner-account",
      payload,
      payload_schema: 1,
    };
    const signature = Buffer.from(ed.sign(eventSig.canonicalizeEvent(event), ownerSeed)).toString(
      "base64",
    );
    store
      .prepare(`INSERT INTO event_log VALUES (${Array(20).fill("?").join(",")})`)
      .run(
        event.event_id,
        type,
        event.vault_id,
        event.target_id,
        null,
        seq,
        0,
        "owner-device",
        event.device_id,
        event.actor_account_id,
        JSON.stringify(payload),
        1,
        flags.unsigned ? null : signature,
        ownerKey,
        seq,
        flags.unapplied ? null : seq,
        flags.quarantine ?? null,
        flags.rejected ? seq : null,
        flags.tombstone ?? null,
        seq,
      );
    return event.event_id;
  }
  function populate() {
    add("vault_member_added", { account_id: "owner-account", role: "owner", name: secretContent });
    add(
      "vault_member_added",
      { account_id: "current-account", role: "editor" },
      { unapplied: true, quarantine: "missing_prereq" },
    );
    add(
      "vault_device_added",
      { account_id: "current-account", device_id: "peer-device", device_pubkey: peerKey },
      { rejected: true },
    );
    add(
      "vault_member_added",
      { account_id: "ignored", role: "viewer" },
      { unapplied: true, tombstone: "bad_signature" },
    );
    add(
      "vault_member_added",
      { account_id: "unsigned", role: "viewer" },
      { unapplied: true, unsigned: true },
    );
    add(
      "entry_created",
      { notes: secretContent },
      { unapplied: true, quarantine: "missing_prereq", rejected: true },
    );
    add(
      "vault_member_added",
      { account_id: "other-owner", role: "owner" },
      { vault: "other-vault", unapplied: true, quarantine: "missing_prereq", rejected: true },
    );
  }
  return {
    store,
    add,
    populate,
    report: () => report.buildDiagnosticsReport() as Promise<string>,
    setReady: (value: boolean) => {
      ready = value;
    },
    setAccount: (value: string | null) => {
      account = value;
      version++;
    },
    setVault: (value: string | null) => {
      activeVault = value;
    },
    setProofHook: (value: () => void) => {
      proofHook = value;
    },
    failCounts: () => {
      failCounts = true;
    },
    failProof: () => {
      failProof = true;
    },
    statusCalls: () => statusCalls,
    proofCap: proof.PROOF_BUNDLE_CAP as number,
    setKey: (value: string) => {
      signerKey = value;
    },
  };
}

async function test(name: string, run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try {
    await run(f);
    console.log(`PASS diagnostics: ${name}`);
  } finally {
    f.store.close();
  }
}

async function main() {
  smsChecks();
  await test("real verified proof and active-kaata-only aggregate states without private content", async (f) => {
    f.populate();
    const installId = "abcdef12-3456-4789-8abc-1234567890ab";
    f.store.prepare("INSERT INTO app_meta VALUES ('install_id', ?)").run(installId);
    const text = await f.report();
    const sms = compactDiagnosticsForSms(text);
    assert.ok(sms.includes("Native:2.2.0 b37"));
    assert.ok(sms.includes("JS:2.2.0 b37"));
    assert.ok(sms.includes("Platform:ios 18"));
    assert.ok(sms.includes(`Install:${installId}\n`));
    assert.ok(sms.includes("Proof:m=yes d=yes"), "parse the actual report's verified proof flags");
    assert.ok(sms.length <= 450);
    assert.equal(sms.includes(secretContent), false);
    assert.ok(
      text.includes(
        "anchor=yes genesis=yes currentMember=yes currentDevice=yes activeMembers=2 conflicts=1",
      ),
    );
    assert.ok(text.includes("Pending membership witness: yes"));
    assert.ok(
      text.includes("Membership events: total=5 unapplied=3 quarantined=1 rejected=1 tombstoned=1"),
    );
    assert.ok(
      text.includes("Last sync error: none"),
      "membership health is separate from HTTP sync health",
    );
    for (const privateValue of [
      ownerKey,
      peerKey,
      secretContent,
      "owner-account",
      "other-owner",
      "ignored",
      "unsigned",
    ])
      assert.equal(text.includes(privateValue), false, privateValue);
    assert.equal(f.statusCalls(), 1, "reuse the existing device readiness probe");
  });
  await test("mirror membership alone never claims a verified chain", async (f) => {
    const text = await f.report();
    assert.ok(
      text.includes(
        "anchor=yes genesis=no currentMember=no currentDevice=no activeMembers=0 conflicts=0",
      ),
    );
    f.store
      .prepare("UPDATE vaults SET vault_trust_anchor_pubkey = NULL WHERE id = ?")
      .run("active-vault");
    assert.ok(
      (await f.report()).includes("anchor=no genesis=no currentMember=no currentDevice=no"),
    );
  });
  await test("device readiness and removal do not claim usable current-device binding", async (f) => {
    f.populate();
    f.setReady(false);
    assert.ok((await f.report()).includes("currentMember=yes currentDevice=not ready"));
    f.setReady(true);
    f.add("vault_member_removed", { account_id: "current-account" });
    assert.ok((await f.report()).includes("currentMember=no currentDevice=no activeMembers=1"));
  });
  await test("current local identity candidates resolve pre-sign-in memberships", async (f) => {
    f.store.prepare("DELETE FROM app_meta WHERE key = 'account_id'").run();
    f.setAccount(null);
    const local = accountIds.buildLocalAccountId(peerKey);
    f.add("vault_member_added", { account_id: "owner-account", role: "owner" });
    f.add("vault_member_added", { account_id: local, role: "editor" });
    f.add("vault_device_added", {
      account_id: local,
      device_id: "peer-device",
      device_pubkey: peerKey,
    });
    assert.ok((await f.report()).includes("currentMember=yes currentDevice=yes"));
  });
  await test("session ABA and active-kaata changes discard collected membership details", async (f) => {
    f.populate();
    f.setProofHook(() => {
      f.setAccount("different-account");
      f.setAccount("current-account");
    });
    let text = await f.report();
    assert.ok(text.includes("Membership proof: —"));
    assert.equal(text.includes("Pending membership witness:"), false);
    assert.equal(text.includes("Membership events:"), false);
    f.setProofHook(() => f.setVault("other-vault"));
    text = await f.report();
    assert.ok(text.includes("Membership proof: —"));
  });
  await test("a later removal outside the proof cap reports incomplete instead of healthy", async (f) => {
    f.add("vault_member_added", { account_id: "owner-account", role: "owner" });
    f.add("vault_member_added", { account_id: "current-account", role: "editor" });
    f.add("vault_device_added", {
      account_id: "current-account",
      device_id: "peer-device",
      device_pubkey: peerKey,
    });
    for (let i = 3; i < f.proofCap; i++) {
      f.add("vault_member_role_changed", { account_id: "current-account", role: "editor" });
    }
    f.add("vault_member_removed", { account_id: "current-account" });
    const text = await f.report();
    assert.ok(text.includes(`Membership proof: incomplete (event limit=${f.proofCap})`));
    assert.ok(text.includes("currentMember=unknown currentDevice=unknown"));
    assert.equal(text.includes("currentMember=yes"), false);
    assert.equal(text.includes("currentDevice=yes"), false);
    assert.ok(text.includes(`Membership events: total=${f.proofCap + 1} unapplied=0`));
    assert.ok(text.includes("Pending membership witness: yes"));
  });
  await test("a key change during proof collection discards the collected details", async (f) => {
    f.populate();
    f.setProofHook(() => f.setKey(ownerKey));
    const text = await f.report();
    assert.ok(text.includes("Membership proof: —"));
    assert.equal(text.includes("Pending membership witness:"), false);
    assert.equal(text.includes("Membership events:"), false);
    assert.ok(text.includes("Generated:"));
  });
  for (const failure of ["failCounts", "failProof"] as const) {
    await test(`${failure} stays best-effort and never leaks an exception`, async (f) => {
      f.populate();
      f[failure]();
      const text = await f.report();
      assert.ok(text.includes("Membership proof: —"));
      assert.ok(text.includes("Generated:"));
      assert.equal(text.includes(secretContent), false);
    });
  }
  await test("no active kaata does not probe another ledger", async (f) => {
    f.populate();
    f.setVault(null);
    const text = await f.report();
    assert.equal(text.includes("Membership proof:"), false);
    assert.equal(text.includes("Membership events:"), false);
  });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
