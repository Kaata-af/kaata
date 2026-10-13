#!/usr/bin/env node
// Upload ONLY Kaata 2.2.0/code 57 to Play INTERNAL testing, preserving reviews.
// No track-selection or review-cancellation flag exists. Every commit uses
// ERROR_IF_IN_REVIEW; a refusal is final, with no automatic retry or fallback.
// Run only after every other Android EAS submission has finished: one open edit
// per app is allowed, including this helper's upload edit.
//
// node scripts/play-internal-submit.mjs --aab <local-file.aab>
//   [--notes-file <file>] [--key <service-account-json>]

import { createHash, createSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "af.kaata.app";
const VERSION = "2.2.0";
const CODE = 57;
const ORIGIN = "https://androidpublisher.googleapis.com";
const BASE = `${ORIGIN}/androidpublisher/v3/applications/${PACKAGE}`;
const COMMIT_GUARD = "changesInReviewBehavior=ERROR_IF_IN_REVIEW";
const TOKEN_ENDPOINTS = new Set([
  "https://oauth2.googleapis.com/token",
  "https://accounts.google.com/o/oauth2/token",
]);

function safeReason(body) {
  const details = body?.error?.details;
  const reasons = Array.isArray(details) ? details.map((detail) => detail?.reason) : [];
  return reasons.find(
    (reason) => typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(reason),
  );
}

async function jsonRequest(fetchImpl, url, init, timeout = 30_000) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    // Never log request headers, OAuth assertions, or fetch error causes.
    throw new Error("Google request failed or timed out; no automatic retry is allowed.");
  }
  let body = null;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      if (response.ok) throw new Error("Google returned invalid JSON.");
    }
  }
  if (!response.ok) {
    const reason = safeReason(body);
    throw new Error(
      `Google request refused: HTTP ${response.status}${reason ? ` (${reason})` : ""}.`,
    );
  }
  return body;
}

async function accessToken(keyPath, fetchImpl) {
  let key;
  try {
    key = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch {
    throw new Error(
      "Cannot read the Play service-account JSON. Use --key if it is stored elsewhere.",
    );
  }
  if (
    key?.type !== "service_account" ||
    typeof key.client_email !== "string" ||
    typeof key.private_key !== "string" ||
    !TOKEN_ENDPOINTS.has(key.token_uri)
  ) {
    throw new Error(
      "Expected a Google service-account JSON with an approved Google token endpoint.",
    );
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: key.token_uri,
    iat: now,
    exp: now + 600,
  })}`;
  let assertion;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    assertion = `${unsigned}.${signer.sign(key.private_key).toString("base64url")}`;
  } catch {
    throw new Error("Cannot sign with the supplied service-account key.");
  }
  const response = await jsonRequest(fetchImpl, key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (typeof response?.access_token !== "string" || !response.access_token) {
    throw new Error("Google token exchange returned no access token.");
  }
  return response.access_token;
}

function requireRelease(app) {
  if (
    app?.android?.package !== PACKAGE ||
    app.version !== VERSION ||
    app.android.versionCode !== CODE
  ) {
    throw new Error(`This helper is restricted to ${PACKAGE} ${VERSION}/code ${CODE}.`);
  }
}

function loadBundle(aabPath) {
  if (typeof aabPath !== "string" || path.extname(aabPath).toLowerCase() !== ".aab") {
    throw new Error("--aab must name a local .aab file.");
  }
  let data;
  try {
    if (!statSync(aabPath).isFile()) throw new Error("Not a file");
    data = readFileSync(aabPath);
  } catch {
    throw new Error("Cannot read the supplied local AAB file.");
  }
  if (data.length < 4 || !data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error("The supplied AAB is not a ZIP-format Android App Bundle.");
  }
  return data;
}

function snapshot(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Invalid release lifecycle response.");
  }
  if (response.releases != null && !Array.isArray(response.releases)) {
    throw new Error("Invalid release lifecycle list.");
  }
  return (response.releases ?? [])
    .map((release) => {
      if (
        !release ||
        typeof release !== "object" ||
        !Array.isArray(release.activeArtifacts ?? [])
      ) {
        throw new Error("Invalid release lifecycle entry.");
      }
      return {
        name: release.releaseName ?? null,
        state: release.releaseLifecycleState ?? "RELEASE_LIFECYCLE_STATE_UNSPECIFIED",
        codes: (release.activeArtifacts ?? [])
          .map((artifact) => String(artifact.versionCode))
          .sort(),
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// Exported solely so tests can inject a mock transport; all store destinations
// and the review guard remain fixed even when imported.
export async function submitInternal(
  { app, aabPath, token, notes = null },
  { fetchImpl = globalThis.fetch, report = console.log } = {},
) {
  requireRelease(app);
  const bundle = loadBundle(aabPath);
  if (typeof token !== "string" || !token) throw new Error("A Google access token is required.");
  if (notes != null && (typeof notes !== "string" || !notes.trim() || notes.trim().length > 500)) {
    throw new Error("Release notes must contain 1–500 characters.");
  }
  const headers = { Authorization: `Bearer ${token}` };
  const call = (method, url, body, timeout) =>
    jsonRequest(
      fetchImpl,
      url,
      {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      timeout,
    );
  const readTrack = async (track) =>
    snapshot(await call("GET", `${BASE}/tracks/${track}/releases`));
  const [productionBefore, internalBefore] = await Promise.all([
    readTrack("production"),
    readTrack("internal"),
  ]);
  report(`Production before: ${JSON.stringify(productionBefore)}`);
  report(`Internal before: ${JSON.stringify(internalBefore)}`);
  if (productionBefore.some((release) => release.codes.includes(String(CODE)))) {
    throw new Error(`Code ${CODE} already exists on production; refusing to continue.`);
  }
  const existing = internalBefore.find((release) => release.codes.includes(String(CODE)));
  if (existing) {
    if (existing.state !== "RELEASE_LIFECYCLE_STATE_PUBLISHED") {
      throw new Error(
        `Code ${CODE} already exists on internal (${existing.state}); inspect it without re-uploading.`,
      );
    }
    report(`${VERSION}/code ${CODE} is already published on internal. No edit opened.`);
    return {
      alreadyPublished: true,
      productionBefore,
      productionAfter: productionBefore,
      internalAfter: internalBefore,
    };
  }

  let editId = null;
  let committed = false;
  let failure = null;
  let productionAfter = null;
  let internalAfter = null;
  try {
    const edit = await call("POST", `${BASE}/edits`, {});
    if (typeof edit?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(edit.id)) {
      throw new Error("Google returned an invalid edit identifier.");
    }
    editId = edit.id;
    report(
      `Uploading ${VERSION}/code ${CODE} to an internal-only edit (${(bundle.length / 1024 / 1024).toFixed(1)} MiB).`,
    );
    const uploaded = await jsonRequest(
      fetchImpl,
      `${ORIGIN}/upload/androidpublisher/v3/applications/${PACKAGE}/edits/${editId}/bundles?uploadType=media`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/octet-stream" },
        body: bundle,
      },
      600_000,
    );
    if (String(uploaded?.versionCode) !== String(CODE)) {
      throw new Error(
        `Uploaded bundle is not code ${CODE}; discarding the edit without committing.`,
      );
    }
    if (
      typeof uploaded.sha256 === "string" &&
      uploaded.sha256.toLowerCase() !== createHash("sha256").update(bundle).digest("hex")
    ) {
      throw new Error("Uploaded bundle SHA-256 does not match the local AAB; discarding the edit.");
    }
    await call("PUT", `${BASE}/edits/${editId}/tracks/internal`, {
      track: "internal",
      releases: [
        {
          name: `${VERSION} (${CODE}) — internal testing`,
          versionCodes: [String(CODE)],
          status: "completed",
          ...(notes == null ? {} : { releaseNotes: [{ language: "en-US", text: notes.trim() }] }),
        },
      ],
    });
    await call("POST", `${BASE}/edits/${editId}:validate`);
    report("Committing internal only with ERROR_IF_IN_REVIEW. A refusal will not be retried.");
    await call("POST", `${BASE}/edits/${editId}:commit?${COMMIT_GUARD}`);
    committed = true;
  } catch (error) {
    failure = error;
  } finally {
    if (editId && !committed) {
      try {
        await call("DELETE", `${BASE}/edits/${editId}`);
        report("Discarded this upload edit. No unguarded commit or fallback attempted.");
      } catch {
        report(
          "Could not confirm edit cleanup. Do not retry submission; inspect read-only release status first.",
        );
        failure ??= new Error("Failed to confirm cleanup of this upload edit.");
      }
    }
    const after = await Promise.allSettled([readTrack("production"), readTrack("internal")]);
    if (after[0].status === "fulfilled") {
      productionAfter = after[0].value;
      report(`Production after: ${JSON.stringify(productionAfter)}`);
      if (JSON.stringify(productionBefore) !== JSON.stringify(productionAfter)) {
        report(
          "Production lifecycle changed during this operation. No production track write was made; verify the review's current state.",
        );
        failure ??= new Error("Production lifecycle changed; read-only verification is required.");
      }
    } else {
      report(
        "Could not verify production after this operation. Use the read-only status helper; do not retry submission.",
      );
      failure ??= new Error("Production status verification failed.");
    }
    if (after[1].status === "fulfilled") {
      internalAfter = after[1].value;
      report(`Internal after: ${JSON.stringify(internalAfter)}`);
    } else {
      report(
        "Could not verify internal after this operation. Use the read-only status helper; do not retry submission.",
      );
      failure ??= new Error("Internal status verification failed.");
    }
  }
  if (failure) throw failure;
  const release = internalAfter.find((candidate) => candidate.codes.includes(String(CODE)));
  if (!release)
    throw new Error(
      `Commit was acknowledged but internal code ${CODE} is not yet visible. Recheck read-only status; do not re-upload.`,
    );
  report(`Internal ${VERSION}/code ${CODE}: ${release.state}. Production lifecycle unchanged.`);
  return { committed, productionBefore, productionAfter, internalAfter };
}

function parseArgs(argv) {
  const options = {
    aabPath: null,
    notesFile: null,
    key: path.join(MOBILE_DIR, "credentials", "google-service-account.json"),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (["--aab", "--key", "--notes-file"].includes(argument)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path.`);
      const field = { "--aab": "aabPath", "--key": "key", "--notes-file": "notesFile" }[argument];
      if (field === "aabPath" && options.aabPath) throw new Error("Specify one --aab file only.");
      options[field] = path.resolve(value);
    } else
      throw new Error(
        "Unknown argument. No track-selection or review-cancellation option is supported.",
      );
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      `Upload only ${PACKAGE} ${VERSION}/code ${CODE} to INTERNAL testing.\n` +
        "Usage: node scripts/play-internal-submit.mjs --aab <local.aab> [--notes-file <file>] [--key <file>]\n" +
        "Commit always uses ERROR_IF_IN_REVIEW. No retries, production writes, or review cancellations.\n" +
        "Do not run while another Android EAS/Play submission has an open edit.",
    );
    return;
  }
  let app;
  try {
    app = JSON.parse(readFileSync(path.join(MOBILE_DIR, "app.json"), "utf8")).expo;
  } catch {
    throw new Error("Cannot read apps/mobile/app.json.");
  }
  requireRelease(app);
  loadBundle(options.aabPath);
  let notes = null;
  if (options.notesFile) {
    try {
      notes = readFileSync(options.notesFile, "utf8").trim();
    } catch {
      throw new Error("Cannot read the release notes file.");
    }
    if (!notes || notes.length > 500)
      throw new Error("Release notes must contain 1–500 characters.");
  }
  const token = await accessToken(options.key, globalThis.fetch);
  await submitInternal({ app, aabPath: options.aabPath, token, notes });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Internal submission stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
