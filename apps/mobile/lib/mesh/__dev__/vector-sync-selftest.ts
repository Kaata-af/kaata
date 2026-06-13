// Pure protocol-level selftest for the M3.5 author_seq version-vector mesh
// sync. Run from apps/mobile/:
//   bun lib/mesh/__dev__/vector-sync-selftest.ts
//
// The SQL-coupled pieces (computeRelayableVector / fetchNextBatch / mesh
// ingest + slot pre-check) need SQLite and are exercised by the device smoke
// test. But the CORRECTNESS that's actually risky — that the planner
// composition converges two replicas without stranding, heals gaps, and the
// relayable-frontier ceiling keeps a withheld seq from stalling the peer — is
// pure. This models two replicas as held author-seq sets and runs the REAL
// planner functions exactly as anti-entropy.ts composes them
// (computeRelayableVector → computeContiguous, the send plan → planRangesToSend,
// the batched send → splitIntoBatches, in-order delivery → contiguous receive).

import {
  computeContiguous,
  planRangesToSend,
  splitIntoBatches,
  type SeqRange,
  type Vector,
} from "../../replication/planner";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

// A replica = per author device, the set of author_seqs HELD. `withheld` marks
// (device,seq) the replica holds but will NOT relay (the relay filter:
// tombstone / unknown_actor / rejected). Receipt = held; relayable = held - withheld.
type Replica = {
  held: Map<string, Set<number>>;
  withheld: Map<string, Set<number>>;
};

function mkReplica(): Replica {
  return { held: new Map(), withheld: new Map() };
}
function add(r: Replica, device: string, ...seqs: number[]): void {
  let s = r.held.get(device);
  if (!s) {
    s = new Set();
    r.held.set(device, s);
  }
  for (const q of seqs) s.add(q);
}
function withhold(r: Replica, device: string, ...seqs: number[]): void {
  let s = r.withheld.get(device);
  if (!s) {
    s = new Set();
    r.withheld.set(device, s);
  }
  for (const q of seqs) s.add(q);
}
function isRelayable(r: Replica, device: string, seq: number): boolean {
  return (r.held.get(device)?.has(seq) ?? false) && !(r.withheld.get(device)?.has(seq) ?? false);
}

// computeRelayableVector, modeled: per device, computeContiguous over the
// RELAYABLE seqs; omit frontier 0 (exactly anti-entropy.ts).
function relayableVector(r: Replica): Vector {
  const v: Vector = {};
  for (const [device, seqs] of r.held) {
    const relayable = [...seqs].filter((q) => !(r.withheld.get(device)?.has(q) ?? false));
    const frontier = computeContiguous(relayable).frontier;
    if (frontier > 0) v[device] = frontier;
  }
  return v;
}

// One directional transfer: `from` sends `to` exactly the planned ranges, in
// author_seq order, fetching only RELAYABLE rows (mirrors fetchNextBatch). The
// receiver adds them to its held set. batchSize models the wire batching;
// per-author in-order delivery is what keeps the receiver contiguous.
function transfer(from: Replica, to: Replica, batchSize: number): number {
  const ranges = planRangesToSend(relayableVector(from), relayableVector(to));
  const batches = splitIntoBatches(ranges, batchSize);
  let moved = 0;
  for (const batch of batches) {
    for (const r of batch) {
      for (let q = r.from_seq; q <= r.to_seq; q++) {
        // fetchNextBatch only emits relayable rows; a withheld seq ceilings
        // the device stream (stop — don't send above it).
        if (!isRelayable(from, r.device_id, q)) break;
        add(to, r.device_id, q);
        moved++;
      }
    }
  }
  return moved;
}

// Run rounds until neither side moves anything (converged) or a cap.
function syncToFixpoint(a: Replica, b: Replica, batchSize: number, cap = 50): number {
  let rounds = 0;
  for (; rounds < cap; rounds++) {
    const m1 = transfer(a, b, batchSize);
    const m2 = transfer(b, a, batchSize);
    if (m1 === 0 && m2 === 0) break;
  }
  return rounds;
}

function canonical(v: Vector): string {
  return Object.keys(v)
    .sort()
    .map((k) => `${k}:${v[k]}`)
    .join(",");
}
function relayableEqual(a: Replica, b: Replica): boolean {
  return canonical(relayableVector(a)) === canonical(relayableVector(b));
}

console.log("symmetric divergence converges in one fixpoint");
{
  const a = mkReplica();
  const b = mkReplica();
  add(a, "D", 1, 2, 3, 4, 5);
  add(b, "D", 1, 2, 3);
  add(b, "E", 1, 2, 3, 4);
  syncToFixpoint(a, b, 500);
  check("both reach D:5", relayableVector(a).D === 5 && relayableVector(b).D === 5, {
    a: relayableVector(a),
    b: relayableVector(b),
  });
  check("both reach E:4", relayableVector(a).E === 4 && relayableVector(b).E === 4);
  check("vectors identical after sync", relayableEqual(a, b));
}

console.log("fresh receiver pulls a full author stream");
{
  const a = mkReplica();
  const b = mkReplica();
  for (let q = 1; q <= 100; q++) add(a, "D", q);
  syncToFixpoint(a, b, 500);
  check("empty B fully catches up to D:100", relayableVector(b).D === 100);
  check("nothing stranded (vectors equal)", relayableEqual(a, b));
}

console.log("small batches still converge (resumable, in-order)");
{
  const a = mkReplica();
  const b = mkReplica();
  for (let q = 1; q <= 250; q++) add(a, "D", q);
  for (let q = 1; q <= 70; q++) add(b, "E", q);
  const rounds = syncToFixpoint(a, b, 16); // tiny batches → many rounds
  check("converged under tiny batchSize=16", relayableEqual(a, b), {
    a: relayableVector(a),
    b: relayableVector(b),
    rounds,
  });
  check("A learned E:70", relayableVector(a).E === 70);
  check("B learned D:250", relayableVector(b).D === 250);
}

console.log("gap self-heals (receiver holds above a hole)");
{
  const a = mkReplica();
  const b = mkReplica();
  add(a, "D", 1, 2, 3, 4, 5, 6, 7, 8);
  // B got 6,7,8 from some other relay before 4,5 — a hole. Its relayable
  // frontier is 3, so it advertises 3 and A re-sends from 4.
  add(b, "D", 1, 2, 3, 6, 7, 8);
  check("B starts with frontier 3 (hole at 4-5)", relayableVector(b).D === 3);
  transfer(a, b, 500); // A → B: sends 4..8
  check("B frontier heals to 8 after one transfer", relayableVector(b).D === 8, {
    b: relayableVector(b),
  });
}

console.log("tombstone ceiling (rare): a withheld bad-sig seq stops the stream, no hole at peer");
{
  // `withheld` models ONLY tombstone/rejected (the M3.5-review relay filter:
  // quarantined rows are FORWARDED, only tombstone/rejected are withheld).
  const a = mkReplica();
  const b = mkReplica();
  add(a, "D", 1, 2, 3, 4, 5);
  withhold(a, "D", 3); // a bad-sig tombstone at seq 3 (rare; accepted)
  check("A relayable frontier ceilings at 2", relayableVector(a).D === 2);
  syncToFixpoint(a, b, 500);
  // B gets a contiguous 1-2 (NO hole); 4,5 strand behind the tombstoned 3.
  // The peer's frontier never stalls on a seq A refuses to send.
  check("B receives contiguous D:1-2 only", relayableVector(b).D === 2, { b: relayableVector(b) });
  check(
    "B has no event at seq 4 (stranded above the ceiling)",
    !(b.held.get("D")?.has(4) ?? false),
  );
}

console.log(
  "FORWARD QUARANTINE (review fix): a relayable event above a quarantine hole is NOT stranded",
);
{
  // The OLD design withheld unknown_actor and assumed it was an all-or-nothing
  // SUFFIX — false. Quarantine is per-event: a device removed at HLC(seq 5)
  // quarantines its post-removal entry_created at 6,7, but a role-'none'
  // account_bound at seq 8 still applies → relayable, sitting ABOVE the
  // quarantine hole. The fix FORWARDS quarantined rows, so they are NOT
  // withheld here (only tombstone/rejected are), the seq space stays
  // contiguous, and seq 8 reaches the peer. (Under the old all-or-nothing
  // withholding, A's frontier would ceiling at 5 and seq 8 would strand.)
  const a = mkReplica();
  const b = mkReplica();
  add(a, "D", 1, 2, 3, 4, 5, 6, 7, 8); // 6,7 quarantined-but-forwarded; 8 relayable
  check("A advertises full frontier 8 (quarantine doesn't ceiling)", relayableVector(a).D === 8);
  syncToFixpoint(a, b, 500);
  check("B receives the relayable event at seq 8", b.held.get("D")?.has(8) ?? false, {
    b: relayableVector(b),
  });
  check("no stranding (vectors equal)", relayableEqual(a, b));
}

console.log("planRangesToSend asymmetry: only the ahead side sends");
{
  const local: Vector = { D: 10, E: 4 };
  const peer: Vector = { D: 7, E: 4, F: 3 };
  const ranges = planRangesToSend(local, peer);
  // D: local 10 > peer 7 → [8..10]. E: equal → nothing. F: peer-only → nothing.
  check(
    "only D:[8..10] is planned",
    ranges.length === 1 &&
      ranges[0].device_id === "D" &&
      ranges[0].from_seq === 8 &&
      ranges[0].to_seq === 10,
    ranges,
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall vector-sync selftests passed");
