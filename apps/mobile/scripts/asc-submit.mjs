#!/usr/bin/env node
// Submit the current app.json version to App Store REVIEW.
//
// `eas submit` cannot do this — it only UPLOADS a binary to App Store Connect,
// where it lands in TestFlight. Releasing to the App Store is a separate
// three-call flow on Apple's reviewSubmissions API, which EAS never wired up.
// This script is that flow. It is the same API fastlane's
// `deliver --submit_for_review` drives.
//
// Config is read, not duplicated: the version and build number come from
// app.json (the single source of truth — see CLAUDE.md "Release / deploy
// flow"), and the ASC API credentials come from the eas.json submit profile.
//
//   node scripts/asc-submit.mjs --status
//   node scripts/asc-submit.mjs --notes-file release-notes.txt --dry-run
//   node scripts/asc-submit.mjs --notes-file release-notes.txt
//
// Flags:
//   --notes-file <path>  "What's New" text (required when the version has none)
//   --notes <text>       same, inline; \n is expanded
//   --profile <name>     eas.json submit profile (default: production)
//   --locale <code>      localization to write notes to (default: en-US)
//   --manual             hold at "Pending Developer Release" after approval
//                        (default: release automatically once approved)
//   --dry-run            preflight only; performs no writes
//   --status             print current build/version/submission state and exit
//
// PREREQUISITE: the build must already be uploaded and finished processing,
// i.e. `eas submit --platform ios --profile production` has run and App Store
// Connect shows the build in TestFlight.

import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.appstoreconnect.apple.com/v1";

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = { profile: "production", locale: "en-US", releaseType: "AFTER_APPROVAL" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--notes-file") opts.notes = readFileSync(argv[++i], "utf8").trim();
    else if (a === "--notes") opts.notes = argv[++i].replace(/\\n/g, "\n").trim();
    else if (a === "--profile") opts.profile = argv[++i];
    else if (a === "--locale") opts.locale = argv[++i];
    else if (a === "--manual") opts.releaseType = "MANUAL";
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--status") opts.status = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else fail(`unknown flag: ${a}\nRun with --help for usage.`);
  }
  return opts;
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- asc client

function readConfig(profile) {
  const app = JSON.parse(readFileSync(path.join(MOBILE_DIR, "app.json"), "utf8")).expo;
  const eas = JSON.parse(readFileSync(path.join(MOBILE_DIR, "eas.json"), "utf8"));
  const ios = eas.submit?.[profile]?.ios;
  if (!ios) fail(`eas.json has no submit.${profile}.ios block`);
  for (const k of ["ascApiKeyPath", "ascApiKeyId", "ascApiKeyIssuerId", "ascAppId"]) {
    if (!ios[k]) fail(`eas.json submit.${profile}.ios is missing ${k}`);
  }
  const keyPath = path.resolve(MOBILE_DIR, ios.ascApiKeyPath);
  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
  } catch (err) {
    fail(
      `cannot read the ASC API key at ${keyPath}\n  ${err.message}\n` +
        `  credentials/ is gitignored — download the .p8 again from ` +
        `App Store Connect > Users and Access > Integrations.`,
    );
  }
  return {
    appId: ios.ascAppId,
    keyId: ios.ascApiKeyId,
    issuerId: ios.ascApiKeyIssuerId,
    privateKey,
    version: app.version,
    buildNumber: String(app.ios?.buildNumber ?? ""),
    bundleId: app.ios?.bundleIdentifier,
  };
}

const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makeToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "ES256", kid: cfg.keyId, typ: "JWT" }));
  const payload = b64u(
    JSON.stringify({ iss: cfg.issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }),
  );
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  // JOSE wants raw r||s, not the DER the signer emits by default.
  return `${header}.${payload}.${b64u(signer.sign({ key: cfg.privateKey, dsaEncoding: "ieee-p1363" }))}`;
}

function makeClient(cfg) {
  return async function asc(method, endpoint, body) {
    const res = await fetch(endpoint.startsWith("http") ? endpoint : API + endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${makeToken(cfg)}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* Apple occasionally answers non-JSON on 5xx */
    }
    if (!res.ok) {
      const detail = (json?.errors ?? [])
        .map((e) => `  [${e.status} ${e.code}] ${e.title}${e.detail ? ` — ${e.detail}` : ""}`)
        .join("\n");
      fail(`${method} ${endpoint}\n${detail || `  HTTP ${res.status}\n  ${text.slice(0, 800)}`}`);
    }
    return json;
  };
}

// ---------------------------------------------------------------- steps

// States from which a version's metadata is still editable and submittable.
const EDITABLE = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);

async function findBuild(asc, cfg) {
  const r = await asc(
    "GET",
    `/builds?filter[app]=${cfg.appId}&filter[version]=${cfg.buildNumber}&limit=1`,
  );
  const build = r.data?.[0];
  if (!build) {
    fail(
      `no build ${cfg.buildNumber} on App Store Connect for ${cfg.bundleId}.\n` +
        `  app.json says version ${cfg.version} / buildNumber ${cfg.buildNumber}.\n` +
        `  Upload it first:  eas submit --platform ios --profile ${cfg.profile ?? "production"}`,
    );
  }
  if (build.attributes.processingState !== "VALID") {
    fail(
      `build ${cfg.buildNumber} is ${build.attributes.processingState}, not VALID.\n` +
        `  Apple is still processing it (usually 5-30 min). Re-run when it settles.`,
    );
  }
  return build;
}

async function findVersion(asc, cfg) {
  const r = await asc(
    "GET",
    `/apps/${cfg.appId}/appStoreVersions?filter[versionString]=${cfg.version}&filter[platform]=IOS`,
  );
  return r.data?.[0] ?? null;
}

async function printStatus(asc, cfg) {
  const builds = await asc(
    "GET",
    `/builds?filter[app]=${cfg.appId}&limit=5&sort=-uploadedDate&include=preReleaseVersion`,
  );
  const trains = Object.fromEntries(
    (builds.included ?? []).map((i) => [i.id, i.attributes?.version]),
  );
  console.log(`app.json: version ${cfg.version}, buildNumber ${cfg.buildNumber}\n`);
  console.log("recent builds (TestFlight):");
  for (const b of builds.data ?? []) {
    const train = trains[b.relationships?.preReleaseVersion?.data?.id] ?? "?";
    const here = b.attributes.version === cfg.buildNumber ? "  <- app.json" : "";
    console.log(
      `  build ${b.attributes.version} (${train})  ${b.attributes.processingState}${here}`,
    );
  }
  const versions = await asc("GET", `/apps/${cfg.appId}/appStoreVersions?limit=5`);
  console.log("\nrecent App Store versions:");
  for (const v of versions.data ?? []) {
    console.log(`  ${v.attributes.versionString}  ${v.attributes.appStoreState}`);
  }
  const subs = await asc(
    "GET",
    `/apps/${cfg.appId}/reviewSubmissions?filter[platform]=IOS&limit=3`,
  );
  console.log("\nrecent review submissions:");
  for (const s of subs.data ?? []) {
    console.log(`  ${s.attributes.state}  submitted ${s.attributes.submittedDate ?? "-"}`);
  }
  // A build present in TestFlight with no matching App Store version is the
  // failure this script exists to prevent: shipped to testers, never to users.
  const shipped = new Set((versions.data ?? []).map((v) => v.attributes.versionString));
  const stranded = [
    ...new Set(
      (builds.data ?? [])
        .map((b) => trains[b.relationships?.preReleaseVersion?.data?.id])
        .filter((t) => t && !shipped.has(t)),
    ),
  ];
  if (stranded.length) {
    console.log(`\n! TestFlight-only, never submitted for review: ${stranded.join(", ")}`);
  }
}

async function ensureNotes(asc, cfg, versionId, opts) {
  const locs = await asc("GET", `/appStoreVersions/${versionId}/appStoreVersionLocalizations`);
  const loc = (locs.data ?? []).find((l) => l.attributes.locale === opts.locale);
  if (!loc) {
    fail(
      `version ${cfg.version} has no ${opts.locale} localization ` +
        `(has: ${(locs.data ?? []).map((l) => l.attributes.locale).join(", ") || "none"}).`,
    );
  }
  if (opts.notes) {
    if (opts.notes.length > 4000)
      fail(`notes are ${opts.notes.length} chars; Apple's limit is 4000`);
    if (!opts.dryRun) {
      await asc("PATCH", `/appStoreVersionLocalizations/${loc.id}`, {
        data: {
          type: "appStoreVersionLocalizations",
          id: loc.id,
          attributes: { whatsNew: opts.notes },
        },
      });
    }
    console.log(`  notes        ${opts.notes.length} chars -> ${opts.locale}`);
  } else if (loc.attributes.whatsNew) {
    console.log(`  notes        keeping existing ${loc.attributes.whatsNew.length} chars`);
  } else {
    fail(
      `version ${cfg.version} has no "What's New" text and none was given.\n` +
        `  Apple rejects an update without it. Pass --notes-file <path> or --notes "<text>".`,
    );
  }
  return loc;
}

async function preflight(asc, loc) {
  const a = (await asc("GET", `/appStoreVersionLocalizations/${loc.id}`)).data.attributes;
  if (!a.description) fail("the version has no App Store description");
  const sets = await asc("GET", `/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`);
  let total = 0;
  for (const s of sets.data ?? []) {
    const shots = await asc("GET", `/appScreenshotSets/${s.id}/appScreenshots`);
    total += shots.data?.length ?? 0;
  }
  if (total === 0) {
    fail("the version has no screenshots — ASC normally copies them from the previous version");
  }
  console.log(`  metadata     description ${a.description.length} chars, ${total} screenshots`);
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n\n")[0]);
  process.exit(0);
}

const cfg = { ...readConfig(opts.profile), profile: opts.profile };
const asc = makeClient(cfg);

if (opts.status) {
  await printStatus(asc, cfg);
  process.exit(0);
}

console.log(`Kaata ${cfg.version} (build ${cfg.buildNumber}) -> App Store review`);
if (opts.dryRun) console.log("DRY RUN — no writes\n");

const build = await findBuild(asc, cfg);
console.log(`  build        ${cfg.buildNumber} VALID (${build.id})`);

let version = await findVersion(asc, cfg);
if (version && !EDITABLE.has(version.attributes.appStoreState)) {
  fail(
    `version ${cfg.version} is already ${version.attributes.appStoreState}.\n` +
      `  Nothing to do — or bump app.json and build again.`,
  );
}

if (opts.dryRun) {
  console.log(`  version      ${version ? `exists (${version.id})` : "would be created"}`);
  console.log(`  releaseType  ${opts.releaseType}`);
  console.log("\nDry run clean. Re-run without --dry-run to submit.");
  process.exit(0);
}

if (!version) {
  const created = await asc("POST", "/appStoreVersions", {
    data: {
      type: "appStoreVersions",
      attributes: {
        platform: "IOS",
        versionString: cfg.version,
        releaseType: opts.releaseType,
      },
      relationships: { app: { data: { type: "apps", id: cfg.appId } } },
    },
  });
  version = created.data;
  console.log(`  version      created ${cfg.version} (${version.id})`);
} else {
  await asc("PATCH", `/appStoreVersions/${version.id}`, {
    data: {
      type: "appStoreVersions",
      id: version.id,
      attributes: { releaseType: opts.releaseType },
    },
  });
  console.log(`  version      reusing ${cfg.version} (${version.attributes.appStoreState})`);
}

await asc("PATCH", `/appStoreVersions/${version.id}/relationships/build`, {
  data: { type: "builds", id: build.id },
});
console.log(`  attach       build ${cfg.buildNumber}`);

const loc = await ensureNotes(asc, cfg, version.id, opts);
await preflight(asc, loc);
console.log(`  releaseType  ${opts.releaseType}`);

// Three calls: open a submission, put the version in it, flip submitted.
const open = await asc(
  "GET",
  `/apps/${cfg.appId}/reviewSubmissions?filter[platform]=IOS&filter[state]=READY_FOR_REVIEW&limit=1`,
);
let submissionId = open.data?.[0]?.id;
if (!submissionId) {
  const created = await asc("POST", "/reviewSubmissions", {
    data: {
      type: "reviewSubmissions",
      attributes: { platform: "IOS" },
      relationships: { app: { data: { type: "apps", id: cfg.appId } } },
    },
  });
  submissionId = created.data.id;
}

const items = await asc("GET", `/reviewSubmissions/${submissionId}/items`);
const attached = (items.data ?? []).some(
  (i) => i.relationships?.appStoreVersion?.data?.id === version.id,
);
if (!attached) {
  await asc("POST", "/reviewSubmissionItems", {
    data: {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
        appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
      },
    },
  });
}

const submitted = await asc("PATCH", `/reviewSubmissions/${submissionId}`, {
  data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
});

console.log(`\n✓ submitted for review — ${submitted.data.attributes.state}`);
console.log(
  opts.releaseType === "MANUAL"
    ? "  On approval it waits at Pending Developer Release until you press Release."
    : "  On approval it goes live automatically.",
);
console.log(`  https://appstoreconnect.apple.com/apps/${cfg.appId}/distribution`);
