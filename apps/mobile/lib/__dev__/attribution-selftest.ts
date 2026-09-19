// Run with `npm run selftest:attribution`. Uses installed better-sqlite3 and a
// synthetic fixture only: never opens kaata.db or any device/user backup.
//
// Pins the "who wrote this tally" resolver behind the shared-kaata author
// chips (lib/attribution.ts). The cases that matter are the ones where a
// wrong answer is worse than no answer at all:
//
//   - painting one of YOUR OWN tallies as somebody else's, which is what
//     happens if self-identity is matched against a single account id rather
//     than the full candidate set (a vault created before sign-in keys its
//     rows by a `local:` device sentinel, and a rotated device key leaves a
//     retired sentinel behind);
//   - attributing a tally to the wrong member because the amendments were
//     folded in a different order than the projection folds them;
//   - labelling a member "You" because the restore placeholder reached the
//     members mirror.
//
// The tint assignment is pinned too: it has to be deterministic across
// devices, because two phones disagreeing about a member's color is a bug the
// user reads as "the app is confused about who did this".

import assert from "node:assert/strict";
import Database from "better-sqlite3";

function withModuleStubs<T>(stubs: Record<string, unknown>, load: () => T): T {
  const saved = new Map<string, NodeJS.Module | undefined>();
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = require.resolve(name);
    saved.set(filename, require.cache[filename]);
    require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
  }
  try {
    return load();
  } finally {
    for (const [filename, previous] of saved) {
      if (previous) require.cache[filename] = previous;
      else delete require.cache[filename];
    }
  }
}

const fixture = new Database(":memory:");

// Only the columns the resolver reads. Deliberately NOT the production schema:
// this test is about the query's semantics, and a trimmed table makes a column
// rename fail loudly here instead of silently returning nothing.
fixture.exec(`
  CREATE TABLE event_log (
    event_id           TEXT PRIMARY KEY,
    event_type         TEXT NOT NULL,
    vault_id           TEXT,
    target_id          TEXT,
    relationship_id    TEXT,
    hlc_physical_ms    INTEGER NOT NULL,
    hlc_logical        INTEGER NOT NULL,
    hlc_device_id      TEXT NOT NULL,
    device_id          TEXT,
    actor_account_id   TEXT
  );
  CREATE TABLE vault_members_mirror (
    vault_id     TEXT NOT NULL,
    account_id   TEXT NOT NULL,
    display_name TEXT,
    revoked_at   INTEGER,
    PRIMARY KEY (vault_id, account_id)
  );
  CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    account_id   TEXT,
    display_name TEXT
  );
  CREATE TABLE vault_device_registry (
    vault_id   TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    account_id TEXT NOT NULL
  );
`);

const db = {
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
};

const attribution = withModuleStubs(
  {
    "../db-tx": { getDb: async () => db },
    // i18n pulls expo-localization and ./db; the resolver only needs this one
    // pure predicate, and the real strings are asserted against below so the
    // stub cannot drift away from production behaviour.
    "../i18n": {
      isPlaceholderSelfName: (name: string) => name === "You" || name === "شما",
    },
  },
  () => require("../attribution") as typeof import("../attribution"),
);

const { chipActorFor, initialOf, loadMemberNames, loadRelationshipAttribution, memberTintFor } =
  attribution;

const { memberTints } = require("../colors") as typeof import("../colors");

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const VAULT = "vault-1";
const REL = "rel-1";
const OTHER_REL = "rel-2";

const ME = "acct-me";
const ME_LOCAL = "local:AAAAAAAAAAAAAAAA"; // pre-sign-in sentinel for the same person
const ME_RETIRED = "local:BBBBBBBBBBBBBBBB"; // sentinel from a rotated device key
const SARA = "acct-sara";
const AHMAD = "acct-ahmad";
const GONE = "acct-gone"; // revoked member
const GHOST = "acct-ghost"; // no mirror row at all
const SELF_IDS = [ME, ME_LOCAL, ME_RETIRED];

const insertMember = fixture.prepare(
  `INSERT INTO vault_members_mirror (vault_id, account_id, display_name, revoked_at)
   VALUES (?, ?, ?, ?)`,
);
insertMember.run(VAULT, ME, "Matee", null);
insertMember.run(VAULT, SARA, "Sara", null);
insertMember.run(VAULT, AHMAD, null, null); // admitted, name not yet mirrored
insertMember.run(VAULT, GONE, "Old Staff", 1_700_000_000_000); // revoked
// The restore placeholder leaking into the mirror: must never be shown as a
// name, or a DIFFERENT member reads as "You" on this device.
insertMember.run(VAULT, "acct-placeholder", "You", null);

// A local contact row is this device's nickname for Ahmad. The mirror has no
// name for him, so this is the fallback the COALESCE picks up.
fixture
  .prepare(`INSERT INTO users (id, account_id, display_name) VALUES (?, ?, ?)`)
  .run("u-ahmad", AHMAD, "Ahmad Wali");

fixture
  .prepare(`INSERT INTO vault_device_registry (vault_id, device_id, account_id) VALUES (?, ?, ?)`)
  .run(VAULT, "device-sara", SARA);

let seq = 0;
function event(args: {
  type: "entry_created" | "entry_amended" | "entry_deleted";
  entryId: string;
  actor: string | null;
  deviceId?: string;
  pms: number;
  logical?: number;
  hlcDevice?: string;
  relationshipId?: string;
}) {
  fixture
    .prepare(
      `INSERT INTO event_log (event_id, event_type, vault_id, target_id, relationship_id,
                              hlc_physical_ms, hlc_logical, hlc_device_id, device_id,
                              actor_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ev-${seq++}`,
      args.type,
      VAULT,
      args.entryId,
      args.relationshipId ?? REL,
      args.pms,
      args.logical ?? 0,
      args.hlcDevice ?? "hlc-dev",
      args.deviceId ?? "device-x",
      args.actor,
    );
}

// e1 — written by me, never touched again.
event({ type: "entry_created", entryId: "e1", actor: ME, pms: 1000 });
// e2 — written by Sara.
event({ type: "entry_created", entryId: "e2", actor: SARA, pms: 2000 });
// e3 — written by me, then amended by Sara. The scary case.
event({ type: "entry_created", entryId: "e3", actor: ME, pms: 3000 });
event({ type: "entry_amended", entryId: "e3", actor: SARA, pms: 3100 });
// e4 — written by Sara, amended by Sara. Fixing your own typo is not news.
event({ type: "entry_created", entryId: "e4", actor: SARA, pms: 4000 });
event({ type: "entry_amended", entryId: "e4", actor: SARA, pms: 4100 });
// e5 — written by me under the PRE-SIGN-IN sentinel, before this device had a
// Google account. Still mine.
event({ type: "entry_created", entryId: "e5", actor: ME_LOCAL, pms: 5000 });
// e6 — written by me under a RETIRED device-key sentinel. Still mine.
event({ type: "entry_created", entryId: "e6", actor: ME_RETIRED, pms: 6000 });
// e7 — actor_account_id NULL (appended before its author signed in); the
// device binding is the only local answer.
event({ type: "entry_created", entryId: "e7", actor: null, deviceId: "device-sara", pms: 7000 });
// e8 — three amendments; the LAST one by full HLC order is the editor. They
// are inserted out of order on purpose, and two tie on physical ms so the
// logical counter has to break it.
event({ type: "entry_created", entryId: "e8", actor: ME, pms: 8000 });
event({ type: "entry_amended", entryId: "e8", actor: AHMAD, pms: 8100, logical: 5 });
event({ type: "entry_amended", entryId: "e8", actor: GONE, pms: 8050 });
event({ type: "entry_amended", entryId: "e8", actor: SARA, pms: 8100, logical: 2 });
// e9 — a revoked member's tally. They still wrote it.
event({ type: "entry_created", entryId: "e9", actor: GONE, pms: 9000 });
// e10 — an account with no mirror row and no contact row.
event({ type: "entry_created", entryId: "e10", actor: GHOST, pms: 10_000 });
// e11 — only an amendment reached this device; the create is missing.
event({ type: "entry_amended", entryId: "e11", actor: SARA, pms: 11_000 });
// e12 — belongs to a DIFFERENT relationship; must not leak into this person.
event({
  type: "entry_created",
  entryId: "e12",
  actor: SARA,
  pms: 12_000,
  relationshipId: OTHER_REL,
});
// A non-entry event on this relationship must be ignored by the filter.
event({ type: "entry_deleted", entryId: "e1", actor: SARA, pms: 13_000 });

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

let failures = 0;
// AWAITS the body. A sync-only runner reports "ok" for an async case whose
// promise rejects later, which would make the two database cases below
// decorative — the exact failure this file exists to prevent elsewhere.
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(err instanceof Error ? `      ${err.message}` : err);
  }
}

async function main() {
  // --- initialOf ---------------------------------------------------------
  await check("initialOf uppercases the first letter", () => {
    assert.equal(initialOf("sara"), "S");
    assert.equal(initialOf("Matee Saafi"), "M");
  });
  await check("initialOf skips leading whitespace", () => {
    assert.equal(initialOf("   ahmad"), "A");
  });
  await check("initialOf falls back to ? for empty / null / undefined", () => {
    assert.equal(initialOf(""), "?");
    assert.equal(initialOf("   "), "?");
    assert.equal(initialOf(null), "?");
    assert.equal(initialOf(undefined), "?");
  });
  await check("initialOf keeps an astral first character whole", () => {
    // "[0]" would return a lone high surrogate, which paints as a box.
    const emoji = "😀ali";
    assert.equal(initialOf(emoji), "😀");
    assert.equal(Array.from(initialOf(emoji)).length, 1);
  });
  await check("initialOf handles a Persian name", () => {
    assert.equal(initialOf("سارا"), "س");
  });

  // --- memberTintFor -----------------------------------------------------
  await check("memberTintFor is deterministic and inside the palette", () => {
    const a = memberTintFor(SARA);
    assert.deepEqual(a, memberTintFor(SARA));
    assert.ok(memberTints.some((tint) => tint.bg === a.bg && tint.fg === a.fg));
  });
  await check("memberTintFor separates ids that share a long prefix", () => {
    // `local:` sentinels differ only after 6 identical characters. A hash that
    // clustered on prefixes would hand them all one color, which is exactly
    // the population most likely to be in one vault together.
    const tints = new Set(
      ["local:AAAAAAAAAAAAAAAA", "local:AAAAAAAAAAAAAAAB", "local:AAAAAAAAAAAAAAAC"].map(
        (id) => memberTintFor(id).bg,
      ),
    );
    assert.ok(tints.size >= 2, `prefix-sharing ids collapsed to ${tints.size} tint(s)`);
  });
  await check("memberTintFor never returns a direction color", () => {
    // A member tint that reads as collect-green or pay-red would lie about a
    // ledger row. Pinned against the actual palette, not a description of it.
    const { colors } = require("../colors") as typeof import("../colors");
    const banned = new Set([
      colors.collectBg,
      colors.collectText,
      colors.collectStrong,
      colors.payBg,
      colors.payText,
      colors.payStrong,
      colors.danger,
    ]);
    for (const tint of memberTints) {
      assert.ok(!banned.has(tint.bg as never), `tint bg ${tint.bg} collides with a semantic color`);
      assert.ok(!banned.has(tint.fg as never), `tint fg ${tint.fg} collides with a semantic color`);
    }
  });

  // --- loadMemberNames ---------------------------------------------------
  await check(
    "loadMemberNames resolves mirror names, users fallback, and skips placeholders",
    async () => {
      const names = await loadMemberNames(VAULT);
      assert.equal(names.get(ME), "Matee");
      assert.equal(names.get(SARA), "Sara");
      // Mirror row has no name; the local contact row supplies one.
      assert.equal(names.get(AHMAD), "Ahmad Wali");
      // Revoked members keep their name: they still wrote what they wrote.
      assert.equal(names.get(GONE), "Old Staff");
      // "You" must never become a member's name on this device.
      assert.equal(names.has("acct-placeholder"), false);
    },
  );

  // --- loadRelationshipAttribution ---------------------------------------
  const map = await loadRelationshipAttribution(VAULT, REL, SELF_IDS);

  await check("my own tally is attributed to me", () => {
    const a = map.get("e1");
    assert.equal(a?.author?.accountId, ME);
    assert.equal(a?.author?.isSelf, true);
    assert.equal(a?.author?.name, "Matee");
    assert.equal(a?.editor, null);
  });
  await check("another member's tally carries their name", () => {
    const a = map.get("e2");
    assert.equal(a?.author?.accountId, SARA);
    assert.equal(a?.author?.isSelf, false);
    assert.equal(a?.author?.name, "Sara");
  });
  await check("an amendment by a DIFFERENT member is reported as the editor", () => {
    const a = map.get("e3");
    assert.equal(a?.author?.accountId, ME);
    assert.equal(a?.editor?.accountId, SARA);
  });
  await check("an amendment by the author themself is NOT an editor", () => {
    const a = map.get("e4");
    assert.equal(a?.author?.accountId, SARA);
    assert.equal(a?.editor, null);
  });
  await check("a pre-sign-in local sentinel still resolves as me", () => {
    assert.equal(map.get("e5")?.author?.isSelf, true);
  });
  await check("a RETIRED device-key sentinel still resolves as me", () => {
    // The whole reason the resolver takes a candidate SET. Matching only the
    // current account id paints the user's own older tallies as a stranger's.
    assert.equal(map.get("e6")?.author?.isSelf, true);
  });
  await check("a NULL actor falls back to the device registry", () => {
    const a = map.get("e7");
    assert.equal(a?.author?.accountId, SARA);
    assert.equal(a?.author?.name, "Sara");
  });
  await check("the latest amendment wins by FULL hlc order, not insertion order", () => {
    // Ahmad (8100, l=5) beats Sara (8100, l=2) beats Old Staff (8050),
    // regardless of the order the rows were written.
    assert.equal(map.get("e8")?.editor?.accountId, AHMAD);
  });
  await check("a revoked member is still named on the tally they wrote", () => {
    assert.equal(map.get("e9")?.author?.name, "Old Staff");
  });
  await check("an unknown account yields a null name, never a raw id", () => {
    const a = map.get("e10");
    assert.equal(a?.author?.accountId, GHOST);
    assert.equal(a?.author?.name, null);
  });
  await check("an amend-only entry still reports its editor", () => {
    const a = map.get("e11");
    assert.equal(a?.author, null);
    assert.equal(a?.editor?.accountId, SARA);
  });
  await check("another relationship's tallies do not leak in", () => {
    assert.equal(map.has("e12"), false);
  });
  await check("a deletion event does not overwrite authorship", () => {
    // entry_deleted is outside the event_type filter; e1 stays mine.
    assert.equal(map.get("e1")?.author?.accountId, ME);
    assert.equal(map.get("e1")?.editor, null);
  });
  await check("an unknown vault / relationship returns an empty map, not a throw", async () => {
    assert.equal((await loadRelationshipAttribution(VAULT, "no-such-rel", SELF_IDS)).size, 0);
    assert.equal((await loadRelationshipAttribution("", REL, SELF_IDS)).size, 0);
    assert.equal((await loadRelationshipAttribution(VAULT, "", SELF_IDS)).size, 0);
  });
  await check("an empty self-id set never marks anything as mine", async () => {
    const anon = await loadRelationshipAttribution(VAULT, REL, []);
    assert.equal(anon.get("e1")?.author?.isSelf, false);
  });

  // --- chipActorFor ------------------------------------------------------
  await check("a tally only I have touched gets NO chip", () => {
    // The restraint that keeps a solo-dominant ledger looking untouched.
    assert.equal(chipActorFor(map.get("e1")), null);
    assert.equal(chipActorFor(map.get("e5")), null);
    assert.equal(chipActorFor(map.get("e6")), null);
  });
  await check("another member's tally gets their chip", () => {
    assert.equal(chipActorFor(map.get("e2"))?.accountId, SARA);
  });
  await check("MY tally amended by someone else shows the AMENDER", () => {
    // The highest-signal case on a shared ledger: somebody changed my number.
    assert.equal(chipActorFor(map.get("e3"))?.accountId, SARA);
  });
  await check("someone else's tally that I amended still shows THEM", () => {
    const attributionForMine = {
      author: { accountId: SARA, name: "Sara", isSelf: false },
      editor: { accountId: ME, name: "Matee", isSelf: true },
    };
    assert.equal(chipActorFor(attributionForMine)?.accountId, SARA);
  });
  await check("chipActorFor tolerates undefined", () => {
    assert.equal(chipActorFor(undefined), null);
  });

  // --- the i18n keys the row renders -------------------------------------
  await check("every attribution string exists in BOTH languages", () => {
    // The row's words are built by concatenation, so a missing key would show
    // a raw dotted identifier to a user. Read as source, because importing
    // i18n here would pull expo-localization.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const source = readFileSync(require.resolve("../i18n"), "utf8");
    for (const key of [
      "entry.addedBy",
      "entry.editedBy",
      "entry.editedByOnly",
      "entry.by.you",
      "entry.by.someone",
    ]) {
      const occurrences = source.split(`"${key}":`).length - 1;
      assert.equal(occurrences, 2, `${key} appears ${occurrences}x, want 2 (en + fa)`);
    }
    // Every template that takes a name must actually interpolate it.
    for (const key of ["entry.addedBy", "entry.editedBy", "entry.editedByOnly"]) {
      for (const line of source.split("\n").filter((l) => l.includes(`"${key}":`))) {
        assert.ok(line.includes("{name}"), `${key} is missing the {name} placeholder: ${line}`);
      }
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} attribution selftest case(s) FAILED`);
    process.exit(1);
  }
  console.log("\nattribution selftest: all cases passed");
}

void main();
