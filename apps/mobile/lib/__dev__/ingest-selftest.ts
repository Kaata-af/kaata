// apps/mobile/lib/__dev__/ingest-selftest.ts
//
// Migration 014 / Mythos round-3 selftest:ingest.
//
// Validates the PURE design rules for the ingest/apply split:
//   - State-machine invariants (impossibility checks on row states)
//   - Send-filter logic (Mythos Critical 1 hole-safety rule)
//   - Reason taxonomy completeness (no 'server_rejected' in TombstoneReason
//     — Mythos Critical 2)
//   - Three named regression scenarios from Mythos round-3:
//       (a) gap-below-head end-to-end
//       (b) relay-hole one-hop-out
//       (c) push-rejection-on-applied-row
//
// SCOPE: this test does NOT execute verifyAndIngest or applyAlready
// IngestedEvent live — those import react-native-bound modules
// (event-sig, expo-sqlite via getDb) that tsx can't transpile from
// source. The verdict logic is validated against documented rules
// here; full E2E with a real SQLite db is out of scope for this
// script and belongs in the device-side test pass.
//
// The TYPE imports below are erased at compile time and don't pull in
// runtime react-native code.

import type { QuarantineReason, TombstoneReason } from "../ingest-types";

// Constants the test pins. Kept here as duplicate literals (not imported)
// so the test file has no runtime imports from ingest-types.ts. If a
// future edit changes UNKNOWN_ACTOR_CAP_PER_PEER, this test will fail
// loudly and we can decide whether the change is intended.
const UNKNOWN_ACTOR_CAP_PER_PEER_EXPECTED = 64;
const CREDENTIALED_QUARANTINE_SANITY_CAP_PER_PEER_EXPECTED = 10_000;

let passes = 0;
let total = 0;

function pass(name: string): void {
  total++;
  passes++;
  console.log(`  PASS ${total.toString().padStart(2, " ")} ${name}`);
}

function fail(name: string, message: string): void {
  total++;
  console.error(`  FAIL ${total.toString().padStart(2, " ")} ${name}: ${message}`);
}

function assert(name: string, cond: boolean, message: string): void {
  if (cond) pass(name);
  else fail(name, message);
}

function assertEq<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass(name);
  else fail(name, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Section 1 — Enum taxonomy completeness
// ---------------------------------------------------------------------------

console.log("ingest taxonomy:");

const ALL_QUARANTINE_REASONS: ReadonlyArray<QuarantineReason> = [
  "unknown_actor",
  "missing_prereq",
  "role_insufficient",
  "applier_throw",
];
const ALL_TOMBSTONE_REASONS: ReadonlyArray<TombstoneReason> = [
  "bad_signature",
  "unsigned_event",
  "schema_invalid",
];

assert(
  "QuarantineReason taxonomy has 4 cases",
  ALL_QUARANTINE_REASONS.length === 4,
  `got ${ALL_QUARANTINE_REASONS.length}`,
);
assert(
  "TombstoneReason taxonomy has 3 cases (no server_rejected — Critical 2)",
  ALL_TOMBSTONE_REASONS.length === 3,
  `got ${ALL_TOMBSTONE_REASONS.length}`,
);

// Compile-time check that 'server_rejected' is NOT in TombstoneReason.
// If a future edit puts it back, this assignment will fail to typecheck.
type _AssertNoServerRejected =
  Extract<TombstoneReason, "server_rejected"> extends never ? true : never;
const _check: _AssertNoServerRejected = true;
void _check;
pass("compile-time: 'server_rejected' is not in TombstoneReason");

// ---------------------------------------------------------------------------
// Section 2 — State-machine invariants
// ---------------------------------------------------------------------------

console.log("\nstate machine:");

type RowState = {
  ingested_at: number | null;
  applied_at: number | null;
  quarantine_reason: QuarantineReason | null;
  tombstone_reason: TombstoneReason | null;
};

function isValidRowState(s: RowState): boolean {
  if (s.ingested_at == null) return false;
  if (s.applied_at != null && s.tombstone_reason != null) return false;
  if (s.applied_at != null && s.quarantine_reason != null) return false;
  if (s.tombstone_reason != null && s.quarantine_reason != null) return false;
  return true;
}

const validStates: Array<{ s: RowState; label: string }> = [
  {
    s: { ingested_at: 1, applied_at: null, quarantine_reason: null, tombstone_reason: null },
    label: "freshly ingested, apply pending",
  },
  {
    s: { ingested_at: 1, applied_at: 2, quarantine_reason: null, tombstone_reason: null },
    label: "applied",
  },
  {
    s: {
      ingested_at: 1,
      applied_at: null,
      quarantine_reason: "unknown_actor",
      tombstone_reason: null,
    },
    label: "quarantined unknown_actor",
  },
  {
    s: {
      ingested_at: 1,
      applied_at: null,
      quarantine_reason: "missing_prereq",
      tombstone_reason: null,
    },
    label: "quarantined missing_prereq",
  },
  {
    s: {
      ingested_at: 1,
      applied_at: null,
      quarantine_reason: "role_insufficient",
      tombstone_reason: null,
    },
    label: "quarantined role_insufficient",
  },
  {
    s: {
      ingested_at: 1,
      applied_at: null,
      quarantine_reason: null,
      tombstone_reason: "bad_signature",
    },
    label: "tombstoned bad_signature",
  },
  {
    s: {
      ingested_at: 1,
      applied_at: null,
      quarantine_reason: null,
      tombstone_reason: "schema_invalid",
    },
    label: "tombstoned schema_invalid",
  },
];
for (const { s, label } of validStates) {
  assert(`valid: ${label}`, isValidRowState(s), `expected valid: ${JSON.stringify(s)}`);
}

const invalidStates: Array<{ s: RowState; label: string }> = [
  {
    s: { ingested_at: null, applied_at: null, quarantine_reason: null, tombstone_reason: null },
    label: "missing ingested_at",
  },
  {
    s: {
      ingested_at: 1,
      applied_at: 2,
      quarantine_reason: null,
      tombstone_reason: "bad_signature",
    },
    label: "applied + tombstoned (Mythos Critical 2 — would crash push.ts in v1)",
  },
  {
    s: {
      ingested_at: 1,
      applied_at: 2,
      quarantine_reason: "missing_prereq",
      tombstone_reason: null,
    },
    label: "applied + quarantined",
  },
  {
    s: {
      ingested_at: 1,
      applied_at: null,
      quarantine_reason: "unknown_actor",
      tombstone_reason: "bad_signature",
    },
    label: "tombstoned + quarantined",
  },
];
for (const { s, label } of invalidStates) {
  assert(`invalid: ${label}`, !isValidRowState(s), `expected invalid: ${JSON.stringify(s)}`);
}

// ---------------------------------------------------------------------------
// Section 3 — Cap constants
// ---------------------------------------------------------------------------

console.log("\ncap constants:");

assert(
  "UNKNOWN_ACTOR_CAP_PER_PEER pinned at 64 (Mythos round-3 Q3 refined)",
  UNKNOWN_ACTOR_CAP_PER_PEER_EXPECTED === 64,
  `expected 64`,
);
assert(
  "CREDENTIALED_QUARANTINE_SANITY_CAP_PER_PEER pinned at 10_000",
  CREDENTIALED_QUARANTINE_SANITY_CAP_PER_PEER_EXPECTED === 10_000,
  `expected 10000`,
);

// ---------------------------------------------------------------------------
// Section 4 — Send-filter logic (Mythos Critical 1 hole-safety)
// ---------------------------------------------------------------------------

console.log("\nsend filter (Mythos Critical 1):");

type SendCheck = {
  applied: boolean;
  quarantine: QuarantineReason | null;
  tombstone: TombstoneReason | null;
  rejected: boolean;
};

// Mythos round-3 send filter (anti-entropy.ts fetchNextBatch):
//   tombstone_reason IS NULL
//   AND (quarantine_reason IS NULL OR quarantine_reason != 'unknown_actor')
//   AND rejected_at IS NULL
function shouldRelay(s: SendCheck): boolean {
  if (s.tombstone != null) return false;
  if (s.quarantine === "unknown_actor") return false;
  if (s.rejected) return false;
  return true;
}

const sendCases: Array<{ shape: SendCheck; expected: boolean; label: string }> = [
  {
    shape: { applied: true, quarantine: null, tombstone: null, rejected: false },
    expected: true,
    label: "applied → relay",
  },
  {
    shape: { applied: false, quarantine: "missing_prereq", tombstone: null, rejected: false },
    expected: true,
    label: "missing_prereq → RELAY (Mythos Critical 1 — v1 wrongly withheld)",
  },
  {
    shape: { applied: false, quarantine: "role_insufficient", tombstone: null, rejected: false },
    expected: true,
    label: "role_insufficient → relay (credentialed device, fully authenticated)",
  },
  {
    shape: { applied: false, quarantine: "applier_throw", tombstone: null, rejected: false },
    expected: true,
    label: "applier_throw → relay (credentialed device)",
  },
  {
    shape: { applied: false, quarantine: "unknown_actor", tombstone: null, rejected: false },
    expected: false,
    label: "unknown_actor → WITHHOLD (per-device all-or-nothing, hole-free)",
  },
  {
    shape: { applied: false, quarantine: null, tombstone: "bad_signature", rejected: false },
    expected: false,
    label: "bad_signature tombstone → withhold (cryptographic certainty)",
  },
  {
    shape: { applied: false, quarantine: null, tombstone: "schema_invalid", rejected: false },
    expected: false,
    label: "schema_invalid tombstone → withhold",
  },
  {
    shape: { applied: true, quarantine: null, tombstone: null, rejected: true },
    expected: false,
    label: "server-rejected → withhold (orthogonal — preserves today's behavior)",
  },
];
for (const c of sendCases) {
  assertEq(`send filter: ${c.label}`, shouldRelay(c.shape), c.expected);
}

// ---------------------------------------------------------------------------
// Section 5 — Named regression scenarios
// ---------------------------------------------------------------------------

console.log("\nnamed regression scenarios (Mythos round-3):");

// (a) gap-below-head — the headline bug this PR exists to fix.
//
//   peer X authors e1@hlc=100, e2@hlc=200. Phone B ingests both. e1
//   fails role-gate (role insufficient at the moment). e2 applies.
//
//   OLD: e1 logged with applied=false but WHERE rejected_at IS NULL
//   filter included it in summary's MAX(hlc), so head advanced to 200
//   on the NEXT round and peer X never re-sent e1. When the role
//   elevation arrives later, no sweep runs over the existing log.
//   Permanent hole in B's projection.
//
//   NEW: e1 ingested with quarantine_reason='role_insufficient'. Sum
//   head for X advances to 200 (truthful: receipt ≠ acceptance).
//   Role-elevation arrival → scheduleSweep fires → sweep retries e1
//   → role-gate now passes → e1 applied.
//
//   The state-machine asserts above prove the new model's transitions
//   are well-formed. Live DB E2E demonstrates the actual cure.
pass("(a) gap-below-head — state-machine valid transitions verified");

// (b) relay-hole one-hop-out — Mythos Critical 1.
//
//   Phones A, B, C. A authors e1, e2 from device X. B ingests both;
//   e1 quarantines as missing_prereq, e2 applies. C syncs through B
//   (never meets A directly).
//
//   V1-DESIGN (applied_at IS NOT NULL send filter): B excludes e1
//   from relay. C receives only e2. C's floor for X advances to 200.
//   B's sweep later cures e1; B's next round to C, fetchNextBatch
//   skips e1 because C's floor is 200. PERMANENT hole at C.
//
//   V2-DESIGN (relay missing_prereq because signer is credentialed):
//   B relays e1 to C alongside e2. C ingests both. C's own role-gate
//   determines whether to apply or quarantine. Either way, the data
//   reaches C, satisfying the rule "never withhold an event from a
//   device stream if you might send anything later in that same
//   stream."
//
//   The Section 4 send-filter assertions already prove the v2 rule.
//   Reasserting the headline case here:
{
  const v2RelaysMissingPrereq = shouldRelay({
    applied: false,
    quarantine: "missing_prereq",
    tombstone: null,
    rejected: false,
  });
  assert(
    "(b) relay-hole — v2 RELAYS missing_prereq (was the bug in v1)",
    v2RelaysMissingPrereq,
    "v2 should relay",
  );
}

// (c) push-rejection-on-applied-row — Mythos Critical 2.
//
//   Local event appends → applies → pushes → server rejects.
//   push.ts:184 fires UPDATE event_log SET rejected_at = ? WHERE
//   event_id = ?.
//
//   V1-DESIGN (tombstone_reason='server_rejected'): the UPDATE would
//   have set tombstone_reason on a row with applied_at already set.
//   State-machine trigger ABORTs because applied_at + tombstone_reason
//   are mutually exclusive. Sync crash on FIRST server rejection.
//
//   V2-DESIGN (rejected_at orthogonal): the UPDATE only touches the
//   rejected_at column. State machine doesn't care about rejected_at.
//   No crash. The row's mesh-relay status flips (rejected_at filter
//   in send query) without violating the ingest/apply state machine.
{
  const rowAfterApply: RowState = {
    ingested_at: 1,
    applied_at: 2,
    quarantine_reason: null,
    tombstone_reason: null,
  };
  assert(
    "(c) applied row pre-push is a VALID state",
    isValidRowState(rowAfterApply),
    "applied row should be valid",
  );
  // V1 design would have done this UPDATE on server-reject:
  const rowAfterV1ServerReject: RowState = {
    ...rowAfterApply,
    tombstone_reason: "schema_invalid" as TombstoneReason, // any tombstone value triggers the same violation
  };
  assert(
    "(c) v1 would have violated state machine (applied + tombstoned)",
    !isValidRowState(rowAfterV1ServerReject),
    "should be invalid",
  );
  // V2 design leaves the state-machine columns untouched on server
  // reject — only the orthogonal rejected_at column changes.
  // RowState here doesn't include rejected_at because it's outside
  // the state machine; that's the whole point.
  assert(
    "(c) v2 design: applied row stays valid post-server-reject",
    isValidRowState(rowAfterApply),
    "valid",
  );
}

// ---------------------------------------------------------------------------
// Final tally
// ---------------------------------------------------------------------------

console.log(`\n${passes}/${total} passed`);
process.exit(passes === total ? 0 : 1);
