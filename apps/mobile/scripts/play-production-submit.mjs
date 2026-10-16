#!/usr/bin/env node
// Stage the verified Kaata 2.2.0/code 59 bundle on internal, then promote that
// same bundle to production in one atomic edit. Closed tracks and listing
// metadata remain unchanged. The separate commit command always refuses an
// existing review; it never cancels a review, falls back, or retries a write.
//
// First cancel/recombine an existing image-only review in Play Console, after
// the signed AAB is ready, BEFORE preparing this edit. Console changes discard
// active API edits. Never run alongside another Android upload/edit.
//
// node scripts/play-production-submit.mjs --prepare --aab <file.aab>
//   --sha256 <verified-sha256> --notes-file scripts/release-notes/2.2.0-play.txt
//   --images-receipt <play-update.json> --receipt <ignored-release-receipt.json>
// node scripts/play-production-submit.mjs --commit --receipt <same-receipt.json>

import { createHash, createSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "af.kaata.app";
const VERSION = "2.2.0";
const CODE = 59;
const ORIGIN = "https://androidpublisher.googleapis.com";
const BASE = `${ORIGIN}/androidpublisher/v3/applications/${PACKAGE}`;
const GUARD = "changesInReviewBehavior=ERROR_IF_IN_REVIEW";
const IMAGE_TYPES = [
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "featureGraphic",
  "icon",
  "tvScreenshots",
  "tvBanner",
  "wearScreenshots",
];
const TOKEN_ENDPOINTS = new Set([
  "https://oauth2.googleapis.com/token",
  "https://accounts.google.com/o/oauth2/token",
]);
const stable = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const same = (a, b) => stable(a) === stable(b);

function requireApp(app) {
  if (
    app?.android?.package !== PACKAGE ||
    app.version !== VERSION ||
    app.android.versionCode !== CODE
  ) {
    throw new Error(`This helper is restricted to ${PACKAGE} ${VERSION}/code ${CODE}.`);
  }
}

async function request(fetchImpl, url, init, timeout = 30_000) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    const error = new Error(
      "Google request failed or timed out. Mutation outcome may be unknown; never retry automatically.",
    );
    error.ambiguous = true;
    throw error;
  }
  let body = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    const error = new Error(
      `Google returned invalid JSON (HTTP ${response.status}). Inspect before retrying.`,
    );
    error.ambiguous = response.ok;
    throw error;
  }
  if (!response.ok) {
    const reason = body?.error?.details
      ?.map((entry) => entry?.reason)
      .find((value) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value));
    const error = new Error(
      `Google refused the request: HTTP ${response.status}${reason ? ` (${reason})` : ""}.`,
    );
    error.httpStatus = response.status;
    throw error;
  }
  return body;
}

function client(token, fetchImpl) {
  if (typeof token !== "string" || !token) throw new Error("A Google access token is required.");
  const headers = { Authorization: `Bearer ${token}` };
  const call = (method, endpoint, body) =>
    request(fetchImpl, BASE + endpoint, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const upload = (editId, bytes) =>
    request(
      fetchImpl,
      `${ORIGIN}/upload/androidpublisher/v3/applications/${PACKAGE}/edits/${editId}/bundles?uploadType=media`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/octet-stream" },
        body: bytes,
      },
      600_000,
    );
  return { call, upload };
}

async function capture(call, editId) {
  const [details, listings, tracks] = await Promise.all([
    call("GET", `/edits/${editId}/details`),
    call("GET", `/edits/${editId}/listings`),
    call("GET", `/edits/${editId}/tracks`),
  ]);
  if (!Array.isArray(listings?.listings) || !Array.isArray(tracks?.tracks))
    throw new Error("Invalid Play listing/track snapshot.");
  const images = {};
  for (const { language } of listings.listings) {
    images[language] = {};
    for (const type of IMAGE_TYPES) {
      images[language][type] =
        (await call("GET", `/edits/${editId}/listings/${encodeURIComponent(language)}/${type}`))
          ?.images ?? [];
    }
  }
  return {
    details,
    listings,
    tracks: [...tracks.tracks].sort((a, b) => a.track.localeCompare(b.track)),
    images,
  };
}

function expectedTrack(track, notes) {
  return {
    track,
    releases: [
      {
        name: track === "internal" ? `${VERSION} (${CODE}) — internal staging` : VERSION,
        versionCodes: [String(CODE)],
        status: "completed",
        releaseNotes: [{ language: "en-US", text: notes }],
      },
    ],
  };
}

function verifyPreservation(before, after, notes) {
  const untouched = (snapshot) =>
    snapshot.tracks.filter((track) => !["internal", "production"].includes(track.track));
  const checks = {
    detailsUnchanged: same(before.details, after.details),
    listingTextUnchanged: same(before.listings, after.listings),
    imagesUnchanged: same(before.images, after.images),
    closedAndOtherTracksUnchanged: same(untouched(before), untouched(after)),
    internalExact: same(
      after.tracks.find((track) => track.track === "internal"),
      expectedTrack("internal", notes),
    ),
    productionExact: same(
      after.tracks.find((track) => track.track === "production"),
      expectedTrack("production", notes),
    ),
  };
  if (Object.values(checks).some((value) => !value))
    throw new Error(`Release preservation check failed: ${JSON.stringify(checks)}`);
  return checks;
}

function verifyExpectedImages(snapshot, expectedImages) {
  const expectedCounts = {
    phoneScreenshots: 6,
    sevenInchScreenshots: 6,
    tenInchScreenshots: 6,
    featureGraphic: 1,
  };
  for (const [type, count] of Object.entries(expectedCounts)) {
    const expected = expectedImages?.find((set) => set.type === type)?.images;
    const current = snapshot.images["en-US"]?.[type];
    if (
      expected?.length !== count ||
      current?.length !== count ||
      !same(
        expected.map((image) => image.sha256),
        current.map((image) => image.sha256),
      )
    ) {
      throw new Error(
        `Saved ${type} do not match the approved screenshot update. Stop before uploading.`,
      );
    }
  }
}

export async function prepareProduction(
  { app, aabPath, sha256, notes, expectedImages, token },
  { fetchImpl = globalThis.fetch, checkpoint = () => {}, report = console.log } = {},
) {
  requireApp(app);
  if (typeof notes !== "string" || !notes.trim() || notes.trim().length > 500)
    throw new Error("Production notes must contain 1–500 characters.");
  notes = notes.trim();
  if (/testing only|test build|disposable accounts/i.test(notes))
    throw new Error("Use production release notes.");
  if (
    typeof aabPath !== "string" ||
    path.extname(aabPath).toLowerCase() !== ".aab" ||
    !/^[a-f0-9]{64}$/.test(sha256 ?? "")
  )
    throw new Error("Provide a local AAB and its verified SHA-256.");
  const bytes = readFileSync(aabPath);
  if (
    !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    createHash("sha256").update(bytes).digest("hex") !== sha256
  )
    throw new Error("Local AAB format/hash does not match the verified artifact.");
  const { call, upload } = client(token, fetchImpl);
  const receipt = {
    schema: 1,
    packageName: PACKAGE,
    version: VERSION,
    code: CODE,
    phase: "starting",
    artifact: { path: aabPath, sha256, size: bytes.length },
    notes,
    editId: null,
    before: null,
    prepared: null,
    checks: null,
    commitAcknowledgement: null,
  };
  const save = () => checkpoint(structuredClone(receipt));
  save();
  try {
    const edit = await call("POST", "/edits", {});
    if (!/^[A-Za-z0-9_-]+$/.test(edit?.id ?? "")) throw new Error("Invalid edit identifier.");
    receipt.editId = edit.id;
    receipt.phase = "inspecting";
    save();
    receipt.before = await capture(call, edit.id);
    save();
    verifyExpectedImages(receipt.before, expectedImages);
    const [bundles, apks] = await Promise.all([
      call("GET", `/edits/${edit.id}/bundles`),
      call("GET", `/edits/${edit.id}/apks`),
    ]);
    const usedCodes = [...(bundles?.bundles ?? []), ...(apks?.apks ?? [])].map((item) =>
      Number(item.versionCode),
    );
    usedCodes.push(
      ...receipt.before.tracks
        .flatMap((track) => (track.releases ?? []).flatMap((release) => release.versionCodes ?? []))
        .map(Number),
    );
    if (usedCodes.some((code) => code >= CODE))
      throw new Error(
        `Code ${CODE} is already used or is not newer than every uploaded artifact. Inspect instead of re-uploading.`,
      );
    receipt.phase = "uploading";
    save();
    const uploaded = await upload(edit.id, bytes);
    if (Number(uploaded?.versionCode) !== CODE || uploaded?.sha256?.toLowerCase() !== sha256)
      throw new Error(
        "Google's uploaded bundle code/hash differs from the verified AAB. Do not commit.",
      );
    receipt.uploaded = uploaded;
    receipt.phase = "staging_internal";
    save();
    await call("PUT", `/edits/${edit.id}/tracks/internal`, expectedTrack("internal", notes));
    await call("POST", `/edits/${edit.id}:validate`);
    const staged = await call("GET", `/edits/${edit.id}/tracks/internal`);
    if (!same(staged, expectedTrack("internal", notes)))
      throw new Error("Internal staging readback differs from the intended release.");
    receipt.internalStagingVerified = true;
    receipt.phase = "promoting_production";
    save();
    await call("PUT", `/edits/${edit.id}/tracks/production`, expectedTrack("production", notes));
    receipt.prepared = await capture(call, edit.id);
    receipt.checks = verifyPreservation(receipt.before, receipt.prepared, notes);
    save();
    await call("POST", `/edits/${edit.id}:validate`);
    receipt.phase = "prepared";
    receipt.preparedAt = new Date().toISOString();
    save();
    report(
      `Prepared ${VERSION}/${CODE}: verified internal staging then production, 100%, no commit yet.`,
    );
    return receipt;
  } catch (error) {
    receipt.failure = {
      phase: receipt.phase,
      message: error.message,
      ambiguous: !!error.ambiguous,
    };
    receipt.phase = "prepare_failed";
    save();
    // Keep the receipt/edit for explicit inspection. Never repeat an ambiguous
    // upload, consume another version code, or discard evidence automatically.
    throw error;
  }
}

export async function commitProduction(
  { app, receipt, token },
  { fetchImpl = globalThis.fetch, checkpoint = () => {}, report = console.log } = {},
) {
  requireApp(app);
  if (
    receipt?.schema !== 1 ||
    receipt.packageName !== PACKAGE ||
    receipt.version !== VERSION ||
    receipt.code !== CODE ||
    receipt.phase !== "prepared" ||
    !/^[A-Za-z0-9_-]+$/.test(receipt.editId ?? "") ||
    !receipt.internalStagingVerified
  )
    throw new Error(
      "Receipt is not an uncommitted, prepared 2.2.0/code 59 release. Inspect before retrying.",
    );
  const { call } = client(token, fetchImpl);
  const save = () => checkpoint(structuredClone(receipt));
  const current = await capture(call, receipt.editId);
  receipt.checks = verifyPreservation(receipt.before, current, receipt.notes);
  if (!same(current, receipt.prepared)) throw new Error("Prepared edit changed before commit.");
  receipt.phase = "committing";
  save();
  try {
    receipt.commitAcknowledgement = await call("POST", `/edits/${receipt.editId}:commit?${GUARD}`);
    receipt.phase = "committed";
    receipt.committedAt = new Date().toISOString();
    save();
  } catch (error) {
    receipt.phase = error.ambiguous ? "commit_unknown" : "commit_refused";
    receipt.failure = { message: error.message, ambiguous: !!error.ambiguous };
    save();
    throw error;
  }
  report(
    `Play acknowledged ${VERSION}/${CODE} for production review. Public rollout is not yet confirmed.`,
  );
  // A fresh, read-only edit confirms the committed state. Only our own
  // verification edit is removed. Do not interpret old PUBLISHED lifecycle
  // data as confirmation that code 59 or its screenshot changes are public.
  let verificationId = null;
  try {
    const edit = await call("POST", "/edits", {});
    if (!/^[A-Za-z0-9_-]+$/.test(edit?.id ?? ""))
      throw new Error("Invalid verification edit identifier.");
    verificationId = edit.id;
    receipt.verificationEditId = edit.id;
    save();
    receipt.verified = await capture(call, edit.id);
    receipt.verificationChecks = verifyPreservation(
      receipt.before,
      receipt.verified,
      receipt.notes,
    );
    receipt.lifecycle = {};
    for (const track of ["production", "internal"])
      receipt.lifecycle[track] = await call("GET", `/tracks/${track}/releases`);
    receipt.verifiedAt = new Date().toISOString();
    save();
  } catch (error) {
    receipt.verificationError = error.message;
    save();
    throw error;
  } finally {
    if (verificationId) {
      await call("DELETE", `/edits/${verificationId}`);
      receipt.verificationEditDeleted = true;
      save();
    }
  }
  return receipt;
}

async function accessToken(keyPath) {
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  if (
    key?.type !== "service_account" ||
    typeof key.client_email !== "string" ||
    typeof key.private_key !== "string" ||
    !TOKEN_ENDPOINTS.has(key.token_uri)
  )
    throw new Error("Unsupported Google service-account configuration.");
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: key.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: key.token_uri, iat: now, exp: now + 600 })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(payload);
  signer.end();
  const assertion = `${payload}.${signer.sign(key.private_key).toString("base64url")}`;
  const response = await request(globalThis.fetch, key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (typeof response?.access_token !== "string" || !response.access_token)
    throw new Error("Google did not return an access token.");
  return response.access_token;
}

async function main() {
  const options = {
    mode: null,
    key: path.join(MOBILE_DIR, "credentials/google-service-account.json"),
  };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n\n")[0]);
      return;
    }
    if (["--prepare", "--commit"].includes(arg)) {
      if (options.mode) throw new Error("Choose exactly one of --prepare or --commit.");
      options.mode = arg.slice(2);
    } else if (
      ["--aab", "--sha256", "--notes-file", "--images-receipt", "--receipt", "--key"].includes(arg)
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      const name = arg.slice(2);
      options[name] = name === "sha256" ? value.toLowerCase() : path.resolve(value);
    } else
      throw new Error("Unknown argument. No review cancellation or alternate track is supported.");
  }
  if (!options.mode || !options.receipt)
    throw new Error("Provide --prepare/--commit and --receipt.");
  const app = JSON.parse(readFileSync(path.join(MOBILE_DIR, "app.json"), "utf8")).expo;
  requireApp(app);
  if (options.mode === "prepare" && existsSync(options.receipt))
    throw new Error("Receipt already exists. Inspect instead of repeating an upload.");
  if (
    options.mode === "prepare" &&
    (!options.aab || !options["notes-file"] || !options["images-receipt"])
  )
    throw new Error("Prepare requires AAB, notes, and the approved image receipt.");
  const checkpoint = (receipt) =>
    writeFileSync(options.receipt, JSON.stringify(receipt, null, 2) + "\n");
  const token = await accessToken(options.key);
  if (options.mode === "prepare") {
    const images = JSON.parse(readFileSync(options["images-receipt"], "utf8"));
    if (images.packageName !== PACKAGE || images.commitStatus !== "committed")
      throw new Error("Expected the committed Kaata image-update receipt.");
    await prepareProduction(
      {
        app,
        aabPath: options.aab,
        sha256: options.sha256,
        notes: readFileSync(options["notes-file"], "utf8"),
        expectedImages: images.verification?.images,
        token,
      },
      { checkpoint },
    );
  } else {
    await commitProduction(
      { app, receipt: JSON.parse(readFileSync(options.receipt, "utf8")), token },
      { checkpoint },
    );
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Production submission stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
