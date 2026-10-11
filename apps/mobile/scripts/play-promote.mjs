#!/usr/bin/env node
// Promote the current app.json versionCode from a Play testing track to
// production — the step `eas submit` cannot do.
//
// EAS Submit only UPLOADS a bundle to a track. Once a versionCode is on any
// track, Play refuses a second upload of it ("You've already submitted this
// version"), and EAS has no promote command. Play's own model is "one release,
// moved between tracks", which is the Edits API below: open an edit, assign
// the existing versionCode to the target track, commit. Same call sequence as
// the Console's "Promote release" button.
//
// Config is read, not duplicated: the package name and versionCode come from
// app.json; the service account is the SAME key EAS Submit uses
// (kaata-eas-deploy@…), kept in the gitignored credentials/ folder next to
// the Apple key.
//
//   node scripts/play-promote.mjs --dry-run
//   node scripts/play-promote.mjs
//   node scripts/play-promote.mjs --rollout 0.2        # staged: 20% of users
//
// Flags:
//   --from <track>     source track (default: alpha = Play "Closed testing")
//   --to <track>       target track (default: production)
//   --rollout <0-1>    staged rollout fraction; omit for 100% (status completed)
//   --key <path>       service-account JSON (default: credentials/google-service-account.json)
//   --notes-file <p>   "What's new" text to attach (see below)
//   --notes-lang <l>   locale for --notes-file, repeatable (default: en-US)
//   --dry-run          open the edit, show what would move, then discard it
//   --no-send          commit without sending the change for review
//                      (changesNotSentForReview=true), then press "Send changes
//                      for review" in Play Console, Publishing overview
//
// --no-send exists for a REJECTED app. Until a fix is sent, Play refuses any
// API commit that would send changes for review automatically ("Changes cannot
// be sent for review automatically"), so after the 2.1.0 build 49 rejection the
// fix had to be staged with it and sent once from the Console. Never make it
// the default: once the app is back in good standing Play refuses the flag
// instead, and a commit that is never sent never reaches anyone.
//
// RELEASE NOTES. Notes on the source release travel with it — but EAS Submit
// does not set any when it uploads, so a straight promote ships production
// with an EMPTY "What's new", and Play gives no way to fix that afterwards:
// notes belong to a release, and a live release cannot be edited. Hence
// --notes-file, which attaches them at promote time. Play caps each locale at
// 500 characters and rejects a locale the listing does not have, so this
// validates the length here and lets Play reject an unknown locale before the
// commit (a failed edit is discarded whole — nothing half-promotes).

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    from: "alpha",
    to: "production",
    rollout: null,
    key: path.join(MOBILE_DIR, "credentials", "google-service-account.json"),
    notesFile: null,
    notesLangs: [],
    dryRun: false,
    noSend: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") opts.from = argv[++i];
    else if (a === "--to") opts.to = argv[++i];
    else if (a === "--rollout") opts.rollout = Number(argv[++i]);
    else if (a === "--key") opts.key = path.resolve(argv[++i]);
    else if (a === "--notes-file") opts.notesFile = path.resolve(argv[++i]);
    else if (a === "--notes-lang") opts.notesLangs.push(argv[++i]);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-send") opts.noSend = true;
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n\n")[0]);
      process.exit(0);
    } else fail(`unknown flag: ${a}\nRun with --help for usage.`);
  }
  if (opts.rollout !== null && !(opts.rollout > 0 && opts.rollout < 1)) {
    fail("--rollout must be a fraction strictly between 0 and 1 (e.g. 0.2)");
  }
  return opts;
}

// ---------------------------------------------------------------- auth

const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function accessToken(keyPath) {
  let key;
  try {
    key = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (err) {
    fail(
      `cannot read the Play service-account key at ${keyPath}\n  ${err.message}\n` +
        `  credentials/ is gitignored — copy the kaata-eas-deploy JSON there, or pass --key.`,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64u(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: key.token_uri,
      iat: now,
      exp: now + 600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const assertion = `${header}.${claims}.${b64u(signer.sign(key.private_key))}`;
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    fail(`token exchange failed: HTTP ${res.status}\n  ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.access_token;
}

// ---------------------------------------------------------------- client

function makeClient(token, pkg) {
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}`;
  return async function play(method, endpoint, body) {
    const res = await fetch(base + endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const msg = json?.error?.message ?? text.slice(0, 600);
      fail(`${method} ${endpoint}\n  HTTP ${res.status}: ${msg}`);
    }
    return json;
  };
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
const app = JSON.parse(readFileSync(path.join(MOBILE_DIR, "app.json"), "utf8")).expo;
const pkg = app.android?.package;
const versionCode = String(app.android?.versionCode ?? "");
if (!pkg || !versionCode) fail("app.json has no android.package / android.versionCode");

console.log(`Kaata ${app.version} (versionCode ${versionCode}) — ${opts.from} -> ${opts.to}`);
if (opts.dryRun) console.log("DRY RUN — the edit is discarded, nothing changes\n");

const play = makeClient(await accessToken(opts.key), pkg);
const edit = await play("POST", "/edits", {});
const editId = edit.id;

try {
  const source = await play("GET", `/edits/${editId}/tracks/${opts.from}`);
  const sourceRelease = (source.releases ?? []).find((r) =>
    (r.versionCodes ?? []).includes(versionCode),
  );
  if (!sourceRelease) {
    const seen = (source.releases ?? [])
      .map((r) => `${(r.versionCodes ?? []).join("+")} (${r.status})`)
      .join(", ");
    fail(
      `versionCode ${versionCode} is not on the "${opts.from}" track.\n` +
        `  Releases there: ${seen || "none"}.\n` +
        `  Upload it first: eas build --profile production --platform android --auto-submit-with-profile testing`,
    );
  }
  console.log(
    `  source       ${opts.from}: release "${sourceRelease.name ?? "-"}" ${sourceRelease.status}`,
  );

  const target = await play("GET", `/edits/${editId}/tracks/${opts.to}`);
  const live = (target.releases ?? [])
    .map((r) => `${(r.versionCodes ?? []).join("+")} (${r.status})`)
    .join(", ");
  console.log(`  target       ${opts.to}: ${live || "empty"}`);
  if ((target.releases ?? []).some((r) => (r.versionCodes ?? []).includes(versionCode))) {
    console.log(`\n✓ versionCode ${versionCode} is already on ${opts.to}. Nothing to do.`);
    await play("DELETE", `/edits/${editId}`);
    process.exit(0);
  }

  // --notes-file wins over whatever the source release carries: the flag is an
  // explicit instruction for THIS promotion, the source notes are a leftover.
  let releaseNotes = sourceRelease.releaseNotes ?? null;
  if (opts.notesFile) {
    const text = readFileSync(opts.notesFile, "utf8").trim();
    if (!text) fail(`--notes-file is empty: ${opts.notesFile}`);
    if (text.length > 500) {
      fail(
        `release notes are ${text.length} characters; Play's limit is 500 per locale.\n` +
          `  Shorten ${opts.notesFile} — Play rejects the whole edit otherwise.`,
      );
    }
    const langs = opts.notesLangs.length ? opts.notesLangs : ["en-US"];
    releaseNotes = langs.map((language) => ({ language, text }));
  }

  const release = {
    name: sourceRelease.name ?? app.version,
    versionCodes: [versionCode],
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(opts.rollout === null
      ? { status: "completed" }
      : { status: "inProgress", userFraction: opts.rollout }),
  };
  console.log(
    `  promote      ${release.name}: ${release.status}${opts.rollout === null ? " (100%)" : ` (${Math.round(opts.rollout * 100)}%)`}` +
      `${release.releaseNotes ? `, notes: ${release.releaseNotes.map((n) => n.language).join(", ")}` : ", NO release notes"}`,
  );

  if (opts.dryRun) {
    await play("DELETE", `/edits/${editId}`);
    console.log("\nDry run clean. Re-run without --dry-run to promote.");
    process.exit(0);
  }

  await play("PUT", `/edits/${editId}/tracks/${opts.to}`, {
    track: opts.to,
    releases: [release],
  });
  await play(
    "POST",
    `/edits/${editId}:commit${opts.noSend ? "?changesNotSentForReview=true" : ""}`,
    undefined,
  );
  console.log(`\n✓ ${app.version} (${versionCode}) is on ${opts.to}.`);
  if (opts.noSend) {
    console.log(
      "  NOT sent for review. Play Console → Publishing overview → Send changes for review\n" +
        "  (once, after every track you are changing has been staged).",
    );
  } else {
    console.log(
      opts.rollout === null
        ? "  Play publishes it to everyone after its own review, usually within a few hours."
        : `  Staged at ${Math.round(opts.rollout * 100)}%; raise it later in the Play Console or re-run with a higher --rollout.`,
    );
  }
} catch (err) {
  // A failed edit must not linger — Play keeps at most one open edit per app.
  await play("DELETE", `/edits/${editId}`).catch(() => {});
  throw err;
}
