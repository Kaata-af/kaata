// Pure-function selftest for lib/hlc.ts. Run via:
//   cd apps/mobile && npm run selftest:hlc
// or
//   cd apps/mobile && npx tsx lib/__dev__/hlc-selftest.ts
//
// Exits 0 on success, 1 on any failed assertion.
// NOT imported by app code — excluded from production bundle by virtue of
// being in __dev__/ and unreferenced by any router/screen.

import {
  type HLC,
  MAX_FORWARD_DRIFT_MS,
  compareHLC,
  deserializeHLC,
  serializeHLC,
  tickLocal,
  tickReceive,
} from "../hlc";

// Two distinct device ids chosen so DEVICE_A < DEVICE_B lexicographically
// (case 10 leans on this for the lex tiebreak assertion).
const DEVICE_A = "aaaa-aaaa";
const DEVICE_B = "zzzz-zzzz";

type TestResult = { name: string; ok: boolean; err?: string };
const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, err });
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================================
// 13 test cases
// ============================================================

test("01 tickLocal monotonicity across sequence", () => {
  const sequence = [1000, 1000, 1000, 1500, 1499, 1499, 2000, 2000];
  let prev: HLC | null = null;
  for (const now of sequence) {
    const next = tickLocal(prev, now, DEVICE_A);
    if (prev !== null) {
      assert(
        compareHLC(next, prev) > 0,
        `not monotonic at nowMs=${now}: ${JSON.stringify(prev)} -> ${JSON.stringify(next)}`,
      );
    }
    prev = next;
  }
});

test("02 tickLocal logical bump when nowMs == prev.pms", () => {
  const first = tickLocal(null, 1000, DEVICE_A);
  const second = tickLocal(first, 1000, DEVICE_A);
  assertEq(second.pms, first.pms, "physical should stay equal");
  assertEq(second.l, first.l + 1, "logical should increment by exactly 1");
  assertEq(second.did, DEVICE_A, "device id should be DEVICE_A");
});

test("03 tickLocal physical advance resets logical", () => {
  const first = tickLocal(null, 1000, DEVICE_A);
  const bumped = tickLocal(first, 1000, DEVICE_A); // l = 1
  const advanced = tickLocal(bumped, 2000, DEVICE_A);
  assertEq(advanced.pms, 2000, "physical should jump to nowMs");
  assertEq(advanced.l, 0, "logical should reset to 0 on physical advance");
});

test("04 tickLocal wall-clock regression keeps physical, bumps logical", () => {
  const ahead = tickLocal(null, 5000, DEVICE_A);
  const regressed = tickLocal(ahead, 4000, DEVICE_A);
  assertEq(regressed.pms, 5000, "physical must not regress with wall-clock");
  assertEq(regressed.l, ahead.l + 1, "logical bumps when wall-clock regresses");
  assert(compareHLC(regressed, ahead) > 0, "must still order strictly after ahead");
});

test("05 tickReceive merges remote causality", () => {
  const local = tickLocal(null, 1000, DEVICE_A);
  const remote: HLC = { pms: 1500, l: 3, did: DEVICE_B };
  const merged = tickReceive(local, remote, 1200, DEVICE_A);
  assert(compareHLC(merged, local) > 0, "merged must exceed local");
  assert(compareHLC(merged, remote) > 0, "merged must exceed remote");
  assertEq(merged.did, DEVICE_A, "merged device should be local device");
});

test("06 tickReceive drift clamp at MAX_FORWARD_DRIFT_MS", () => {
  const local = tickLocal(null, 1000, DEVICE_A);
  const nowMs = 1000;
  // Remote pms strictly beyond the drift cap — must clamp to nowMs.
  const farFutureRemote: HLC = {
    pms: nowMs + MAX_FORWARD_DRIFT_MS + 1,
    l: 0,
    did: DEVICE_B,
  };
  const merged = tickReceive(local, farFutureRemote, nowMs, DEVICE_A);
  assertEq(merged.pms, nowMs, "merged.pms must clamp to nowMs when remote exceeds drift cap");

  // Boundary: exactly at the cap is accepted (impl uses strict >).
  const atCapRemote: HLC = {
    pms: nowMs + MAX_FORWARD_DRIFT_MS,
    l: 0,
    did: DEVICE_B,
  };
  const mergedAtCap = tickReceive(local, atCapRemote, nowMs, DEVICE_A);
  assertEq(mergedAtCap.pms, atCapRemote.pms, "merged.pms == remote.pms at exactly the drift cap");
});

test("07 tickReceive when local, remote, nowMs all agree on pms", () => {
  const local: HLC = { pms: 1000, l: 2, did: DEVICE_A };
  const remote: HLC = { pms: 1000, l: 5, did: DEVICE_B };
  const merged = tickReceive(local, remote, 1000, DEVICE_A);
  assertEq(merged.pms, 1000, "pms stays at 1000");
  assertEq(merged.l, 6, "logical = max(2,5) + 1 = 6");
  assertEq(merged.did, DEVICE_A, "device is local");
});

test("08 tickReceive when remote is older than local", () => {
  const local: HLC = { pms: 5000, l: 0, did: DEVICE_A };
  const remoteOlder: HLC = { pms: 2000, l: 99, did: DEVICE_B };
  const merged = tickReceive(local, remoteOlder, 5000, DEVICE_A);
  assertEq(merged.pms, 5000, "merged.pms tracks the larger of local/remote/nowMs");
  assert(merged.l >= local.l + 1, "logical must advance past local");
  assert(compareHLC(merged, local) > 0, "merged strictly exceeds local");
  assert(
    compareHLC(merged, remoteOlder) > 0,
    "merged strictly exceeds remote (vacuously, since local already does)",
  );
});

test("09 compareHLC total order — priority pms > l > did", () => {
  const baseA: HLC = { pms: 1000, l: 5, did: DEVICE_A };
  const higherPms: HLC = { pms: 1001, l: 0, did: DEVICE_A };
  const higherL: HLC = { pms: 1000, l: 6, did: DEVICE_A };
  const higherDid: HLC = { pms: 1000, l: 5, did: DEVICE_B };

  assert(compareHLC(higherPms, baseA) > 0, "higher pms wins");
  assert(compareHLC(higherPms, higherL) > 0, "higher pms beats higher l");
  assert(compareHLC(higherPms, higherDid) > 0, "higher pms beats higher did");

  assert(compareHLC(higherL, baseA) > 0, "higher l wins when pms equal");
  assert(compareHLC(higherL, higherDid) > 0, "higher l beats higher did when pms equal");

  assert(compareHLC(higherDid, baseA) > 0, "higher did wins when pms and l equal");

  assertEq(compareHLC(baseA, baseA), 0, "identical HLCs compare equal");
});

test("10 compareHLC across devices with same (pms, l) resolves by did lex", () => {
  const fromA: HLC = { pms: 1000, l: 0, did: DEVICE_A };
  const fromB: HLC = { pms: 1000, l: 0, did: DEVICE_B };
  assert(compareHLC(fromB, fromA) > 0, "DEVICE_B did sorts after DEVICE_A");
  assert(compareHLC(fromA, fromB) < 0, "DEVICE_A did sorts before DEVICE_B");
  assertEq(compareHLC(fromA, fromA), 0, "same device same components is equal");
});

test("11 serialize / deserialize round-trip preserves all three fields", () => {
  const cases: HLC[] = [
    { pms: 0, l: 0, did: DEVICE_A },
    { pms: 1, l: 0, did: DEVICE_A },
    { pms: 1_700_000_000_000, l: 42, did: DEVICE_B },
    {
      pms: Number.MAX_SAFE_INTEGER,
      l: 999999,
      did: "device-with-hyphens-and-stuff",
    },
  ];
  for (const h of cases) {
    const round = deserializeHLC(serializeHLC(h));
    assert(round !== null, `round-trip returned null for ${JSON.stringify(h)}`);
    assertEq(round.pms, h.pms, "pms round-trip");
    assertEq(round.l, h.l, "l round-trip");
    assertEq(round.did, h.did, "did round-trip");
  }
});

test("12 deserializeHLC returns null on malformed JSON", () => {
  const malformed = ["", "not json", "{", '{"pms":', "null", "[1,2,3]", '"string"', "42"];
  for (const raw of malformed) {
    const result = deserializeHLC(raw);
    assertEq(result, null, `expected null for malformed input ${JSON.stringify(raw)}`);
  }
});

test("13 deserializeHLC returns null on partial / wrong-typed objects", () => {
  // Only test cases where the impl's typeof guards (number/number/string)
  // explicitly reject. The impl in hlc.ts does NOT validate integer-ness or
  // sign of pms, so non-integer/negative numeric pms cases are excluded.
  const partial = [
    "{}",
    '{"pms":1000}',
    '{"pms":1000,"l":0}',
    '{"l":0,"did":"x"}',
    '{"pms":"1000","l":0,"did":"x"}',
    '{"pms":1000,"l":"0","did":"x"}',
    '{"pms":1000,"l":0,"did":123}',
  ];
  for (const raw of partial) {
    const result = deserializeHLC(raw);
    assertEq(result, null, `expected null for partial input ${raw}`);
  }
});

// ============================================================
// Report
// ============================================================

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);

for (const r of results) {
  if (r.ok) {
    console.log(`  PASS  ${r.name}`);
  } else {
    console.log(`  FAIL  ${r.name}`);
    console.log(`        ${r.err}`);
  }
}

console.log("");
console.log(`${passed}/${results.length} passed`);

if (failed.length > 0) {
  process.exit(1);
}
