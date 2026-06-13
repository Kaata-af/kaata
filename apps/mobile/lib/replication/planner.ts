// Sync v2 replication planner — PURE functions only (no SQLite, no RN, no
// network). This is the transport-agnostic heart of the v2 sync engine
// (docs/sync-v2-architecture.md §5): replicas describe what they hold as a
// per-author version vector and exchange exactly the missing ranges.
//
// M1 ships the engine with the server channel as its first consumer in an
// ADVISORY role (the per-row outbox flags stay the push truth — see
// server-vector.ts). M3/M4 (LAN/BLE) make these plans the source of truth.
//
// Purity matters: this module is exercised by lib/replication/__dev__/
// planner-selftest.ts under plain `bun`, with no device or emulator.

/** device_id → highest CONTIGUOUS author_seq held (0 = nothing held). */
export type Vector = Record<string, number>;

/** Aggregate a peer reports per device (the /v1/sync/vector shape). */
export type PeerVectorEntry = {
  max_seq: number;
  count: number;
  min_seq: number;
};
export type PeerVector = Record<string, PeerVectorEntry>;

/** Inclusive range of one author's events to transfer. */
export type SeqRange = {
  device_id: string;
  from_seq: number;
  to_seq: number;
};

/**
 * The contiguous frontier provable from a {min,count,max} aggregate alone:
 * exactly when the seqs are 1..max with no holes. Anything else returns 0 —
 * the aggregate can't prove which prefix is present, so the only safe claim
 * is "nothing provable".
 */
export function provableFrontier(entry: PeerVectorEntry): number {
  if (entry.min_seq === 1 && entry.count === entry.max_seq && entry.max_seq >= 1) {
    return entry.max_seq;
  }
  return 0;
}

/**
 * Collapse a peer's aggregate vector to a conservative Vector (provable
 * frontiers only). Used when planning against /v1/sync/vector responses.
 */
export function toConservativeVector(peer: PeerVector): Vector {
  const v: Vector = {};
  for (const [device, entry] of Object.entries(peer)) {
    v[device] = provableFrontier(entry);
  }
  return v;
}

/**
 * Walk a sorted-or-unsorted list of held seqs for ONE author and report the
 * contiguous frontier (highest n such that 1..n are all present) plus any
 * gaps above it. Duplicates are tolerated (idempotent ingest can produce
 * none in practice — the UNIQUE index forbids them — but the planner stays
 * total over arbitrary input).
 */
export function computeContiguous(seqs: number[]): {
  frontier: number;
  gaps: Array<{ from_seq: number; to_seq: number }>;
} {
  // Defined over positive integers only — out-of-domain values (0,
  // negatives, fractions) from a hostile or buggy peer are discarded
  // rather than silently corrupting the frontier/gap math.
  const valid = seqs.filter((s) => Number.isInteger(s) && s >= 1);
  if (valid.length === 0) return { frontier: 0, gaps: [] };
  const sorted = [...new Set(valid)].sort((a, b) => a - b);
  let frontier = 0;
  let i = 0;
  while (i < sorted.length && sorted[i] === frontier + 1) {
    frontier = sorted[i];
    i++;
  }
  const gaps: Array<{ from_seq: number; to_seq: number }> = [];
  let prev = frontier;
  for (; i < sorted.length; i++) {
    const s = sorted[i];
    if (s > prev + 1) {
      gaps.push({ from_seq: prev + 1, to_seq: s - 1 });
    }
    prev = s;
  }
  return { frontier, gaps };
}

/**
 * Plan what WE should send a peer: for every author where our held frontier
 * exceeds the peer's, the inclusive range (peer_frontier+1 .. our_frontier).
 * Authors the peer knows that we don't contribute nothing (they're the
 * peer's job to send us). Ranges are deterministic (sorted by device_id) so
 * both sides of a symmetric exchange produce stable, comparable plans.
 */
export function planRangesToSend(local: Vector, peer: Vector): SeqRange[] {
  const ranges: SeqRange[] = [];
  for (const device of Object.keys(local).sort()) {
    const have = local[device] ?? 0;
    const theirs = peer[device] ?? 0;
    if (have > theirs) {
      ranges.push({ device_id: device, from_seq: theirs + 1, to_seq: have });
    }
  }
  return ranges;
}

/**
 * Split planned ranges into transfer batches of at most `batchSize` events,
 * preserving per-author order (a batch may span authors). Per-author
 * in-order delivery is what keeps the receiver's frontier advancing
 * contiguously — a dropped connection then costs exactly nothing.
 */
export function splitIntoBatches(ranges: SeqRange[], batchSize: number): SeqRange[][] {
  if (batchSize < 1) throw new Error(`batchSize must be >= 1, got ${batchSize}`);
  const batches: SeqRange[][] = [];
  let current: SeqRange[] = [];
  let currentCount = 0;

  for (const r of ranges) {
    let from = r.from_seq;
    while (from <= r.to_seq) {
      const room = batchSize - currentCount;
      const take = Math.min(room, r.to_seq - from + 1);
      current.push({ device_id: r.device_id, from_seq: from, to_seq: from + take - 1 });
      currentCount += take;
      from += take;
      if (currentCount === batchSize) {
        batches.push(current);
        current = [];
        currentCount = 0;
      }
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Divergence report between our local vector and a peer's aggregate —
 * the M1 observability surface (logged after server sync; see
 * server-vector.ts). `localAhead` is normal (unpushed outbox); `peerAhead`
 * after a completed pull means the pull path missed something and is worth
 * a warning; `unprovable` lists authors whose server aggregate can't prove
 * a contiguous prefix (legacy NULL-seq rows or relay gaps — expected during
 * the M1→M3 transition window).
 */
export function diffVectors(
  local: Vector,
  peer: PeerVector,
): {
  localAhead: SeqRange[];
  peerAhead: SeqRange[];
  unprovable: string[];
} {
  const conservative = toConservativeVector(peer);
  const unprovable = Object.keys(peer)
    .filter((d) => provableFrontier(peer[d]) === 0 && peer[d].count > 0)
    .sort();

  const localAhead = planRangesToSend(local, conservative);

  const peerAhead: SeqRange[] = [];
  for (const device of Object.keys(conservative).sort()) {
    const theirs = conservative[device];
    const have = local[device] ?? 0;
    if (theirs > have) {
      peerAhead.push({ device_id: device, from_seq: have + 1, to_seq: theirs });
    }
  }
  return { localAhead, peerAhead, unprovable };
}
