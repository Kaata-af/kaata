// Pure selftest for the M3 salted daily vault-digest scheme. No RN, no
// SQLite — run from apps/mobile/:
//   bun lib/mesh/__dev__/vault-digest-selftest.ts
// Exits non-zero on the first failure.

import {
  advertiseDigests,
  buildScanIndex,
  dayNumber,
  MS_PER_DAY,
  scanDigests,
  vaultDigest,
} from "../vault-digest";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

const VAULT_A = "a1b2c3d4-0000-4000-8000-000000000001";
const VAULT_B = "a1b2c3d4-0000-4000-8000-000000000002";
// A fixed "now" mid-day so today's window is unambiguous.
const NOW = 100 * MS_PER_DAY + 12 * 3_600_000;
const DAY = dayNumber(NOW);

console.log("determinism");
check("same vault+day → same digest", vaultDigest(VAULT_A, DAY) === vaultDigest(VAULT_A, DAY));
check("digest is base64url, 11 chars", /^[A-Za-z0-9_-]{11}$/.test(vaultDigest(VAULT_A, DAY)), {
  got: vaultDigest(VAULT_A, DAY),
});

console.log("separation");
check(
  "different vault → different digest",
  vaultDigest(VAULT_A, DAY) !== vaultDigest(VAULT_B, DAY),
);
check(
  "different day → different digest",
  vaultDigest(VAULT_A, DAY) !== vaultDigest(VAULT_A, DAY + 1),
);

console.log("member correlation");
{
  // Two members (different "now" within the same UTC day) advertise/scan and
  // must find each other.
  const publisherDigests = advertiseDigests(VAULT_A, NOW); // today + tomorrow
  const scannerIndex = buildScanIndex([VAULT_A, VAULT_B], NOW + 3_600_000); // yest/today/tomorrow
  const matched = publisherDigests.some((d) => scannerIndex.has(d));
  check("member scanner matches member publisher (same day)", matched);
  check(
    "match resolves to the right vault",
    publisherDigests.map((d) => scannerIndex.get(d)).some((v) => v === VAULT_A),
  );
}

console.log("midnight rollover / skew window");
{
  // Publisher is just before midnight; scanner has already rolled to the next
  // day. Publisher advertises today+tomorrow; scanner accepts yest/today/
  // tomorrow → tomorrow(publisher) == today(scanner) overlaps.
  const beforeMidnight = DAY * MS_PER_DAY + (MS_PER_DAY - 60_000);
  const afterMidnight = (DAY + 1) * MS_PER_DAY + 60_000;
  const pub = advertiseDigests(VAULT_A, beforeMidnight);
  const idx = buildScanIndex([VAULT_A], afterMidnight);
  check(
    "rollover: scanner still finds publisher across midnight",
    pub.some((d) => idx.has(d)),
  );
}
{
  // ±1 full day of skew is the limit; 2 days apart must NOT match (bounds the
  // window so a stale leaked digest can't match indefinitely).
  const pub = advertiseDigests(VAULT_A, NOW); // days D, D+1
  const idx = buildScanIndex([VAULT_A], NOW + 3 * MS_PER_DAY); // days D+2,D+3,D+4
  check("two+ days apart does NOT match (window bounded)", !pub.some((d) => idx.has(d)));
}

console.log("outsider cannot correlate");
{
  // An outsider does NOT know the vault_id. The best they can do is observe
  // advertised digests; without the vault_id they cannot reproduce tomorrow's
  // digest from today's (HMAC is a PRF keyed on the secret vault_id).
  const todayDigests = advertiseDigests(VAULT_A, NOW);
  // Outsider tries to guess the NEXT day's digest from the observed ones.
  const nextDay = vaultDigest(VAULT_A, DAY + 2);
  check("next-window digest not derivable from observed digests", !todayDigests.includes(nextDay));
  // And a wrong vault_id guess yields an unrelated digest.
  check(
    "wrong vault_id guess does not reproduce the digest",
    vaultDigest("not-the-real-vault-id", DAY) !== vaultDigest(VAULT_A, DAY),
  );
}

console.log("scan index shape");
{
  const idx = buildScanIndex([VAULT_A, VAULT_B], NOW);
  // 2 vaults × 3 acceptable days = up to 6 entries (no collisions expected).
  check("index has 6 entries for 2 vaults × 3 days", idx.size === 6, { size: idx.size });
  check("scanDigests covers 3 days", scanDigests(VAULT_A, NOW).length === 3);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall vault-digest selftests passed");
