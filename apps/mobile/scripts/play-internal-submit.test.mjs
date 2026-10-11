import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { submitInternal } from "./play-internal-submit.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "kaata-internal-submit-test-"));
const aabPath = path.join(scratch, "fixture.aab");
const bytes = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("Mock Android bundle bytes"),
]);
writeFileSync(aabPath, bytes);
after(() => {
  rmSync(aabPath);
  rmdirSync(scratch);
});

const app = { version: "2.2.0", android: { package: "af.kaata.app", versionCode: 52 } };
const token = "mock-bearer-secret";
const production = {
  releases: [
    {
      releaseName: "2.1.1",
      activeArtifacts: [{ versionCode: 50 }],
      releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_IN_REVIEW",
    },
  ],
};
const internal = (code) => ({
  releases: [
    {
      releaseName: code >= 51 ? "2.2.0" : "2.1.1",
      activeArtifacts: [{ versionCode: code }],
      releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
    },
  ],
});
const response = (value, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(value), { status });

function mock(options = {}) {
  const calls = [];
  const messages = [];
  let committed = false;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ url, path: parsed.pathname, method: init.method, body });
    assert.equal(parsed.origin, "https://androidpublisher.googleapis.com");
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, "error");
    if (init.method === "GET" && parsed.pathname.endsWith("/tracks/production/releases")) {
      if (options.failProductionBefore && calls.length === 1) return response({}, 403);
      if (options.targetOnProduction) {
        return response({ releases: [{
          ...production.releases[0],
          activeArtifacts: [{ versionCode: 52 }],
        }] });
      }
      if (options.productionChanged && committed) {
        return response({
          releases: [
            {
              ...production.releases[0],
              releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
            },
          ],
        });
      }
      return response(production);
    }
    if (init.method === "GET" && parsed.pathname.endsWith("/tracks/internal/releases")) {
      return response(internal(committed || options.alreadyPublished ? 52 : 51));
    }
    if (init.method === "POST" && parsed.pathname.endsWith("/edits"))
      return response({ id: "own-edit-123" });
    if (init.method === "POST" && parsed.pathname.endsWith("/edits/own-edit-123/bundles")) {
      assert.equal(parsed.searchParams.get("uploadType"), "media");
      assert.equal(init.headers["Content-Type"], "application/octet-stream");
      assert.deepEqual(body, bytes);
      if (options.uploadError) return response({}, 400);
      return response({
        versionCode: options.wrongCode ? 51 : 52,
        sha256: options.wrongHash ? "bad-hash" : createHash("sha256").update(bytes).digest("hex"),
      });
    }
    if (init.method === "PUT" && parsed.pathname.endsWith("/edits/own-edit-123/tracks/internal")) {
      assert.equal(body.track, "internal");
      assert.deepEqual(body.releases[0].versionCodes, ["52"]);
      assert.equal(body.releases[0].status, "completed");
      return response(body);
    }
    if (init.method === "POST" && parsed.pathname.endsWith("/edits/own-edit-123:validate")) {
      assert.equal(init.body, undefined);
      return response({}, options.validateError ? 400 : 200);
    }
    if (init.method === "POST" && parsed.pathname.endsWith("/edits/own-edit-123:commit")) {
      assert.equal(parsed.searchParams.get("changesInReviewBehavior"), "ERROR_IF_IN_REVIEW");
      assert.equal(parsed.searchParams.size, 1);
      assert.equal(init.body, undefined);
      if (options.pendingRefusal) {
        return response(
          {
            error: {
              message: "Do not echo mock-bearer-secret",
              details: [{ reason: "CHANGES_ALREADY_IN_REVIEW" }],
            },
          },
          400,
        );
      }
      committed = true;
      return response({ id: "own-edit-123" });
    }
    if (init.method === "DELETE" && parsed.pathname.endsWith("/edits/own-edit-123"))
      return response(null, 204);
    throw new Error(`Unexpected mock request: ${init.method} ${parsed.pathname}`);
  };
  return { calls, messages, fetchImpl, report: (message) => messages.push(message) };
}

const run = (transport, overrides = {}) =>
  submitInternal({ app, aabPath, token, ...overrides }, transport);
const commits = (calls) => calls.filter((call) => new URL(call.url).pathname.endsWith(":commit"));
const deletes = (calls) => calls.filter((call) => call.method === "DELETE");

test("uploads the exact code 52 AAB despite older internal code 51, validates, and guards commit", async () => {
  const transport = mock();
  const result = await run(transport, {
    notes: "Private test build. Do not promote to production.",
  });
  assert.equal(result.committed, true);
  assert.deepEqual(result.productionBefore, result.productionAfter);
  assert.ok(result.internalAfter.some((release) => release.codes.includes("52")));
  assert.equal(transport.calls.filter((call) => call.method === "PUT").length, 1);
  assert.ok(
    transport.calls
      .filter((call) => call.method === "PUT")
      .every((call) => call.path.endsWith("/tracks/internal")),
  );
  assert.equal(commits(transport.calls).length, 1);
  assert.equal(deletes(transport.calls).length, 0);
  const put = transport.calls.find((call) => call.method === "PUT");
  assert.equal(
    put.body.releases[0].releaseNotes[0].text,
    "Private test build. Do not promote to production.",
  );
  const validateIndex = transport.calls.findIndex((call) => call.path.endsWith(":validate"));
  const commitIndex = transport.calls.findIndex((call) => call.path.endsWith(":commit"));
  assert.ok(validateIndex > 0 && commitIndex > validateIndex);
  assert.equal(
    transport.calls.filter(
      (call) => call.method === "GET" && call.path.endsWith("/tracks/production/releases"),
    ).length,
    2,
  );
  assert.ok(!transport.messages.join("\n").includes(token));
});

test("pending review refusal discards only its own edit, checks both tracks, and never falls back", async () => {
  const transport = mock({ pendingRefusal: true });
  await assert.rejects(run(transport), /CHANGES_ALREADY_IN_REVIEW/);
  assert.equal(commits(transport.calls).length, 1);
  assert.equal(deletes(transport.calls).length, 1);
  assert.ok(deletes(transport.calls)[0].path.endsWith("/own-edit-123"));
  assert.equal(
    transport.calls.filter((call) => call.method === "POST" && call.path.endsWith("/edits")).length,
    1,
  );
  assert.equal(transport.calls.filter((call) => call.method === "GET").length, 4);
  assert.ok(!transport.messages.join("\n").includes(token));
  assert.ok(transport.messages.some((message) => message.startsWith("Production after:")));
});

for (const [option, description] of [
  ["wrongCode", "mismatched uploaded version code"],
  ["wrongHash", "mismatched uploaded bundle SHA-256"],
  ["uploadError", "upload refusal"],
]) {
  test(`${description} discards the edit before any track update or commit`, async () => {
    const transport = mock({ [option]: true });
    await assert.rejects(run(transport));
    assert.equal(commits(transport.calls).length, 0);
    assert.equal(transport.calls.filter((call) => call.method === "PUT").length, 0);
    assert.equal(deletes(transport.calls).length, 1);
    assert.equal(transport.calls.filter((call) => call.method === "GET").length, 4);
  });
}

test("validation refusal deletes the edit and cannot reach commit", async () => {
  const transport = mock({ validateError: true });
  await assert.rejects(run(transport));
  assert.equal(commits(transport.calls).length, 0);
  assert.equal(deletes(transport.calls).length, 1);
});

test("an already published internal code 52 is idempotent and opens no edit", async () => {
  const transport = mock({ alreadyPublished: true });
  const result = await run(transport);
  assert.equal(result.alreadyPublished, true);
  assert.ok(transport.calls.every((call) => call.method === "GET"));
});

test("production cannot be inspected before upload: no edit is created", async () => {
  const transport = mock({ failProductionBefore: true });
  await assert.rejects(run(transport), /HTTP 403/);
  assert.ok(transport.calls.every((call) => call.method === "GET"));
});

test("code 52 already on production refuses before opening an edit", async () => {
  const transport = mock({ targetOnProduction: true });
  await assert.rejects(run(transport), /Code 52 already exists on production/);
  assert.ok(transport.calls.every((call) => call.method === "GET"));
});

test("production lifecycle drift after commit requires inspection and does not trigger another mutation", async () => {
  const transport = mock({ productionChanged: true });
  await assert.rejects(run(transport), /Production lifecycle changed/);
  assert.equal(commits(transport.calls).length, 1);
  assert.equal(deletes(transport.calls).length, 0);
  assert.ok(
    transport.messages.some((message) => message.includes("No production track write was made")),
  );
});

test("wrong app/package/build refuses before any Google request", async () => {
  for (const other of [
    { ...app, version: "2.1.1" },
    { ...app, android: { ...app.android, package: "af.other.app" } },
    { ...app, android: { ...app.android, versionCode: 51 } },
    { ...app, android: { ...app.android, versionCode: 53 } },
  ]) {
    const transport = mock();
    await assert.rejects(run(transport, { app: other }), /restricted/);
    assert.equal(transport.calls.length, 0);
  }
});

test("invalid or excessive notes refuse before Google requests", async () => {
  for (const notes of [" ", "x".repeat(501)]) {
    const transport = mock();
    await assert.rejects(run(transport, { notes }), /1–500/);
    assert.equal(transport.calls.length, 0);
  }
});

test("the upload fixture remains unchanged after tests", () => {
  assert.deepEqual(readFileSync(aabPath), bytes);
});
