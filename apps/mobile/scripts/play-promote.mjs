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
//   --dry-run          open the edit, show what would move, then discard it
//
// Release notes attached to the source release travel with it.

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
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") opts.from = argv[++i];
    else if (a === "--to") opts.to = argv[++i];
    else if (a === "--rollout") opts.rollout = Number(argv[++i]);
    else if (a === "--key") opts.key = path.resolve(argv[++i]);
    else if (a === "--dry-run") opts.dryRun = true;
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

  const release = {
    name: sourceRelease.name ?? app.version,
    versionCodes: [versionCode],
    ...(sourceRelease.releaseNotes ? { releaseNotes: sourceRelease.releaseNotes } : {}),
    ...(opts.rollout === null
      ? { status: "completed" }
      : { status: "inProgress", userFraction: opts.rollout }),
  };
  console.log(
    `  promote      ${release.name}: ${release.status}${opts.rollout === null ? " (100%)" : ` (${Math.round(opts.rollout * 100)}%)`}` +
      `${release.releaseNotes ? `, ${release.releaseNotes.length} release-note locale(s)` : ""}`,
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
  await play("POST", `/edits/${editId}:commit`, undefined);
  console.log(`\n✓ ${app.version} (${versionCode}) is on ${opts.to}.`);
  console.log(
    opts.rollout === null
      ? "  Play publishes it to everyone after its own review, usually within a few hours."
      : `  Staged at ${Math.round(opts.rollout * 100)}%; raise it later in the Play Console or re-run with a higher --rollout.`,
  );
} catch (err) {
  // A failed edit must not linger — Play keeps at most one open edit per app.
  await play("DELETE", `/edits/${editId}`).catch(() => {});
  throw err;
}
