#!/usr/bin/env node
// Read Play release lifecycle states without creating or committing an edit.
// Unlike edits.tracks, applications.tracks.releases reports review/publication
// state directly and cannot expire a concurrent EAS upload's edit.
//
// node scripts/play-release-status.mjs
// node scripts/play-release-status.mjs --track production --track alpha
// node scripts/play-release-status.mjs --json
// node scripts/play-release-status.mjs --key <service-account-json>

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_PACKAGE = "af.kaata.app";
const PLAY_ORIGIN = "https://androidpublisher.googleapis.com";
const TOKEN_ENDPOINTS = new Set([
  "https://oauth2.googleapis.com/token",
  "https://accounts.google.com/o/oauth2/token",
]);
const TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const options = {
    tracks: [],
    key: path.join(MOBILE_DIR, "credentials", "google-service-account.json"),
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--track" || arg === "--key") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--key") options.key = path.resolve(value);
      else {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) {
          throw new Error("--track must be a Play track identifier.");
        }
        options.tracks.push(value);
      }
    } else throw new Error("Unknown argument. Run with --help for usage.");
  }
  options.tracks = [
    ...new Set(options.tracks.length ? options.tracks : ["production", "alpha", "internal"]),
  ];
  return options;
}

async function requestJson(url, init) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Do not print the request, bearer token, assertion, or a fetch error cause.
    throw new Error("Google request failed or timed out.");
  }
  if (!response.ok) throw new Error(`Google request failed: HTTP ${response.status}.`);
  // Empty tracks return 204 rather than an object containing no releases.
  if (response.status === 204) return {};
  try {
    return await response.json();
  } catch {
    throw new Error("Google returned an invalid JSON response.");
  }
}

async function accessToken(keyPath) {
  let key;
  try {
    key = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch {
    throw new Error(
      "Cannot read the Play service-account JSON. Use --key if it is stored elsewhere.",
    );
  }
  if (
    key.type !== "service_account" ||
    typeof key.client_email !== "string" ||
    typeof key.private_key !== "string" ||
    !TOKEN_ENDPOINTS.has(key.token_uri)
  ) {
    throw new Error(
      "The key must be a Google service-account JSON with an approved Google token endpoint.",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: key.token_uri,
    iat: now,
    exp: now + 600,
  });
  let assertion;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    signer.end();
    assertion = `${header}.${claims}.${signer.sign(key.private_key).toString("base64url")}`;
  } catch {
    throw new Error("Cannot sign with the supplied service-account key.");
  }
  const result = await requestJson(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (typeof result?.access_token !== "string" || !result.access_token) {
    throw new Error("Google token exchange returned no access token.");
  }
  return result.access_token;
}

const STATUS_LABELS = {
  RELEASE_LIFECYCLE_STATE_UNSPECIFIED: "Unknown",
  RELEASE_LIFECYCLE_STATE_DRAFT: "Draft",
  RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: "Not sent for review",
  RELEASE_LIFECYCLE_STATE_IN_REVIEW: "In review",
  RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: "Approved, not published",
  RELEASE_LIFECYCLE_STATE_NOT_APPROVED: "Not approved",
  RELEASE_LIFECYCLE_STATE_PUBLISHED: "Published on this track",
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Read-only Kaata Play release status; never creates an edit.\n" +
        "Usage: node scripts/play-release-status.mjs [--track <name>] [--key <path>] [--json]\n" +
        "Default tracks: production, alpha (closed testing), internal.\n" +
        "--track may be repeated. --json preserves complete release endpoint responses.\n" +
        "Only GET requests reach the Play API; authentication uses Google's token endpoint.",
    );
    return;
  }
  let app;
  try {
    app = JSON.parse(readFileSync(path.join(MOBILE_DIR, "app.json"), "utf8")).expo;
  } catch {
    throw new Error("Cannot read apps/mobile/app.json.");
  }
  if (app?.android?.package !== EXPECTED_PACKAGE) {
    throw new Error(
      `Expected Android package ${EXPECTED_PACKAGE}; refusing to inspect a different app.`,
    );
  }
  const token = await accessToken(options.key);
  const results = await Promise.allSettled(
    options.tracks.map(async (track) => {
      const url = `${PLAY_ORIGIN}/androidpublisher/v3/applications/${EXPECTED_PACKAGE}/tracks/${encodeURIComponent(track)}/releases`;
      const response = await requestJson(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new Error("Invalid Play release response.");
      }
      // Google may omit an empty releases array. Unexpected data is not proof
      // that this track has no releases, so reject other shapes explicitly.
      if (response.releases != null && !Array.isArray(response.releases)) {
        throw new Error("Invalid Play releases list.");
      }
      return response;
    }),
  );
  const output = {
    package: EXPECTED_PACKAGE,
    fetched_at: new Date().toISOString(),
    tracks: {},
  };
  for (let i = 0; i < results.length; i++) {
    const track = options.tracks[i];
    const result = results[i];
    output.tracks[track] =
      result.status === "fulfilled" ? result.value : { error: result.reason.message };
  }
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`Kaata Play release lifecycle (${EXPECTED_PACKAGE})`);
    for (const [track, response] of Object.entries(output.tracks)) {
      console.log(`\n${track}:`);
      if (response.error) console.log(`  Unable to inspect: ${response.error}`);
      else if (!(response.releases ?? []).length) console.log("  No releases returned.");
      else {
        for (const release of response.releases) {
          const codes =
            (release.activeArtifacts ?? []).map((artifact) => artifact.versionCode).join(", ") ||
            "none";
          const state = release.releaseLifecycleState ?? "RELEASE_LIFECYCLE_STATE_UNSPECIFIED";
          console.log(
            `  ${release.releaseName ?? "Unnamed release"} | codes ${codes} | ${STATUS_LABELS[state] ?? state}`,
          );
        }
      }
    }
    console.log("\nRead-only check complete. No Play edit was opened or committed.");
  }
  if (results.some((result) => result.status === "rejected")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Play release status: ${error.message}`);
  process.exitCode = 1;
});
