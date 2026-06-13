// Pure-logic selftest for lib/replication/planner.ts. No React Native, no
// SQLite — run directly with bun from apps/mobile/:
//
//   bun lib/replication/__dev__/planner-selftest.ts
//
// Exits non-zero on the first failure. Keep this green before touching the
// planner — M3/M4 make these plans the transfer source of truth.

import {
  computeContiguous,
  diffVectors,
  planRangesToSend,
  provableFrontier,
  splitIntoBatches,
  toConservativeVector,
  type PeerVector,
  type Vector,
} from "../planner";

let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, { actual, expected });
}

// ---------- computeContiguous ----------
console.log("computeContiguous");
eq("empty", computeContiguous([]), { frontier: 0, gaps: [] });
eq("dense 1..5", computeContiguous([1, 2, 3, 4, 5]), { frontier: 5, gaps: [] });
eq("unsorted dense", computeContiguous([3, 1, 5, 2, 4]), { frontier: 5, gaps: [] });
eq("missing 1 → frontier 0", computeContiguous([2, 3, 4]), {
  frontier: 0,
  gaps: [{ from_seq: 1, to_seq: 1 }],
});
eq("gap above frontier", computeContiguous([1, 2, 3, 7]), {
  frontier: 3,
  gaps: [{ from_seq: 4, to_seq: 6 }],
});
eq("two gaps", computeContiguous([1, 4, 5, 9]), {
  frontier: 1,
  gaps: [
    { from_seq: 2, to_seq: 3 },
    { from_seq: 6, to_seq: 8 },
  ],
});
eq("duplicates tolerated", computeContiguous([1, 1, 2, 2, 3]), { frontier: 3, gaps: [] });
eq("single high orphan", computeContiguous([42]), {
  frontier: 0,
  gaps: [{ from_seq: 1, to_seq: 41 }],
});
// Domain guard: out-of-range values from a hostile/buggy peer are
// discarded, never allowed to corrupt frontier/gap math.
eq("zero discarded", computeContiguous([0, 1, 2]), { frontier: 2, gaps: [] });
eq("negatives discarded", computeContiguous([-5, 1]), { frontier: 1, gaps: [] });
eq("fractions discarded", computeContiguous([1, 1.5, 2]), { frontier: 2, gaps: [] });
eq("all invalid → empty", computeContiguous([0, -1, 2.7]), { frontier: 0, gaps: [] });

// ---------- provableFrontier / toConservativeVector ----------
console.log("provableFrontier");
eq("complete from 1", provableFrontier({ min_seq: 1, count: 7, max_seq: 7 }), 7);
eq("gap → 0", provableFrontier({ min_seq: 1, count: 4, max_seq: 7 }), 0);
eq("starts above 1 → 0", provableFrontier({ min_seq: 3, count: 5, max_seq: 7 }), 0);
eq("empty-ish → 0", provableFrontier({ min_seq: 0, count: 0, max_seq: 0 }), 0);
eq(
  "conservative collapse",
  toConservativeVector({
    a: { min_seq: 1, count: 3, max_seq: 3 },
    b: { min_seq: 1, count: 2, max_seq: 9 },
  }),
  { a: 3, b: 0 },
);

// ---------- planRangesToSend ----------
console.log("planRangesToSend");
{
  const local: Vector = { devA: 10, devB: 5, devC: 0 };
  const peer: Vector = { devA: 7, devB: 5, devD: 9 };
  eq("send only where ahead", planRangesToSend(local, peer), [
    { device_id: "devA", from_seq: 8, to_seq: 10 },
  ]);
}
eq("peer knows nothing", planRangesToSend({ x: 3 }, {}), [
  { device_id: "x", from_seq: 1, to_seq: 3 },
]);
eq("nothing local", planRangesToSend({}, { x: 3 }), []);
eq(
  "deterministic device order",
  planRangesToSend({ b: 2, a: 2 }, {}).map((r) => r.device_id),
  ["a", "b"],
);

// ---------- splitIntoBatches ----------
console.log("splitIntoBatches");
{
  const ranges = [
    { device_id: "a", from_seq: 1, to_seq: 7 },
    { device_id: "b", from_seq: 1, to_seq: 4 },
  ];
  const batches = splitIntoBatches(ranges, 5);
  eq("batch shapes", batches, [
    [{ device_id: "a", from_seq: 1, to_seq: 5 }],
    [
      { device_id: "a", from_seq: 6, to_seq: 7 },
      { device_id: "b", from_seq: 1, to_seq: 3 },
    ],
    [{ device_id: "b", from_seq: 4, to_seq: 4 }],
  ]);
  // Invariants: per-author order preserved across batches; total count exact.
  const flat = batches.flat();
  const totals = flat.reduce((n, r) => n + (r.to_seq - r.from_seq + 1), 0);
  eq("no events lost or duplicated", totals, 11);
  const perAuthor: Record<string, number[]> = {};
  for (const r of flat) {
    perAuthor[r.device_id] = perAuthor[r.device_id] ?? [];
    for (let s = r.from_seq; s <= r.to_seq; s++) perAuthor[r.device_id].push(s);
  }
  check(
    "per-author strictly increasing",
    Object.values(perAuthor).every((seqs) =>
      seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1),
    ),
    perAuthor,
  );
}
{
  let threw = false;
  try {
    splitIntoBatches([], 0);
  } catch {
    threw = true;
  }
  check("batchSize 0 throws", threw);
}
eq("empty ranges → no batches", splitIntoBatches([], 100), []);

// ---------- diffVectors ----------
console.log("diffVectors");
{
  const local: Vector = { devA: 10, devB: 3 };
  const peer: PeerVector = {
    devA: { min_seq: 1, count: 7, max_seq: 7 }, // provable 7 < local 10
    devB: { min_seq: 1, count: 8, max_seq: 8 }, // provable 8 > local 3
    devC: { min_seq: 2, count: 4, max_seq: 6 }, // unprovable
  };
  const d = diffVectors(local, peer);
  eq("localAhead", d.localAhead, [{ device_id: "devA", from_seq: 8, to_seq: 10 }]);
  eq("peerAhead", d.peerAhead, [{ device_id: "devB", from_seq: 4, to_seq: 8 }]);
  eq("unprovable", d.unprovable, ["devC"]);
}
eq(
  "identical vectors → clean diff",
  diffVectors({ a: 4 }, { a: { min_seq: 1, count: 4, max_seq: 4 } }),
  {
    localAhead: [],
    peerAhead: [],
    unprovable: [],
  },
);

// ---------- result ----------
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall planner selftests passed");
