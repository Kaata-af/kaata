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

const app = { version: "2.3.0", android: { package: "af.kaata.app", versionCode: 79 } };
const token = "mock-bearer-secret";
const production = {
  releases: [
    {
      releaseName: "2.2.4",
      activeArtifacts: [{ versionCode: 73 }],
      releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
    },
  ],
};
const internal = (code) => ({
  releases: [
    {
      releaseName: `${code >= 75 ? "2.3.0" : "2.2.4"} (${code}) — internal testing`,
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
  let staged = null;
  const otherTracks = [
    {
      track: "production",
      releases: [{ name: "2.2.4", versionCodes: ["73"], status: "completed" }],
    },
    { track: "alpha", releases: [{ name: "2.0.0", versionCodes: ["43"], status: "completed" }] },
    { track: "beta" },
  ];
  const previousInternal = {
    track: "internal",
    releases: [
      { name: "2.3.0 (78) — internal testing", versionCodes: ["78"], status: "completed" },
    ],
  };
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
        return response({
          releases: [
            {
              ...production.releases[0],
              activeArtifacts: [{ versionCode: 79 }],
            },
          ],
        });
      }
      if (options.productionChanged && committed) {
        return response({
          releases: [
            {
              ...production.releases[0],
              releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_IN_REVIEW",
            },
          ],
        });
      }
      return response(production);
    }
    if (init.method === "GET" && parsed.pathname.endsWith("/tracks/internal/releases")) {
      return response(internal(committed || options.alreadyPublished ? 79 : 78));
    }
    if (init.method === "POST" && parsed.pathname.endsWith("/edits"))
      return response({ id: committed ? "verification-edit-456" : "own-edit-123" });
    if (init.method === "GET" && /\/edits\/[^/]+\/details$/.test(parsed.pathname))
      return response({ defaultLanguage: "en-US", contactEmail: "hello@example.invalid" });
    if (init.method === "GET" && /\/edits\/[^/]+\/listings$/.test(parsed.pathname))
      return response({
        listings: [
          {
            language: "en-US",
            title: "Kaata",
            fullDescription: options.listingDrift && staged ? "changed" : "existing description",
          },
        ],
      });
    if (init.method === "GET" && /\/edits\/[^/]+\/listings\/en-US\/[^/]+$/.test(parsed.pathname))
      return response({
        images: [
          {
            id: "existing-image",
            sha256:
              (options.imageDrift && staged) || (options.postCommitDrift && committed)
                ? "changed"
                : "existing-image-hash",
          },
        ],
      });
    if (init.method === "GET" && /\/edits\/[^/]+\/tracks$/.test(parsed.pathname)) {
      const preserved = structuredClone(otherTracks);
      if (options.closedTrackDrift && staged) preserved[1].releases[0].versionCodes = ["79"];
      return response({ tracks: [...preserved, staged ?? previousInternal] });
    }
    if (init.method === "GET" && parsed.pathname.endsWith("/edits/own-edit-123/bundles"))
      return response({
        bundles: [
          70,
          71,
          72,
          73,
          75,
          78,
          ...(options.usedCode ? [79] : []),
          ...(options.higherCode ? [80] : []),
        ].map((versionCode) => ({ versionCode })),
      });
    if (init.method === "GET" && parsed.pathname.endsWith("/edits/own-edit-123/apks"))
      return response({});
    if (init.method === "POST" && parsed.pathname.endsWith("/edits/own-edit-123/bundles")) {
      assert.equal(parsed.searchParams.get("uploadType"), "media");
      assert.equal(init.headers["Content-Type"], "application/octet-stream");
      assert.deepEqual(body, bytes);
      if (options.uploadError) return response({}, 400);
      if (options.ambiguousUpload) throw new Error(token);
      return response({
        versionCode: options.wrongCode ? 78 : 79,
        ...(options.missingHash
          ? {}
          : {
              sha256: options.wrongHash
                ? "bad-hash"
                : createHash("sha256").update(bytes).digest("hex"),
            }),
      });
    }
    if (init.method === "PUT" && parsed.pathname.endsWith("/edits/own-edit-123/tracks/internal")) {
      assert.equal(body.track, "internal");
      assert.deepEqual(body.releases[0].versionCodes, ["79"]);
      assert.equal(body.releases[0].status, "completed");
      staged = structuredClone(body);
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
      if (options.ambiguousCommit) throw new Error(token);
      // A gateway failure or malformed acknowledgement can follow an
      // applied commit. Lifecycle readbacks must never trigger another write.
      if (options.commitApplied) committed = true;
      if (options.commitStatus)
        return response({ error: { message: token } }, options.commitStatus);
      if (options.commitMalformedStatus)
        return new Response(`<html>${token}</html>`, { status: options.commitMalformedStatus });
      if (options.commitMalformedJson) return new Response("invalid-json", { status: 200 });
      if (options.commitEmpty) return response(null, 204);
      if (options.commitNull) return response(null);
      if (options.commitWrongId) return response({ id: "unrelated-edit-789" });
      committed = true;
      return response({ id: "own-edit-123" });
    }
    if (init.method === "DELETE" && parsed.pathname.endsWith("/edits/own-edit-123"))
      return response(null, 204);
    if (init.method === "DELETE" && parsed.pathname.endsWith("/edits/verification-edit-456"))
      return response(null, 204);
    throw new Error(`Unexpected mock request: ${init.method} ${parsed.pathname}`);
  };
  return { calls, messages, fetchImpl, report: (message) => messages.push(message) };
}

const run = (transport, overrides = {}) =>
  submitInternal({ app, aabPath, token, ...overrides }, transport);
const commits = (calls) => calls.filter((call) => new URL(call.url).pathname.endsWith(":commit"));
const deletes = (calls) => calls.filter((call) => call.method === "DELETE");
const lifecycleReads = (calls) =>
  calls.filter(
    (call) => call.method === "GET" && /\/tracks\/(production|internal)\/releases$/.test(call.path),
  );

test("uploads code 79 beside published production73/internal78 and older artifacts; preserves everything outside internal", async () => {
  const transport = mock();
  const result = await run(transport, {
    notes: "Private test build. Do not promote to production.",
  });
  assert.equal(result.committed, true);
  assert.deepEqual(result.productionBefore, result.productionAfter);
  assert.ok(
    transport.messages.some(
      (message) => message.startsWith("Internal before:") && message.includes('"78"'),
    ),
  );
  assert.ok(result.internalAfter.some((release) => release.codes.includes("79")));
  assert.ok(Object.values(result.preservationChecks).every(Boolean));
  assert.deepEqual(
    result.before.tracks.filter((track) => track.track !== "internal"),
    result.verified.tracks.filter((track) => track.track !== "internal"),
  );
  assert.equal(transport.calls.filter((call) => call.method === "PUT").length, 1);
  assert.ok(
    transport.calls
      .filter((call) => call.method === "PUT")
      .every((call) => call.path.endsWith("/tracks/internal")),
  );
  assert.equal(commits(transport.calls).length, 1);
  assert.equal(deletes(transport.calls).length, 1);
  assert.ok(deletes(transport.calls)[0].path.endsWith("/verification-edit-456"));
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

test("pending review refusal retains the attempted edit, checks both tracks, and never falls back", async () => {
  const transport = mock({ pendingRefusal: true });
  await assert.rejects(run(transport), /CHANGES_ALREADY_IN_REVIEW/);
  assert.equal(commits(transport.calls).length, 1);
  assert.equal(deletes(transport.calls).length, 0);
  assert.equal(
    transport.calls.filter((call) => call.method === "POST" && call.path.endsWith("/edits")).length,
    1,
  );
  assert.equal(lifecycleReads(transport.calls).length, 4);
  assert.ok(!transport.messages.join("\n").includes(token));
  assert.ok(transport.messages.some((message) => message.startsWith("Production after:")));
});

for (const [option, description] of [
  ["wrongCode", "old code 78 upload"],
  ["wrongHash", "mismatched uploaded bundle SHA-256"],
  ["missingHash", "missing uploaded bundle SHA-256"],
  ["uploadError", "upload refusal"],
  ["ambiguousUpload", "ambiguous upload failure"],
  ["usedCode", "already uploaded unassigned code 79"],
  ["higherCode", "newer existing artifact code 80"],
]) {
  test(`${description} discards the edit before any track update or commit`, async () => {
    const transport = mock({ [option]: true });
    await assert.rejects(run(transport));
    assert.equal(commits(transport.calls).length, 0);
    assert.equal(transport.calls.filter((call) => call.method === "PUT").length, 0);
    assert.equal(deletes(transport.calls).length, 1);
    assert.equal(lifecycleReads(transport.calls).length, 4);
    assert.ok(!transport.messages.join("\n").includes(token));
  });
}

test("validation refusal deletes the edit and cannot reach commit", async () => {
  const transport = mock({ validateError: true });
  await assert.rejects(run(transport));
  assert.equal(commits(transport.calls).length, 0);
  assert.equal(deletes(transport.calls).length, 1);
});

for (const option of ["listingDrift", "imageDrift", "closedTrackDrift"]) {
  test(`${option} stops before commit and never writes a non-internal destination`, async () => {
    const transport = mock({ [option]: true });
    await assert.rejects(run(transport), /preservation check failed/);
    assert.equal(commits(transport.calls).length, 0);
    assert.ok(
      transport.calls
        .filter((call) => call.method === "PUT")
        .every((call) => call.path.endsWith("/tracks/internal")),
    );
    assert.deepEqual(
      deletes(transport.calls).map((call) => call.path.split("/").at(-1)),
      ["own-edit-123"],
    );
  });
}

test("ambiguous commit has one guarded attempt and no retry or alternate track", async () => {
  const transport = mock({ ambiguousCommit: true });
  await assert.rejects(run(transport), /no automatic retry/);
  assert.equal(commits(transport.calls).length, 1);
  assert.equal(deletes(transport.calls).length, 0);
  assert.equal(lifecycleReads(transport.calls).length, 4);
  assert.equal(
    transport.calls.filter((call) => call.method === "POST" && call.path.endsWith("/edits")).length,
    1,
  );
  assert.ok(!transport.messages.join("\n").includes(token));
});

for (const [description, options] of [
  ["HTTP 400", { commitStatus: 400 }],
  ["HTTP 408", { commitStatus: 408 }],
  ["HTTP 500 after Google applied the commit", { commitStatus: 500, commitApplied: true }],
  ["HTTP 503", { commitStatus: 503 }],
  [
    "malformed HTTP 502 after an applied commit",
    { commitMalformedStatus: 502, commitApplied: true },
  ],
  ["malformed successful JSON", { commitMalformedJson: true, commitApplied: true }],
  ["empty HTTP 204", { commitEmpty: true, commitApplied: true }],
  ["null successful JSON", { commitNull: true }],
  ["wrong acknowledged edit ID", { commitWrongId: true }],
]) {
  test(`${description} has one guarded commit and no original-edit cleanup or retry`, async () => {
    const transport = mock(options);
    await assert.rejects(run(transport), (error) => {
      assert.ok(!error.message.includes(token));
      return true;
    });
    assert.equal(commits(transport.calls).length, 1);
    assert.equal(deletes(transport.calls).length, 0);
    assert.equal(lifecycleReads(transport.calls).length, 4);
    assert.equal(
      transport.calls.filter((call) => call.method === "POST" && call.path.endsWith("/edits"))
        .length,
      1,
    );
    assert.equal(
      transport.calls.filter((call) => call.method === "POST" && call.path.endsWith("/bundles"))
        .length,
      1,
    );
    assert.ok(
      transport.messages.some((message) => message.includes("no edit cleanup or submission retry")),
    );
    assert.ok(!transport.messages.join("\n").includes(token));
  });
}

test("post-commit drift is reported after verification cleanup without a second upload or commit", async () => {
  const transport = mock({ postCommitDrift: true });
  await assert.rejects(run(transport), /preservation check failed/);
  assert.equal(commits(transport.calls).length, 1);
  assert.equal(
    transport.calls.filter((call) => call.method === "POST" && call.path.endsWith("/bundles"))
      .length,
    1,
  );
  assert.deepEqual(
    deletes(transport.calls).map((call) => call.path.split("/").at(-1)),
    ["verification-edit-456"],
  );
});

test("an already published internal code 79 is idempotent and opens no edit", async () => {
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

test("code 79 already on production refuses before opening an edit", async () => {
  const transport = mock({ targetOnProduction: true });
  await assert.rejects(run(transport), /Code 79 already exists on production/);
  assert.ok(transport.calls.every((call) => call.method === "GET"));
});

test("production lifecycle drift after commit requires inspection and does not trigger another mutation", async () => {
  const transport = mock({ productionChanged: true });
  await assert.rejects(run(transport), /Production lifecycle changed/);
  assert.equal(commits(transport.calls).length, 1);
  assert.equal(deletes(transport.calls).length, 1);
  assert.ok(deletes(transport.calls)[0].path.endsWith("/verification-edit-456"));
  assert.ok(
    transport.messages.some((message) => message.includes("No production track write was made")),
  );
});

test("wrong app/package/build refuses before any Google request", async () => {
  for (const other of [
    { ...app, version: "2.2.4" },
    { ...app, android: { ...app.android, package: "af.other.app" } },
    { ...app, android: { ...app.android, versionCode: 70 } },
    { ...app, android: { ...app.android, versionCode: 71 } },
    { ...app, android: { ...app.android, versionCode: 72 } },
    { ...app, android: { ...app.android, versionCode: 73 } },
    { ...app, android: { ...app.android, versionCode: 75 } },
    { ...app, android: { ...app.android, versionCode: 78 } },
    { ...app, android: { ...app.android, versionCode: 80 } },
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

test("the checked-in internal testing notes fit Play's limit and attach only to code 79", async () => {
  const notes = readFileSync(
    new URL("./release-notes/2.3.0-internal.txt", import.meta.url),
    "utf8",
  ).trim();
  assert.ok(notes.length > 0 && notes.length <= 500);
  const transport = mock();
  await run(transport, { notes });
  const put = transport.calls.find((call) => call.method === "PUT");
  assert.deepEqual(put.body.releases[0].versionCodes, ["79"]);
  assert.deepEqual(put.body.releases[0].releaseNotes, [{ language: "en-US", text: notes }]);
});

test("the upload fixture remains unchanged after tests", () => {
  assert.deepEqual(readFileSync(aabPath), bytes);
});
