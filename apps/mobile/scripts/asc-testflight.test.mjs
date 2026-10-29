// Node's test runner; every network request is replaced by an in-memory stub.
//   node --test scripts/asc-testflight.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { enableBuild, makeClient, parseArgs, setNotes, status } from "./asc-testflight.mjs";

const APP_ID = "6789651127";
const BUILD_ID = "test-build-46";
const GROUP_ID = "fcb33597-43b6-42ba-8582-b85d26fc3895";
const cfg = {
  appId: APP_ID,
  bundleId: "af.kaata.app",
  version: "2.3.0",
  buildNumber: "46",
  exemptEncryption: true,
};
const opts = {
  command: "enable",
  buildId: BUILD_ID,
  groupId: GROUP_ID,
  setExemptEncryption: false,
};
const notes = {
  buildId: BUILD_ID,
  text: readFileSync(
    new URL("./release-notes/2.3.0-testflight.txt", import.meta.url),
    "utf8",
  ).trim(),
};

function fixture(overrides = {}, options = opts, notesGrant = null) {
  const calls = [];
  const assigned = new Set(overrides.assigned ? [BUILD_ID] : []);
  let state = overrides.state ?? "READY_FOR_BETA_TESTING";
  const localizations = structuredClone(overrides.localizations ?? []);
  const build = {
    type: "builds",
    id: BUILD_ID,
    attributes: {
      version: "46",
      processingState: "VALID",
      expired: false,
      usesNonExemptEncryption: false,
      ...overrides.build,
    },
    relationships: {
      app: { data: { type: "apps", id: overrides.buildAppId ?? APP_ID } },
      preReleaseVersion: { data: { type: "preReleaseVersions", id: "train-2-3-0" } },
    },
  };
  const group = {
    type: "betaGroups",
    id: GROUP_ID,
    attributes: {
      name: "Team (Expo)",
      isInternalGroup: true,
      hasAccessToAllBuilds: false,
      ...overrides.group,
    },
    relationships: { app: { data: { type: "apps", id: overrides.groupAppId ?? APP_ID } } },
  };
  const train = {
    type: "preReleaseVersions",
    id: "train-2-3-0",
    attributes: { version: overrides.train ?? "2.3.0" },
  };
  const fetchImpl = async (url, init) => {
    const route = url.pathname.replace(/^\/v1/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, route, body });
    assert.equal(url.origin, "https://api.appstoreconnect.apple.com");
    assert.equal(init.redirect, "error");
    if (init.method === "POST" && route === "/betaBuildLocalizations") {
      const localization = { ...body.data, id: "english-notes-46" };
      localizations.push(localization);
      return Response.json({ data: localization }, { status: 201 });
    }
    if (init.method === "PATCH" && route.startsWith("/betaBuildLocalizations/")) {
      const localization = localizations.find((item) => item.id === body.data.id);
      assert(localization);
      Object.assign(localization.attributes, body.data.attributes);
      return Response.json({ data: localization });
    }
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
            id: "production-version-2-2-0",
            attributes: { versionString: "2.2.0", appStoreState: "READY_FOR_SALE" },
            relationships: { build: { data: { type: "builds", id: "production-build-39" } } },
          },
        ],
      });
    }
    if (route === `/apps/${APP_ID}/reviewSubmissions`)
      return Response.json({
        data: [
          {
            type: "reviewSubmissions",
            id: "completed-review-39",
            attributes: { state: "COMPLETE", submittedDate: "2026-10-16T14:32:56.952Z" },
          },
        ],
      });
    if (route === `/apps/${APP_ID}/betaGroups`) return Response.json({ data: [group] });
    if (route === `/builds`) return Response.json({ data: [build], included: [train] });
    if (route === `/builds/${BUILD_ID}`) return Response.json({ data: build, included: [train] });
    if (route === `/builds/${BUILD_ID}/betaBuildLocalizations`)
      return Response.json({ data: localizations });
    if (route === `/betaGroups/${GROUP_ID}`) return Response.json({ data: group });
    if (route === `/builds/${BUILD_ID}/buildBetaDetail`)
      return Response.json({
        data: {
          type: "buildBetaDetails",
          id: "detail-46",
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
  return {
    asc: makeClient(cfg, {
      fetchImpl,
      token: () => "test-token",
      enable: options,
      notes: notesGrant,
    }),
    calls,
  };
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
  assert.equal(
    parseArgs(["notes", "--build-id", BUILD_ID, "--notes-file", "notes.txt"]).command,
    "notes",
  );
  assert.throws(() => parseArgs(["notes", "--build-id", BUILD_ID]), /requires only/);
  assert.throws(
    () =>
      parseArgs([
        "notes",
        "--build-id",
        BUILD_ID,
        "--notes-file",
        "notes.txt",
        "--group-id",
        GROUP_ID,
      ]),
    /requires only/,
  );
  assert.throws(
    () =>
      parseArgs([
        "enable",
        "--build-id",
        BUILD_ID,
        "--group-id",
        GROUP_ID,
        "--notes-file",
        "notes.txt",
      ]),
    /requires the notes/,
  );
});

test("status reports released production and completed review and current TestFlight readiness without writes", async () => {
  const { asc, calls } = fixture({}, null);
  const result = await status(asc, cfg);
  assert.equal(result.testFlightUrl, `https://appstoreconnect.apple.com/apps/${APP_ID}/testflight`);
  assert(calls.every((c) => c.method === "GET"));
  assert.equal(result.production.versions[0].version, "2.2.0");
  assert.equal(result.production.versions[0].buildId, "production-build-39");
  assert.equal(result.production.reviews[0].id, "completed-review-39");
  assert.equal(result.production.reviews[0].state, "COMPLETE");
  assert.equal(result.target.internalBuildState, "READY_FOR_BETA_TESTING");
  assert.equal(result.target.groups[0].assigned, false);
  assert.equal(result.recentBuilds[0].version, "2.3.0");
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
  assert.equal(result.production.versions[0].state, "READY_FOR_SALE");
  assert.equal(result.production.reviews[0].id, "completed-review-39");
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

test("enable refuses a different local build number or a different internal group before requests", async () => {
  for (const buildNumber of ["39", "40", "41", "42", "43", "44", "45", "47", "", "forty"]) {
    const { asc, calls } = fixture();
    await assert.rejects(enableBuild(asc, { ...cfg, buildNumber }, opts), /restricted/);
    assert.equal(calls.length, 0);
  }
  const { asc, calls } = fixture();
  await assert.rejects(
    enableBuild(asc, cfg, { ...opts, groupId: "other-internal-group" }),
    /Team \(Expo\)/,
  );
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
      { data: { attributes: { versionString: "2.3.0" } } },
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
      { data: [{ type: "builds", id: "production-build-39" }] },
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

test("notes creates only English beta metadata for the verified test build, preserving production review", async () => {
  const { asc, calls } = fixture({}, null, notes);
  const result = await setNotes(asc, cfg, notes);
  assert.deepEqual(
    calls.filter((call) => call.method !== "GET"),
    [
      {
        method: "POST",
        route: "/betaBuildLocalizations",
        body: {
          data: {
            type: "betaBuildLocalizations",
            attributes: { locale: "en-US", whatsNew: notes.text },
            relationships: { build: { data: { type: "builds", id: BUILD_ID } } },
          },
        },
      },
    ],
  );
  assert.equal(result.locale, "en-US");
  assert.equal(result.localizationId, "english-notes-46");
  assert.equal(result.characters, notes.text.length);
  assert.equal(result.changed, true);
  assert.equal(result.production.versions[0].buildId, "production-build-39");
  assert.equal(result.production.reviews[0].state, "COMPLETE");
});

test("notes updates only the exact build's existing English localization and is idempotent", async () => {
  const english = {
    type: "betaBuildLocalizations",
    id: "english-notes-46",
    attributes: { locale: "en-US", whatsNew: "Old test notes" },
  };
  const otherLocale = {
    type: "betaBuildLocalizations",
    id: "other-language",
    attributes: { locale: "fr-FR", whatsNew: "Keep this" },
  };
  const { asc, calls } = fixture({ localizations: [english, otherLocale] }, null, notes);
  await setNotes(asc, cfg, notes);
  assert.deepEqual(
    calls.filter((call) => call.method !== "GET"),
    [
      {
        method: "PATCH",
        route: "/betaBuildLocalizations/english-notes-46",
        body: {
          data: {
            type: "betaBuildLocalizations",
            id: "english-notes-46",
            attributes: { whatsNew: notes.text },
          },
        },
      },
    ],
  );
  const second = await setNotes(asc, cfg, notes);
  assert.equal(second.changed, false);
  assert.equal(calls.filter((call) => call.method !== "GET").length, 1);
});

test("notes rejects unrelated builds, invalid readiness, ambiguous locales and invalid text before writes", async () => {
  for (const overrides of [
    { train: "2.1.1" },
    { build: { version: "30" } },
    { buildAppId: "another-app" },
    { bundleId: "other.bundle" },
    { build: { processingState: "PROCESSING" } },
    { build: { expired: true } },
    {
      localizations: [1, 2].map((n) => ({
        type: "betaBuildLocalizations",
        id: `duplicate-${n}`,
        attributes: { locale: "en-US" },
      })),
    },
  ]) {
    const { asc, calls } = fixture(overrides, null, notes);
    await assert.rejects(setNotes(asc, cfg, notes));
    assert(calls.every((call) => call.method === "GET"));
  }
  for (const invalid of [
    { ...cfg, version: "2.1.1" },
    { ...cfg, buildNumber: "39" },
    { ...cfg, buildNumber: "41" },
  ]) {
    const { asc, calls } = fixture({}, null, notes);
    await assert.rejects(setNotes(asc, invalid, notes));
    assert(calls.every((call) => call.method === "GET"));
  }
  const { asc, calls } = fixture({}, null, notes);
  for (const text of ["", " ", "x".repeat(4001)])
    await assert.rejects(setNotes(asc, cfg, { ...notes, text }));
  assert.equal(calls.length, 0);
});

test("notes capability cannot be granted to another local version or build", () => {
  for (const local of [
    { ...cfg, version: "2.2.0" },
    { ...cfg, buildNumber: "39" },
    { ...cfg, buildNumber: "41" },
  ])
    assert.throws(() => makeClient(local, { notes }), /exact 2\.3\.0 \/ 46/);
});

test("notes capability requires preflight and blocks unrelated IDs, changed payloads and App Store metadata", async () => {
  const english = {
    type: "betaBuildLocalizations",
    id: "english-notes-46",
    attributes: { locale: "en-US", whatsNew: "Old" },
  };
  const { asc, calls } = fixture({ localizations: [english] }, null, notes);
  const expected = {
    data: { type: "betaBuildLocalizations", id: english.id, attributes: { whatsNew: notes.text } },
  };
  await assert.rejects(asc("PATCH", `/betaBuildLocalizations/${english.id}`, expected), /Refusing/);
  assert.equal(calls.length, 0);
  await asc("GET", `/builds/${BUILD_ID}?include=app,preReleaseVersion`);
  await asc("GET", `/builds/${BUILD_ID}/betaBuildLocalizations?limit=200`);
  const before = calls.length;
  for (const [method, route, body] of [
    [
      "PATCH",
      "/betaBuildLocalizations/production-localization",
      { data: { ...expected.data, id: "production-localization" } },
    ],
    [
      "PATCH",
      `/betaBuildLocalizations/${english.id}`,
      { data: { ...expected.data, attributes: { whatsNew: "Unapproved replacement" } } },
    ],
    ["PATCH", "/appStoreVersionLocalizations/pending-version", expected],
    [
      "POST",
      "/betaBuildLocalizations",
      {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: "en-US", whatsNew: notes.text },
          relationships: { build: { data: { type: "builds", id: "production-build-39" } } },
        },
      },
    ],
    ["PATCH", "/reviewSubmissions/pending-review", { data: { attributes: { canceled: true } } }],
  ])
    await assert.rejects(asc(method, route, body), /Refusing/);
  assert.equal(calls.length, before);
});
