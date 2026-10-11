// Node's test runner; every network request is replaced by an in-memory stub.
//   node --test scripts/asc-testflight.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { enableBuild, makeClient, parseArgs, status } from "./asc-testflight.mjs";

const APP_ID = "6789651127";
const BUILD_ID = "test-build-31";
const GROUP_ID = "internal-testers";
const cfg = {
  appId: APP_ID,
  bundleId: "af.kaata.app",
  version: "2.2.0",
  buildNumber: "31",
  exemptEncryption: true,
};
const opts = {
  command: "enable",
  buildId: BUILD_ID,
  groupId: GROUP_ID,
  setExemptEncryption: false,
};

function fixture(overrides = {}, options = opts) {
  const calls = [];
  const assigned = new Set(overrides.assigned ? [BUILD_ID] : []);
  let state = overrides.state ?? "READY_FOR_BETA_TESTING";
  const build = {
    type: "builds",
    id: BUILD_ID,
    attributes: {
      version: "31",
      processingState: "VALID",
      expired: false,
      usesNonExemptEncryption: false,
      ...overrides.build,
    },
    relationships: {
      app: { data: { type: "apps", id: overrides.buildAppId ?? APP_ID } },
      preReleaseVersion: { data: { type: "preReleaseVersions", id: "train-2-2-0" } },
    },
  };
  const group = {
    type: "betaGroups",
    id: GROUP_ID,
    attributes: {
      name: "Kaata Internal",
      isInternalGroup: true,
      hasAccessToAllBuilds: false,
      ...overrides.group,
    },
    relationships: { app: { data: { type: "apps", id: overrides.groupAppId ?? APP_ID } } },
  };
  const train = {
    type: "preReleaseVersions",
    id: "train-2-2-0",
    attributes: { version: overrides.train ?? "2.2.0" },
  };
  const fetchImpl = async (url, init) => {
    const route = url.pathname.replace(/^\/v1/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, route, body });
    assert.equal(url.origin, "https://api.appstoreconnect.apple.com");
    assert.equal(init.redirect, "error");
    if (init.method === "POST" && route === `/betaGroups/${GROUP_ID}/relationships/builds`) {
      assigned.add(body.data[0].id);
      state = "IN_BETA_TESTING";
      return new Response(null, { status: 204 });
    }
    if (init.method === "PATCH" && route === `/builds/${BUILD_ID}`) {
      build.attributes.usesNonExemptEncryption = false;
      state = "READY_FOR_BETA_TESTING";
      return Response.json({ data: build });
    }
    assert.equal(init.method, "GET", `Unexpected mutation: ${route}`);
    if (route === `/apps/${APP_ID}`)
      return Response.json({
        data: {
          type: "apps",
          id: APP_ID,
          attributes: { bundleId: overrides.bundleId ?? "af.kaata.app" },
        },
      });
    if (route === `/apps/${APP_ID}/appStoreVersions`) {
      assert.equal(
        url.searchParams.get("include"),
        "build",
        "Snapshots must request the attached build relationship.",
      );
      return Response.json({
        data: [
          {
            type: "appStoreVersions",
            id: "pending-version",
            attributes: { versionString: "2.1.1", appStoreState: "WAITING_FOR_REVIEW" },
            relationships: { build: { data: { type: "builds", id: "production-build-30" } } },
          },
        ],
      });
    }
    if (route === `/apps/${APP_ID}/reviewSubmissions`)
      return Response.json({
        data: [
          {
            type: "reviewSubmissions",
            id: "pending-review",
            attributes: { state: "WAITING_FOR_REVIEW", submittedDate: "2026-10-10T00:00:00Z" },
          },
        ],
      });
    if (route === `/apps/${APP_ID}/betaGroups`) return Response.json({ data: [group] });
    if (route === `/builds`) return Response.json({ data: [build], included: [train] });
    if (route === `/builds/${BUILD_ID}`) return Response.json({ data: build, included: [train] });
    if (route === `/betaGroups/${GROUP_ID}`) return Response.json({ data: group });
    if (route === `/builds/${BUILD_ID}/buildBetaDetail`)
      return Response.json({
        data: {
          type: "buildBetaDetails",
          id: "detail-31",
          attributes: {
            internalBuildState: state,
            externalBuildState: "READY_FOR_BETA_SUBMISSION",
            autoNotifyEnabled: false,
          },
        },
      });
    if (route === `/betaGroups/${GROUP_ID}/relationships/builds`)
      return Response.json({ data: [...assigned].map((id) => ({ type: "builds", id })) });
    throw new Error(`Unexpected test request: ${init.method} ${route}`);
  };
  return { asc: makeClient(cfg, { fetchImpl, token: () => "test-token", enable: options }), calls };
}

test("the default command is read-only; enable needs both exact resource IDs", () => {
  assert.equal(parseArgs([]).command, "status");
  assert.equal(parseArgs(["--status"]).command, "status");
  assert.throws(() => parseArgs(["enable", "--build-id", BUILD_ID]), /requires/);
  assert.throws(() => parseArgs(["--set-exempt-encryption"]), /explicit enable/);
  assert.throws(() => parseArgs(["--build-id", BUILD_ID]), /explicit enable/);
  assert.throws(
    () => parseArgs(["enable", "--build-id", "../reviews", "--group-id", GROUP_ID]),
    /resource ID/,
  );
  assert.throws(() => parseArgs(["--supersede"]), /Unknown/);
});

test("status reports pending production review and current TestFlight readiness without writes", async () => {
  const { asc, calls } = fixture({}, null);
  const result = await status(asc, cfg);
  assert.equal(result.testFlightUrl, `https://appstoreconnect.apple.com/apps/${APP_ID}/testflight`);
  assert(calls.every((c) => c.method === "GET"));
  assert.equal(result.production.versions[0].version, "2.1.1");
  assert.equal(result.production.versions[0].buildId, "production-build-30");
  assert.equal(result.production.reviews[0].id, "pending-review");
  assert.equal(result.target.internalBuildState, "READY_FOR_BETA_TESTING");
  assert.equal(result.target.groups[0].assigned, false);
  assert.equal(result.recentBuilds[0].version, "2.2.0");
});

test("enable associates only the verified new build to an existing internal group", async () => {
  const { asc, calls } = fixture();
  const result = await enableBuild(asc, cfg, opts);
  assert.equal(result.testFlightUrl, `https://appstoreconnect.apple.com/apps/${APP_ID}/testflight`);
  const writes = calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes, [
    {
      method: "POST",
      route: `/betaGroups/${GROUP_ID}/relationships/builds`,
      body: { data: [{ type: "builds", id: BUILD_ID }] },
    },
  ]);
  assert.equal(result.assigned, true);
  assert.equal(result.internalBuildState, "IN_BETA_TESTING");
  assert.equal(result.production.versions[0].state, "WAITING_FOR_REVIEW");
  assert.equal(result.production.reviews[0].id, "pending-review");
});

test("existing assignment and automatic group access are idempotent, with no writes", async () => {
  for (const overrides of [
    { assigned: true, state: "IN_BETA_TESTING" },
    { group: { hasAccessToAllBuilds: true }, state: "IN_BETA_TESTING" },
  ]) {
    const { asc, calls } = fixture(overrides);
    const result = await enableBuild(asc, cfg, opts);
    assert(calls.every((c) => c.method === "GET"));
    assert(result.assigned || result.accessToAllBuilds);
  }
});

test("wrong train, wrong number, invalid processing, expired build and unrelated groups refuse all writes", async () => {
  for (const overrides of [
    { train: "2.1.1" },
    { build: { version: "30" } },
    { build: { processingState: "PROCESSING" } },
    { build: { expired: true } },
    { buildAppId: "another-app" },
    { groupAppId: "another-app" },
    { group: { isInternalGroup: false } },
    { bundleId: "other.bundle" },
    { state: "MISSING_EXPORT_COMPLIANCE" },
  ]) {
    const { asc, calls } = fixture(overrides);
    await assert.rejects(enableBuild(asc, cfg, opts));
    assert(
      calls.every((c) => c.method === "GET"),
      JSON.stringify(overrides),
    );
  }
  const { asc, calls } = fixture();
  await assert.rejects(enableBuild(asc, { ...cfg, version: "2.1.1" }, opts), /restricted/);
  assert.equal(calls.length, 0);
});

test("unset encryption is patched to the existing exemption only with the explicit option", async () => {
  const exemptOpts = { ...opts, setExemptEncryption: true };
  const { asc, calls } = fixture(
    { build: { usesNonExemptEncryption: null }, state: "MISSING_EXPORT_COMPLIANCE" },
    exemptOpts,
  );
  await enableBuild(asc, cfg, exemptOpts);
  const writes = calls.filter((c) => c.method !== "GET");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], {
    method: "PATCH",
    route: `/builds/${BUILD_ID}`,
    body: {
      data: { type: "builds", id: BUILD_ID, attributes: { usesNonExemptEncryption: false } },
    },
  });
  for (const localCfg of [cfg, { ...cfg, exemptEncryption: false }]) {
    const { asc: client, calls: attempted } = fixture(
      { build: { usesNonExemptEncryption: true } },
      exemptOpts,
    );
    await assert.rejects(enableBuild(client, localCfg, exemptOpts), /override/);
    assert(attempted.every((c) => c.method === "GET"));
  }
});

test("client rejects every production/review write, unrelated beta targets, destructive build updates and foreign URLs", async () => {
  let fetches = 0;
  const asc = makeClient(cfg, {
    fetchImpl: async () => {
      fetches++;
      throw new Error("Should never reach fetch");
    },
    token: () => "test-token",
    enable: { ...opts, setExemptEncryption: true },
  });
  for (const [method, endpoint, body] of [
    ["POST", "/appStoreVersions", { data: {} }],
    [
      "PATCH",
      "/appStoreVersions/pending-version",
      { data: { attributes: { versionString: "2.2.0" } } },
    ],
    ["PATCH", "/reviewSubmissions/pending-review", { data: { attributes: { canceled: true } } }],
    ["POST", "/reviewSubmissionItems", { data: {} }],
    [
      "POST",
      `/betaGroups/other-group/relationships/builds`,
      { data: [{ type: "builds", id: BUILD_ID }] },
    ],
    [
      "POST",
      `/betaGroups/${GROUP_ID}/relationships/builds`,
      { data: [{ type: "builds", id: "production-build-30" }] },
    ],
    [
      "PATCH",
      `/builds/${BUILD_ID}`,
      { data: { type: "builds", id: BUILD_ID, attributes: { expired: true } } },
    ],
    ["GET", "https://other.invalid/v1/builds"],
    ["GET", "https://api.appstoreconnect.apple.com/v2/builds"],
    ["GET", `https://secret@api.appstoreconnect.apple.com/v1/builds`],
  ])
    await assert.rejects(asc(method, endpoint, body), /Refusing/);
  assert.equal(fetches, 0);
});

test("read-only client has no mutation grant and server failures never print a response body", async () => {
  let fetches = 0;
  const asc = makeClient(cfg, {
    fetchImpl: async () => {
      fetches++;
      return new Response("SENSITIVE_SERVER_BODY", { status: 403 });
    },
    token: () => "SENSITIVE_TOKEN",
  });
  await assert.rejects(
    asc("POST", `/betaGroups/${GROUP_ID}/relationships/builds`, {
      data: [{ type: "builds", id: BUILD_ID }],
    }),
    /Refusing/,
  );
  assert.equal(fetches, 0);
  await assert.rejects(asc("GET", "/builds"), (err) => {
    assert.match(err.message, /HTTP 403/);
    assert(!err.message.includes("SENSITIVE"));
    return true;
  });
});
