// Execute the real readiness helper with controlled proof/key IO. Real
// Ed25519 and chain authorization are exercised by ownership-proof tests.
import assert from "node:assert/strict";
import { compileUI } from "./ui-fixture";
import type { MembershipState } from "../trust/chain";

const book = "kaata",
  owner = "owner",
  target = "recipient",
  install = "phone";
function state(
  pubkey: string,
  options: {
    genesis?: boolean;
    sourceRole?: "owner" | "editor";
    memberRemoved?: boolean;
    deviceRemoved?: boolean;
    deviceId?: string;
    targetMissing?: boolean;
    targetRemoved?: boolean;
  } = {},
): MembershipState {
  return {
    hasGenesis: options.genesis ?? true,
    members: new Map([
      [
        owner,
        {
          account_id: owner,
          role: options.sourceRole ?? "owner",
          removed: options.memberRemoved ?? false,
        },
      ],
      ...(!options.targetMissing
        ? [
            [
              target,
              { account_id: target, role: "editor", removed: options.targetRemoved ?? false },
            ] as const,
          ]
        : []),
    ]),
    devices: new Map([
      [
        pubkey,
        {
          device_pubkey: pubkey,
          device_id: options.deviceId ?? install,
          account_id: owner,
          removed: options.deviceRemoved ?? false,
        },
      ],
    ]),
    conflicts: [],
  };
}
function fixture(
  options: {
    signer?: string;
    anchor?: string;
    local?: MembershipState | null;
    published?: MembershipState | null;
  } = {},
) {
  let signer = options.signer ?? "anchor";
  const anchor = options.anchor ?? "anchor";
  let local = options.local === undefined ? state(signer) : options.local;
  let published = options.published === undefined ? local : options.published;
  let backfills = 0,
    signerReads = 0;
  const proofReads: boolean[] = [];
  let onBackfill: (() => void | Promise<void>) | undefined;
  let onProof: ((publishedOnly: boolean) => void) | undefined;
  const helper = compileUI("../ownership-transfer-readiness", {
    "./db-tx": {
      getInstallIdSync: () => install,
      getDb: async () => ({
        getFirstAsync: async (_: string, id: string) => {
          assert.equal(id, book);
          return { vault_trust_anchor_pubkey: anchor };
        },
      }),
    },
    "./mesh/device-key": {
      getDeviceSigner: async (opts: { interactive: boolean }) => {
        assert.equal(opts.interactive, true, "the first signer read may repair a foreground key");
        signerReads++;
        return { pubkey_b64: signer };
      },
    },
    "./trust/backfill": {
      ensureChainBackfill: async (id: string) => {
        assert.equal(id, book);
        backfills++;
        await onBackfill?.();
      },
    },
    "./trust/proof": {
      getLocalMembershipState: async (id: string, publishedOnly = false) => {
        assert.equal(id, book);
        proofReads.push(publishedOnly);
        const result = publishedOnly ? published : local;
        onProof?.(publishedOnly);
        return result;
      },
    },
  });
  return {
    ready: () => helper.ensureOwnershipTransferSignerReady(book, target) as Promise<string>,
    Error: helper.OwnershipSignerNotReadyError,
    get backfills() {
      return backfills;
    },
    get signerReads() {
      return signerReads;
    },
    proofReads,
    setSigner: (value: string) => {
      signer = value;
    },
    setLocal: (value: MembershipState | null) => {
      local = value;
    },
    setPublished: (value: MembershipState | null) => {
      published = value;
    },
    onBackfill: (fn: () => void | Promise<void>) => {
      onBackfill = fn;
    },
    onProof: (fn: (publishedOnly: boolean) => void) => {
      onProof = fn;
    },
  };
}
async function run() {
  const anchor = fixture({ published: null });
  assert.equal(await anchor.ready(), "anchor");
  assert.equal(anchor.backfills, 0, "a verified exact-anchor handover works offline");
  assert.deepEqual(anchor.proofReads, [false], "anchor readiness uses its verified local chain");
  const survivingAnchor = fixture({
    local: state("anchor", { deviceId: "before-reinstall" }),
    published: null,
  });
  assert.equal(await survivingAnchor.ready(), "anchor");
  assert.equal(
    survivingAnchor.backfills,
    0,
    "a surviving exact root key remains valid offline after reinstall",
  );
  const admitted = fixture({ signer: "bound-owner" });
  assert.equal(await admitted.ready(), "bound-owner");
  assert.equal(admitted.backfills, 0, "an already-published Owner device needs no network repair");
  assert.deepEqual(admitted.proofReads, [false, true]);
  for (const [name, options] of [
    [
      "rotated key has only the retired anchor's binding",
      { signer: "rotated", local: state("anchor"), published: state("anchor") },
    ],
    [
      "unpublished Owner/device proof",
      { signer: "rotated", local: state("rotated"), published: null },
    ],
    [
      "rejected Owner/device proof",
      { signer: "rotated", local: state("rotated"), published: state("anchor") },
    ],
    [
      "removed device",
      {
        signer: "bound",
        local: state("bound"),
        published: state("bound", { deviceRemoved: true }),
      },
    ],
    [
      "removed Owner",
      {
        signer: "bound",
        local: state("bound"),
        published: state("bound", { memberRemoved: true }),
      },
    ],
    [
      "Editor signer",
      {
        signer: "bound",
        local: state("bound"),
        published: state("bound", { sourceRole: "editor" }),
      },
    ],
    [
      "wrong install id",
      {
        signer: "bound",
        local: state("bound"),
        published: state("bound", { deviceId: "other-phone" }),
      },
    ],
    ["missing local genesis", { local: state("anchor", { genesis: false }) }],
    [
      "target exists only in a visibility mirror",
      { local: state("anchor", { targetMissing: true }) },
    ],
    ["revoked target", { local: state("anchor", { targetRemoved: true }) }],
    ["former anchor is an Editor", { local: state("anchor", { sourceRole: "editor" }) }],
  ] as const) {
    const f = fixture(options);
    await assert.rejects(f.ready(), f.Error, name);
    assert.equal(f.backfills, 1, name + " gets one bounded repair attempt");
  }
  console.log(
    "PASS ownership readiness: verified offline anchor/published Owner and refused rotated/unpublished/rejected/removed/Editor/wrong-install/unknown-target authority",
  );

  const repaired = fixture({
    signer: "rotated",
    local: state("anchor"),
    published: state("anchor"),
  });
  repaired.onBackfill(() => {
    repaired.setLocal(state("rotated"));
    repaired.setPublished(state("rotated"));
  });
  assert.equal(await repaired.ready(), "rotated");
  assert.equal(repaired.backfills, 1);
  const targetRepair = fixture({
    local: state("anchor", { targetMissing: true }),
    published: null,
  });
  targetRepair.onBackfill(() => {
    targetRepair.setLocal(state("anchor"));
  });
  assert.equal(
    await targetRepair.ready(),
    "anchor",
    "owner backfill admits an existing target before transferring",
  );
  const thrownRepair = fixture({ signer: "bound", published: null });
  thrownRepair.onBackfill(() => {
    thrownRepair.setPublished(state("bound"));
    throw new Error("a concurrent repair finished while this one failed");
  });
  assert.equal(await thrownRepair.ready(), "bound");
  console.log(
    "PASS ownership readiness: backfill repairs signer or target and rechecks proof even after a competing repair error",
  );

  const changed = fixture({ signer: "bound-first" });
  let changedOnce = false;
  changed.onProof((publishedOnly) => {
    if (publishedOnly && !changedOnce) {
      changedOnce = true;
      changed.setSigner("bound-second");
    }
  });
  changed.onBackfill(() => {
    changed.setLocal(state("bound-second"));
    changed.setPublished(state("bound-second"));
  });
  assert.equal(
    await changed.ready(),
    "bound-second",
    "a changed key never returns the earlier ready pubkey",
  );
  const stillChanging = fixture({ signer: "bound-first" });
  let changes = 0;
  stillChanging.onProof((publishedOnly) => {
    if (publishedOnly) stillChanging.setSigner("changed-" + ++changes);
  });
  await assert.rejects(stillChanging.ready(), stillChanging.Error);
  const repairedAtStart = fixture({
    signer: "new-key",
    local: state("anchor"),
    published: state("anchor"),
  });
  await assert.rejects(
    repairedAtStart.ready(),
    repairedAtStart.Error,
    "post-repair signer does not inherit a retired root key's authority",
  );
  console.log(
    "PASS ownership readiness: signer snapshots stay current through proof awaits, repairs and further key changes",
  );
}
void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
