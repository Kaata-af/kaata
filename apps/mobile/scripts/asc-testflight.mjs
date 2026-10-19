#!/usr/bin/env node
// TestFlight only. Default/status reads ASC; enable adds the exact 2.2.3 / 40 build
// to an EXISTING internal group. App Store versions and reviews are read-only.
//
//   node scripts/asc-testflight.mjs
//   node scripts/asc-testflight.mjs enable --build-id <ASC-build-id> --group-id <group-id>
//   node scripts/asc-testflight.mjs enable --build-id <ASC-build-id> --group-id <group-id> --set-exempt-encryption
//   node scripts/asc-testflight.mjs notes --build-id <ASC-build-id> --notes-file scripts/release-notes/2.2.3-testflight.txt
//
// --build-id is Apple's build resource ID, not the EAS build ID. The optional
// encryption flag applies app.json's existing false exemption ONLY when Apple's
// value is unset. It never overrides a declaration of non-exempt encryption.
// Credentials come from submit.testing in eas.json and are never printed.
// notes changes only English TestFlight beta-build metadata, never App Store text.

import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.appstoreconnect.apple.com/v1";
const KAATA_APP_ID = "6789651127";
const KAATA_BUNDLE_ID = "af.kaata.app";
const TEST_VERSION = "2.2.3";
const TEST_BUILD_NUMBER = "40";
const TEST_GROUP_ID = "fcb33597-43b6-42ba-8582-b85d26fc3895";
const ID = /^[A-Za-z0-9-]+$/;

export function parseArgs(argv) {
  const opts = { command: "status", setExemptEncryption: false };
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["status", "--status", "enable", "notes"].includes(arg)) {
      if (commandSeen) throw new Error("Choose one command: status, enable or notes.");
      opts.command = arg === "--status" ? "status" : arg;
      commandSeen = true;
    } else if (arg === "--build-id" || arg === "--group-id") {
      const value = argv[++i];
      if (!value || !ID.test(value)) throw new Error(`${arg} needs an ASC resource ID.`);
      const field = arg === "--build-id" ? "buildId" : "groupId";
      if (opts[field]) throw new Error(`${arg} was supplied twice.`);
      opts[field] = value;
    } else if (arg === "--notes-file") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--notes-file needs a path.");
      if (opts.notesFile) throw new Error("--notes-file was supplied twice.");
      opts.notesFile = value;
    } else if (arg === "--set-exempt-encryption") opts.setExemptEncryption = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.help) return opts;
  if (opts.command === "enable" && (!opts.buildId || !opts.groupId)) {
    throw new Error("enable requires --build-id and --group-id.");
  }
  if (
    opts.command === "status" &&
    (opts.buildId || opts.groupId || opts.setExemptEncryption || opts.notesFile)
  ) {
    throw new Error("Build/group/encryption options require the explicit enable command.");
  }
  if (opts.command === "enable" && opts.notesFile)
    throw new Error("--notes-file requires the notes command.");
  if (
    opts.command === "notes" &&
    (!opts.buildId || !opts.notesFile || opts.groupId || opts.setExemptEncryption)
  ) {
    throw new Error(
      "notes requires only --build-id and --notes-file; group/encryption options are not allowed.",
    );
  }
  return opts;
}

function assertTestBuild(cfg, buildId, result) {
  if (cfg.version !== TEST_VERSION || cfg.buildNumber !== TEST_BUILD_NUMBER)
    throw new Error("Local configuration must be 2.2.3 / iOS build 40.");
  const build = result.data;
  if (
    build?.type !== "builds" ||
    build.id !== buildId ||
    build.relationships?.app?.data?.id !== cfg.appId
  )
    throw new Error("Build does not belong to Kaata's ASC app.");
  if (build.attributes?.version !== cfg.buildNumber || trainFor(result, build) !== TEST_VERSION)
    throw new Error("Build number or 2.2.3 version train does not match app.json.");
  if (build.attributes.processingState !== "VALID" || build.attributes.expired !== false)
    throw new Error("Build must be VALID and unexpired before changing TestFlight.");
  return build;
}

function assertNoteText(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 4000)
    throw new Error("TestFlight notes must contain 1–4000 characters.");
}

function readConfig() {
  const app = JSON.parse(readFileSync(path.join(MOBILE_DIR, "app.json"), "utf8")).expo;
  const ios = JSON.parse(readFileSync(path.join(MOBILE_DIR, "eas.json"), "utf8")).submit?.testing
    ?.ios;
  for (const key of ["ascApiKeyPath", "ascApiKeyId", "ascApiKeyIssuerId", "ascAppId"]) {
    if (!ios?.[key]) throw new Error(`eas.json submit.testing.ios is missing ${key}.`);
  }
  if (ios.ascAppId !== KAATA_APP_ID || app.ios?.bundleIdentifier !== KAATA_BUNDLE_ID) {
    throw new Error("Refusing a project that does not match Kaata's existing ASC app.");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(
      readFileSync(path.resolve(MOBILE_DIR, ios.ascApiKeyPath), "utf8"),
    );
  } catch {
    throw new Error("Cannot read the existing ASC API key configured in submit.testing.");
  }
  return {
    appId: ios.ascAppId,
    bundleId: app.ios.bundleIdentifier,
    version: app.version,
    buildNumber: String(app.ios.buildNumber ?? ""),
    exemptEncryption: app.ios.infoPlist?.ITSAppUsesNonExemptEncryption === false,
    keyId: ios.ascApiKeyId,
    issuerId: ios.ascApiKeyIssuerId,
    privateKey,
  };
}

function makeToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: cfg.keyId, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ iss: cfg.issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }),
  ).toString("base64url");
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign({ key: cfg.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

// Every request passes this gate, including pagination links. Mutation grants
// pin both target IDs and the entire payload; no generic ASC writer is exposed.
export function makeClient(
  cfg,
  { fetchImpl = fetch, token = () => makeToken(cfg), enable = null, notes = null } = {},
) {
  if (cfg.appId !== KAATA_APP_ID) throw new Error("Unexpected ASC app ID.");
  if (enable && notes) throw new Error("Choose one TestFlight mutation capability.");
  if (notes) {
    if (
      !ID.test(notes.buildId) ||
      cfg.version !== TEST_VERSION ||
      cfg.buildNumber !== TEST_BUILD_NUMBER
    )
      throw new Error("Notes require the exact 2.2.3 / 40 test build.");
    assertNoteText(notes.text);
  }
  let notesBuildVerified = false;
  let notesListRead = false;
  const englishLocalizationIds = new Set();
  return async function asc(method, endpoint, body) {
    const url = new URL(endpoint.startsWith("/") ? API + endpoint : endpoint);
    if (url.origin !== new URL(API).origin || url.username || url.password || url.hash) {
      throw new Error("Refusing an ASC URL outside the API allowlist.");
    }
    const route = url.pathname.replace(/^\/v1(?=\/)/, "");
    const appRoute = new RegExp(
      `^/apps/${KAATA_APP_ID}(?:/(?:appStoreVersions|reviewSubmissions|betaGroups))?$`,
    );
    const readRoute =
      /^(?:\/builds(?:\/[A-Za-z0-9-]+(?:\/(?:buildBetaDetail|betaBuildLocalizations))?)?|\/betaGroups\/[A-Za-z0-9-]+(?:\/(?:builds|relationships\/builds))?)$/;
    const betaBody = { data: [{ type: "builds", id: enable?.buildId }] };
    const encryptionBody = {
      data: { type: "builds", id: enable?.buildId, attributes: { usesNonExemptEncryption: false } },
    };
    const readAllowed =
      method === "GET" && body === undefined && (appRoute.test(route) || readRoute.test(route));
    const addAllowed =
      enable &&
      ID.test(enable.buildId) &&
      ID.test(enable.groupId) &&
      method === "POST" &&
      !url.search &&
      route === `/betaGroups/${enable.groupId}/relationships/builds` &&
      JSON.stringify(body) === JSON.stringify(betaBody);
    const exemptionAllowed =
      enable?.setExemptEncryption &&
      cfg.exemptEncryption &&
      method === "PATCH" &&
      !url.search &&
      route === `/builds/${enable.buildId}` &&
      JSON.stringify(body) === JSON.stringify(encryptionBody);
    const createNotesBody = {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale: "en-US", whatsNew: notes?.text },
        relationships: { build: { data: { type: "builds", id: notes?.buildId } } },
      },
    };
    const localizationId = route.match(/^\/betaBuildLocalizations\/([A-Za-z0-9-]+)$/)?.[1];
    const updateNotesBody = {
      data: {
        type: "betaBuildLocalizations",
        id: localizationId,
        attributes: { whatsNew: notes?.text },
      },
    };
    const notesAllowed =
      notes &&
      notesBuildVerified &&
      notesListRead &&
      !url.search &&
      ((method === "POST" &&
        route === "/betaBuildLocalizations" &&
        englishLocalizationIds.size === 0 &&
        JSON.stringify(body) === JSON.stringify(createNotesBody)) ||
        (method === "PATCH" &&
          englishLocalizationIds.has(localizationId) &&
          JSON.stringify(body) === JSON.stringify(updateNotesBody)));
    if (
      !url.pathname.startsWith("/v1/") ||
      !(readAllowed || addAllowed || exemptionAllowed || notesAllowed)
    ) {
      throw new Error(`Refusing non-allowlisted ASC operation: ${method} ${url.pathname}`);
    }
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    // Never print a server body: it can contain account metadata or secrets.
    if (!res.ok) throw new Error(`ASC ${method} ${url.pathname} failed (HTTP ${res.status}).`);
    if (res.status === 204) return null;
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`ASC ${method} ${url.pathname} returned invalid JSON.`);
    }
    if (notes && method === "GET" && route === `/builds/${notes.buildId}`) {
      assertTestBuild(cfg, notes.buildId, json);
      notesBuildVerified = true;
    }
    if (
      notes &&
      notesBuildVerified &&
      method === "GET" &&
      route === `/builds/${notes.buildId}/betaBuildLocalizations`
    ) {
      if (!Array.isArray(json?.data)) throw new Error("ASC beta-localization list is invalid.");
      notesListRead = true;
      for (const item of json.data) {
        if (
          item.type === "betaBuildLocalizations" &&
          item.attributes?.locale === "en-US" &&
          ID.test(item.id)
        )
          englishLocalizationIds.add(item.id);
      }
    }
    return json;
  };
}

async function listAll(asc, endpoint) {
  const data = [];
  const visited = new Set();
  let next = endpoint;
  while (next) {
    if (visited.has(next) || visited.size >= 100) throw new Error("Invalid ASC pagination.");
    visited.add(next);
    const result = await asc("GET", next);
    if (!Array.isArray(result?.data)) throw new Error("ASC list response has no data array.");
    data.push(...result.data);
    next = result.links?.next;
  }
  return data;
}

export async function productionSnapshot(asc, cfg) {
  const [versions, reviews] = await Promise.all([
    listAll(
      asc,
      `/apps/${cfg.appId}/appStoreVersions?filter[platform]=IOS&include=build&limit=200`,
    ),
    listAll(asc, `/apps/${cfg.appId}/reviewSubmissions?filter[platform]=IOS&limit=200`),
  ]);
  return {
    versions: versions.map((v) => ({
      id: v.id,
      version: v.attributes.versionString,
      state: v.attributes.appStoreState,
      buildId: v.relationships?.build?.data?.id ?? null,
    })),
    reviews: reviews.map((s) => ({
      id: s.id,
      state: s.attributes.state,
      submittedDate: s.attributes.submittedDate ?? null,
    })),
  };
}

function trainFor(result, build) {
  const id = build.relationships?.preReleaseVersion?.data?.id;
  return (
    result.included?.find((r) => r.type === "preReleaseVersions" && r.id === id)?.attributes
      ?.version ?? null
  );
}

export async function status(asc, cfg) {
  const [snapshot, recent, groups, targets] = await Promise.all([
    productionSnapshot(asc, cfg),
    asc(
      "GET",
      `/builds?filter[app]=${cfg.appId}&sort=-uploadedDate&limit=10&include=preReleaseVersion`,
    ),
    listAll(asc, `/apps/${cfg.appId}/betaGroups?limit=200`),
    asc(
      "GET",
      `/builds?filter[app]=${cfg.appId}&filter[version]=${encodeURIComponent(cfg.buildNumber)}&include=preReleaseVersion&limit=200`,
    ),
  ]);
  const target = targets.data?.find((b) => trainFor(targets, b) === cfg.version);
  let targetStatus = null;
  if (target) {
    const [detail, assignments] = await Promise.all([
      asc("GET", `/builds/${target.id}/buildBetaDetail`),
      Promise.all(
        groups.map(async (group) => {
          const builds = await listAll(
            asc,
            `/betaGroups/${group.id}/relationships/builds?limit=200`,
          );
          return {
            groupId: group.id,
            name: group.attributes.name,
            internal: group.attributes.isInternalGroup,
            accessToAllBuilds: group.attributes.hasAccessToAllBuilds,
            assigned: builds.some((b) => b.id === target.id),
          };
        }),
      ),
    ]);
    targetStatus = {
      id: target.id,
      version: cfg.version,
      buildNumber: target.attributes.version,
      processingState: target.attributes.processingState,
      usesNonExemptEncryption: target.attributes.usesNonExemptEncryption,
      ...detail.data?.attributes,
      groups: assignments,
    };
  }
  return {
    testFlightUrl: `https://appstoreconnect.apple.com/apps/${cfg.appId}/testflight`,
    local: { version: cfg.version, buildNumber: cfg.buildNumber },
    production: snapshot,
    recentBuilds: (recent.data ?? []).map((b) => ({
      id: b.id,
      version: trainFor(recent, b),
      buildNumber: b.attributes.version,
      processingState: b.attributes.processingState,
    })),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.attributes.name,
      internal: g.attributes.isInternalGroup,
      accessToAllBuilds: g.attributes.hasAccessToAllBuilds,
    })),
    target: targetStatus,
  };
}

export async function enableBuild(asc, cfg, opts) {
  if (cfg.version !== TEST_VERSION || cfg.buildNumber !== TEST_BUILD_NUMBER) {
    throw new Error(
      `Enable is restricted to app.json ${TEST_VERSION} / iOS build ${TEST_BUILD_NUMBER}.`,
    );
  }
  if (!opts.buildId || !ID.test(opts.buildId) || !opts.groupId || !ID.test(opts.groupId)) {
    throw new Error("Enable needs exact ASC build and internal group IDs.");
  }
  if (opts.groupId !== TEST_GROUP_ID)
    throw new Error("Enable is restricted to Kaata's existing Team (Expo) internal group.");
  const [app, result, groupResult] = await Promise.all([
    asc("GET", `/apps/${cfg.appId}?fields[apps]=bundleId`),
    asc("GET", `/builds/${opts.buildId}?include=app,preReleaseVersion`),
    asc("GET", `/betaGroups/${opts.groupId}?include=app`),
  ]);
  const build = result.data;
  const group = groupResult.data;
  if (app.data?.id !== cfg.appId || app.data?.attributes?.bundleId !== KAATA_BUNDLE_ID)
    throw new Error("ASC app identity does not match Kaata.");
  if (
    build?.type !== "builds" ||
    build.id !== opts.buildId ||
    build.relationships?.app?.data?.id !== cfg.appId
  )
    throw new Error("Build does not belong to Kaata's ASC app.");
  if (build.attributes?.version !== cfg.buildNumber || trainFor(result, build) !== TEST_VERSION)
    throw new Error("Build number or 2.2.3 version train does not match app.json.");
  if (build.attributes.processingState !== "VALID" || build.attributes.expired !== false)
    throw new Error("Build must be VALID and unexpired before enabling TestFlight.");
  if (
    group?.type !== "betaGroups" ||
    group.id !== opts.groupId ||
    group.attributes?.isInternalGroup !== true ||
    group.relationships?.app?.data?.id !== cfg.appId
  )
    throw new Error("Group must be an existing INTERNAL group belonging to Kaata.");
  let detail = (await asc("GET", `/builds/${build.id}/buildBetaDetail`)).data?.attributes;
  if (opts.setExemptEncryption) {
    if (!cfg.exemptEncryption || build.attributes.usesNonExemptEncryption === true)
      throw new Error("Refusing to override a non-exempt encryption declaration.");
    if (build.attributes.usesNonExemptEncryption == null) {
      await asc("PATCH", `/builds/${build.id}`, {
        data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } },
      });
      detail = (await asc("GET", `/builds/${build.id}/buildBetaDetail`)).data?.attributes;
    }
  }
  if (!["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].includes(detail?.internalBuildState))
    throw new Error(`Internal testing is not ready (${detail?.internalBuildState ?? "unknown"}).`);
  const builds = await listAll(asc, `/betaGroups/${group.id}/relationships/builds?limit=200`);
  const alreadyAssigned = builds.some((b) => b.id === build.id);
  if (!alreadyAssigned && !group.attributes.hasAccessToAllBuilds) {
    await asc("POST", `/betaGroups/${group.id}/relationships/builds`, {
      data: [{ type: "builds", id: build.id }],
    });
  }
  const [afterDetail, afterBuilds] = await Promise.all([
    asc("GET", `/builds/${build.id}/buildBetaDetail`),
    listAll(asc, `/betaGroups/${group.id}/relationships/builds?limit=200`),
  ]);
  const assigned = afterBuilds.some((b) => b.id === build.id);
  if (!assigned && !group.attributes.hasAccessToAllBuilds)
    throw new Error(
      "ASC has not confirmed group assignment yet; recheck status before claiming distribution.",
    );
  return {
    testFlightUrl: `https://appstoreconnect.apple.com/apps/${cfg.appId}/testflight`,
    buildId: build.id,
    version: TEST_VERSION,
    buildNumber: cfg.buildNumber,
    groupId: group.id,
    groupName: group.attributes.name,
    alreadyAssigned,
    accessToAllBuilds: group.attributes.hasAccessToAllBuilds,
    assigned,
    internalBuildState: afterDetail.data?.attributes?.internalBuildState,
    production: await productionSnapshot(asc, cfg),
  };
}

export async function setNotes(asc, cfg, opts) {
  if (
    cfg.version !== TEST_VERSION ||
    cfg.buildNumber !== TEST_BUILD_NUMBER ||
    !opts.buildId ||
    !ID.test(opts.buildId)
  )
    throw new Error("Notes are restricted to the exact app.json 2.2.3 / 40 test build.");
  assertNoteText(opts.text);
  const [app, result] = await Promise.all([
    asc("GET", `/apps/${cfg.appId}?fields[apps]=bundleId`),
    asc("GET", `/builds/${opts.buildId}?include=app,preReleaseVersion`),
  ]);
  if (app.data?.id !== cfg.appId || app.data?.attributes?.bundleId !== KAATA_BUNDLE_ID)
    throw new Error("ASC app identity does not match Kaata.");
  const build = assertTestBuild(cfg, opts.buildId, result);
  const localizations = await listAll(asc, `/builds/${build.id}/betaBuildLocalizations?limit=200`);
  const english = localizations.filter(
    (l) => l.type === "betaBuildLocalizations" && l.attributes?.locale === "en-US",
  );
  if (english.length > 1) throw new Error("Refusing ambiguous English beta localizations.");
  const existing = english[0];
  const changed = existing?.attributes?.whatsNew !== opts.text;
  if (changed) {
    if (existing)
      await asc("PATCH", `/betaBuildLocalizations/${existing.id}`, {
        data: {
          type: "betaBuildLocalizations",
          id: existing.id,
          attributes: { whatsNew: opts.text },
        },
      });
    else
      await asc("POST", "/betaBuildLocalizations", {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: "en-US", whatsNew: opts.text },
          relationships: { build: { data: { type: "builds", id: build.id } } },
        },
      });
  }
  const confirmed = (
    await listAll(asc, `/builds/${build.id}/betaBuildLocalizations?limit=200`)
  ).find((l) => l.attributes?.locale === "en-US");
  if (confirmed?.attributes?.whatsNew !== opts.text)
    throw new Error("ASC has not confirmed the exact English beta notes yet.");
  return {
    testFlightUrl: `https://appstoreconnect.apple.com/apps/${cfg.appId}/testflight`,
    buildId: build.id,
    version: TEST_VERSION,
    buildNumber: cfg.buildNumber,
    localizationId: confirmed.id,
    locale: "en-US",
    characters: opts.text.length,
    changed,
    production: await productionSnapshot(asc, cfg),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n\n")[0]);
    return;
  }
  const cfg = readConfig();
  if (opts.command === "notes")
    opts.text = readFileSync(path.resolve(opts.notesFile), "utf8").trim();
  const asc = makeClient(cfg, {
    enable: opts.command === "enable" ? opts : null,
    notes: opts.command === "notes" ? opts : null,
  });
  const result =
    opts.command === "enable"
      ? await enableBuild(asc, cfg, opts)
      : opts.command === "notes"
        ? await setNotes(asc, cfg, opts)
        : await status(asc, cfg);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(`TestFlight: ${err.message}`);
    process.exitCode = 1;
  });
}
