# Pre-commit checkpoint — judgment calls I made during implementation

All 7 commits' worth of code is written and tests pass (29/29 in
selftest:ingest, 13/13 in selftest:hlc, tsc clean). About to squash
into one commit to main and merge after the crash-evidence-protocol
data lands.

Three things I want your eyes on before I push — two are design
judgment calls I made unilaterally that you haven't seen, one is a
transparency note on test scope.

## 1. Commit 6 became Option B, not Option A — please sanity-check my reasoning

You proposed a one-time **full** re-apply sweep over every
non-tombstoned row, with the argument that idempotent appliers cure
any backfill misclassification.

I narrowed it to **only quarantined rows** based on this reasoning:

The old `applyEvent` at `projection/index.ts:197` wraps the INSERT,
the role-gate check, AND the applier dispatch in ONE
`withTransactionAsync`. If the applier throws, the entire transaction
rolls back including the INSERT. So under the old code:

- Applier throws → no row on disk.
- Role-gate refuses → row on disk with applied=false, audit row in
  `projection_conflicts` with kind='event_rejected_by_local_role_gate'.
- Apply succeeds → row on disk, projection updated.

Therefore the misclassified-as-applied case ("backfilled as applied
but projection effects missing") that motivated your full re-apply
**cannot exist on disk under the old code**. Backfill step 2c
("everything else applied") is correct by construction. The
re-apply pass only needs to handle rows the backfill placed in
quarantine (step 2b — role-gate refused).

So commit 6 just queries for vaults with at least one
`quarantine_reason IS NOT NULL` row and calls `scheduleSweep` for
each. Live install with no quarantined rows: complete no-op.

**Question:** is my reasoning correct? Specifically — are there code
paths that mutate event_log AFTER the applyEvent transaction commits
but BEFORE we'd say "successfully applied"? I checked the appliers
and they all run inside the same withTransactionAsync. I'm fairly
confident but I haven't grep'd every codepath.

If my reasoning is wrong, the fix is one line — change the WHERE
clause to drop `quarantine_reason IS NOT NULL` and let the sweep
re-process every non-tombstoned row in the vault. Cheap to add.

## 2. `classifyApplierThrow` uses string matching

In `apps/mobile/lib/projection/replay.ts` I added:

```typescript
function classifyApplierThrow(err: unknown): ApplyAlreadyIngestedVerdict {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes("not found") ||
    lower.includes("does not exist") ||
    lower.includes("missing") ||
    lower.includes("no such") ||
    lower.includes("foreign key")
  ) {
    return { kind: "quarantined", reason: "missing_prereq" };
  }
  if (
    lower.includes("invalid") ||
    lower.includes("malformed") ||
    lower.includes("unexpected") ||
    lower.includes("schema")
  ) {
    return { kind: "tombstoned", reason: "schema_invalid" };
  }
  return { kind: "quarantined", reason: "applier_throw" };
}
```

This is brittle. A future applier whose error message happens to
contain "invalid" tombstones a row that should have been retried.
Or vice versa.

The structural fix is a typed-error refactor of every applier — they
throw `class MissingPrereqError extends Error`, `class SchemaInvalidError
extends Error`, etc. Maybe 12 appliers × 30 min each = a full day,
and it would touch every projection file.

For now I biased to quarantine on ambiguity, which is the safe
direction per your earlier guidance ("wrongly tombstoning loses
data; wrongly quarantining costs a retry"). Worst case a
schema-invalid row keeps retrying every sweep until a human notices
the log spam.

**Question:** ship with the string match, deferred typed-error
refactor as a follow-up? Or do you want the typed-error work done
in this PR before merge?

## 3. selftest:ingest is pure-logic only — not live SQLite

You named three regression tests:

- (a) gap-below-head end-to-end
- (b) relay-hole one-hop-out — fails against v1 filter, passes against v2
- (c) push-rejection-on-applied-row — crashes under v1, no-op under v2

What I shipped: 29 pure-logic assertions that validate the SAME
rules these tests would exercise — state-machine invariants,
send-filter logic per shape, taxonomy completeness, valid/invalid
state transitions for (a) (b) (c). Output:

```
ingest taxonomy: 3 PASS
state machine: 11 PASS (4 valid + 7 invalid states)
cap constants: 2 PASS
send filter (Critical 1): 8 PASS
named regression scenarios (Mythos round-3):
  PASS 25 (a) gap-below-head — state-machine valid transitions verified
  PASS 26 (b) relay-hole — v2 RELAYS missing_prereq (was the bug in v1)
  PASS 27 (c) applied row pre-push is a VALID state
  PASS 28 (c) v1 would have violated state machine (applied + tombstoned)
  PASS 29 (c) v2 design: applied row stays valid post-server-reject
29/29 passed
```

What's NOT covered: end-to-end behavior with a live SQLite database
(events ingested → sweep fires → projection updates). The
infrastructure cost was the blocker — `expo-sqlite` is a native
module that `tsx` can't transpile from source. Setting up a JSI
mock or running the test suite under `expo-cli`'s simulator would
work but is significantly more harness work than the PR itself.

The PR's correctness rests on:

1. The selftest's pure-logic assertions catching design-rule violations.
2. The state-machine triggers in SQLite catching ANY runtime row
   state violation as an ABORT — so a code-path bug shows up
   immediately, not silently.
3. The two-phone field test after the crash evidence protocol
   completes, which is the actual end-to-end pass.

**Question:** accept this test scope and rely on the field test for
E2E, or do you want me to set up a live-SQLite test harness before
merge?

## Hard constraint reminder

I am NOT committing until you confirm — and we still merge after
the crash evidence lands on the frozen P1–P4 APK, not before. The
discipline gate stands.

If the answer to all three questions is "ship it," I'll squash into
one commit to main with the message:

```
Mesh data-loss fix: ingest/apply split (migration 014)

Splits event_log state into explicit ingest_at / applied_at /
quarantine_reason / tombstone_reason columns. Solves Mythos round-2
gap-below-head: events refused by role-gate were never retried and
the summary's rejected_at filter advanced the head past them. New
shape: receipt ≠ acceptance; heads cover all ingested rows; sweep
retries quarantined rows on credential/role/prereq arrivals;
tombstones never relay.

Critical 1 (Mythos round-3): relay filter is per-device all-or-
nothing for unknown_actor; missing_prereq/role_insufficient/
applier_throw rows DO relay (credentialed signer, downstream may
apply what we can't). Closes the one-hop-out hole.

Critical 2: rejected_at stays orthogonal — never enters the mesh
state machine. push.ts:184 server-rejection lifecycle preserved.

Plus: ingest-time signature verification (verifyAndIngest),
applyAlreadyIngestedEvent replay path that doesn't double-write to
projection_conflicts, per-vault debounced sweep, Mutex utility,
state-machine triggers (enum membership in triggers not column
CHECKs for future evolvability), one-time re-apply sweep at migration
finish, audits (push.ts tombstone filter, fetchNextBatch JSON.parse
loud-log), selftest:ingest 29 PASS pure-logic regressions.

Merge after crash-evidence-protocol data lands on the frozen P1-P4 APK.
```

Send corrections, additions, or the green light.
