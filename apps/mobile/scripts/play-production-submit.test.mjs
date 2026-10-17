import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { commitProduction, prepareProduction } from "./play-production-submit.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "kaata-production-submit-test-"));
const aabPath = path.join(dir, "verified.aab");
const bytes = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("verified mock signed bundle"),
]);
writeFileSync(aabPath, bytes);
after(() => {
  rmSync(aabPath);
  rmdirSync(dir);
});
const sha256 = createHash("sha256").update(bytes).digest("hex");
const app = { version: "2.2.1", android: { package: "af.kaata.app", versionCode: 60 } };
const expectedImages = Object.entries({
  phoneScreenshots: 6,
  sevenInchScreenshots: 6,
  tenInchScreenshots: 6,
  featureGraphic: 1,
}).map(([type, count]) => ({
  type,
  images: Array.from({ length: count }, (_, index) => ({
    id: `${type}-${index}`,
    sha256: `${type}-hash-${index}`,
  })),
}));
const notes = "Kaata 2.2.1: fixed an Android crash when opening customers from search.";
const token = "private-mock-token";
const response = (body, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

function mock(options = {}) {
  const calls = [],
    checkpoints = [],
    messages = [];
  const tracks = [
    {
      track: "production",
      releases: [{ name: "2.1.1", versionCodes: ["50"], status: "completed" }],
    },
    { track: "internal", releases: [{ name: "2.2.0", versionCodes: ["58"], status: "completed" }] },
    { track: "alpha", releases: [{ name: "2.0.0", versionCodes: ["43"], status: "completed" }] },
  ];
  let editCounter = 0,
    committed = false;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url),
      endpoint = parsed.pathname.replace(/^.*\/applications\/af\.kaata\.app/, "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ endpoint, method: init.method, body, query: parsed.search });
    assert.equal(parsed.origin, "https://androidpublisher.googleapis.com");
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, "error");
    if (init.method === "POST" && endpoint === "/edits")
      return response({ id: `own-${++editCounter}` });
    if (init.method === "GET" && /\/details$/.test(endpoint))
      return response({ defaultLanguage: "en-US" });
    if (init.method === "GET" && /\/listings$/.test(endpoint))
      return response({
        listings: [
          {
            language: "en-US",
            title: "Kaata",
            fullDescription:
              options.textDrift && tracks[0].releases[0].versionCodes[0] === "60"
                ? "changed"
                : "existing text",
          },
        ],
      });
    if (init.method === "GET" && /\/tracks$/.test(endpoint)) return response({ tracks });
    if (init.method === "GET" && endpoint.includes("/listings/en-US/")) {
      const type = endpoint.split("/").at(-1);
      const images = structuredClone(
        expectedImages.find((set) => set.type === type)?.images ??
          (type === "icon" ? [{ id: "icon-unchanged", sha256: "icon-hash" }] : []),
      );
      if (options.imageMismatch && type === "phoneScreenshots") images[0].sha256 = "different";
      return response({ images });
    }
    if (init.method === "GET" && endpoint.endsWith("/bundles"))
      return response({ bundles: [{ versionCode: options.usedCode ? 60 : 59 }] });
    if (init.method === "GET" && endpoint.endsWith("/apks")) return response({});
    if (init.method === "POST" && endpoint.endsWith("/bundles")) {
      assert.equal(parsed.searchParams.get("uploadType"), "media");
      assert.deepEqual(body, bytes);
      if (options.ambiguousUpload) throw new Error("private-mock-token must never appear");
      return response({
        versionCode: options.wrongCode ? 59 : 60,
        sha256: options.wrongHash ? "wrong" : sha256,
      });
    }
    if (init.method === "PUT" && /\/tracks\/(internal|production)$/.test(endpoint)) {
      const name = endpoint.split("/").at(-1);
      assert.equal(body.track, name);
      assert.equal(body.releases[0].status, "completed");
      assert.deepEqual(body.releases[0].versionCodes, ["60"]);
      tracks[tracks.findIndex((track) => track.track === name)] = structuredClone(body);
      if (options.closedTrackDrift && name === "production")
        tracks[2].releases[0].versionCodes = ["60"];
      return response(body);
    }
    if (init.method === "GET" && endpoint.endsWith("/tracks/internal"))
      return response(tracks.find((track) => track.track === "internal"));
    if (init.method === "POST" && endpoint.endsWith(":validate"))
      return response({ id: "own-1" }, options.validationFailure ? 400 : 200);
    if (init.method === "POST" && endpoint.endsWith(":commit")) {
      assert.equal(parsed.search, "?changesInReviewBehavior=ERROR_IF_IN_REVIEW");
      assert.equal(body, undefined);
      if (options.inReview)
        return response(
          { error: { details: [{ reason: "CHANGES_ALREADY_IN_REVIEW" }], message: token } },
          400,
        );
      if (options.ambiguousCommit) throw new Error(token);
      committed = true;
      return response({ id: "own-1" });
    }
    if (init.method === "GET" && /\/tracks\/(production|internal)\/releases$/.test(endpoint))
      return response({
        releases: [
          {
            releaseName: "2.2.1",
            activeArtifacts: [{ versionCode: committed ? 60 : 59 }],
            releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_IN_REVIEW",
          },
        ],
      });
    if (init.method === "DELETE" && endpoint === "/edits/own-2") return response(null, 204);
    throw new Error(`Unexpected request: ${init.method} ${endpoint}`);
  };
  return {
    calls,
    checkpoints,
    messages,
    fetchImpl,
    checkpoint: (value) => checkpoints.push(value),
    report: (value) => messages.push(value),
  };
}
const prepare = (transport, overrides = {}) =>
  prepareProduction(
    { app, aabPath, sha256, notes, expectedImages, token, ...overrides },
    transport,
  );
const writes = (transport, ending) =>
  transport.calls.filter((call) => call.method === "POST" && call.endpoint.endsWith(ending));

test("one upload stages internal, validates, then promotes production; preparation never commits", async () => {
  const transport = mock();
  const receipt = await prepare(transport);
  assert.equal(receipt.phase, "prepared");
  assert.equal(writes(transport, "/bundles").length, 1);
  assert.equal(writes(transport, ":commit").length, 0);
  const puts = transport.calls.filter((call) => call.method === "PUT");
  assert.deepEqual(
    puts.map((call) => call.endpoint),
    ["/edits/own-1/tracks/internal", "/edits/own-1/tracks/production"],
  );
  const stage = transport.calls.indexOf(puts[0]),
    promotion = transport.calls.indexOf(puts[1]);
  assert.ok(
    transport.calls.slice(stage + 1, promotion).some((call) => call.endpoint.endsWith(":validate")),
  );
  assert.ok(Object.values(receipt.checks).every(Boolean));
});

test("explicit commit verifies all stored state, guards review and deletes only its verification edit", async () => {
  const transport = mock();
  const receipt = await prepare(transport);
  const result = await commitProduction({ app, receipt, token }, transport);
  assert.equal(result.phase, "committed");
  assert.equal(writes(transport, ":commit").length, 1);
  assert.equal(result.verificationEditDeleted, true);
  assert.deepEqual(
    transport.calls.filter((call) => call.method === "DELETE").map((call) => call.endpoint),
    ["/edits/own-2"],
  );
  assert.ok(Object.values(result.verificationChecks).every(Boolean));
  assert.ok(!transport.messages.join("\n").includes(token));
});

for (const failure of ["wrongCode", "wrongHash", "ambiguousUpload", "usedCode", "imageMismatch"]) {
  test(`${failure} prevents track changes and never retries the upload`, async () => {
    const transport = mock({ [failure]: true });
    await assert.rejects(prepare(transport));
    assert.equal(transport.calls.filter((call) => call.method === "PUT").length, 0);
    assert.equal(writes(transport, ":commit").length, 0);
    assert.ok(writes(transport, "/bundles").length <= 1);
    assert.equal(transport.checkpoints.at(-1).phase, "prepare_failed");
    assert.ok(!JSON.stringify(transport.checkpoints).includes(token));
  });
}

for (const failure of ["textDrift", "closedTrackDrift", "validationFailure"]) {
  test(`${failure} prevents a prepared/committable release`, async () => {
    const transport = mock({ [failure]: true });
    await assert.rejects(prepare(transport));
    assert.equal(writes(transport, ":commit").length, 0);
    assert.equal(transport.checkpoints.at(-1).phase, "prepare_failed");
  });
}

for (const [failure, phase] of [
  ["inReview", "commit_refused"],
  ["ambiguousCommit", "commit_unknown"],
]) {
  test(`${failure} has one guarded attempt, no fallback, no second edit`, async () => {
    const transport = mock({ [failure]: true });
    const receipt = await prepare(transport);
    await assert.rejects(commitProduction({ app, receipt, token }, transport));
    assert.equal(writes(transport, ":commit").length, 1);
    assert.equal(writes(transport, "/edits").length, 1);
    assert.equal(transport.checkpoints.at(-1).phase, phase);
    assert.ok(!JSON.stringify(transport.checkpoints).includes(token));
    await assert.rejects(commitProduction({ app, receipt, token }, transport), /Receipt/);
    assert.equal(writes(transport, ":commit").length, 1);
  });
}

test("wrong app, changed AAB, invalid notes fail before network access", async () => {
  for (const overrides of [
    { app: { ...app, version: "2.1.1" } },
    { app: { ...app, android: { ...app.android, versionCode: 58 } } },
    { sha256: "0".repeat(64) },
    { notes: "Testing only" },
    { notes: "x".repeat(501) },
  ]) {
    const transport = mock();
    await assert.rejects(prepare(transport, overrides));
    assert.equal(transport.calls.length, 0);
  }
});

test("checked-in notes fit Play's limit and describe the production release", async () => {
  const releaseNotes = readFileSync(
    new URL("./release-notes/2.2.1-play.txt", import.meta.url),
    "utf8",
  ).trim();
  const transport = mock();
  const receipt = await prepare(transport, { notes: releaseNotes });
  assert.ok(releaseNotes.length <= 500);
  assert.equal(receipt.notes, releaseNotes);
});
