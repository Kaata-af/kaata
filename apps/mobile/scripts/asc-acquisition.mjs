// Run from the release workstation. --import uses KAATA_ADMIN_API_KEY to send
// only per-day counts to Kaata. The Apple signing key stays on this machine.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appleAPI = "https://api.appstoreconnect.apple.com";
const kaataAPI = "https://api.kaata.af/v1/admin/acquisition/apple-downloads";
const channels = new Set(["facebook_ads", "organic_posts", "bill_share"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const maxSegmentBytes = 32 * 1024 * 1024;

function appleClient(config) {
  const key = createPrivateKey(readFileSync(resolve(mobileDir, config.ascApiKeyPath)));
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  function token() {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: "ES256", kid: config.ascApiKeyId, typ: "JWT" })}.${b64({ iss: config.ascApiKeyIssuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
    const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
    return `${input}.${signature.toString("base64url")}`;
  }
  async function request(path, data) {
    const url = new URL(path, appleAPI);
    if (url.origin !== appleAPI || !url.pathname.startsWith("/v1/")) {
      throw new Error("Unexpected Apple API page URL");
    }
    const response = await fetch(url, {
      method: data ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: data ? JSON.stringify({ data }) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Apple Analytics API returned HTTP ${response.status}`);
    return response.json();
  }
  async function list(path) {
    const items = [];
    for (let pages = 0; path; pages++) {
      if (pages >= 100) throw new Error("Apple returned too many pages");
      const result = await request(path);
      if (!Array.isArray(result.data)) throw new Error("Unexpected Apple Analytics API response");
      items.push(...result.data);
      path = result.links?.next;
    }
    return items;
  }
  return { request, list };
}

// A newer processing date replaces the entire event-date partition. Track a
// partition even when it contains no published row for the three campaigns.
export function readAppleDownloads(tsvs, appId) {
  const days = new Map();
  for (const tsv of tsvs) {
    const [header, ...lines] = tsv.trimEnd().split(/\r?\n/);
    const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const columns = header.split("\t").map(normalize);
    const indexes = ["date", "appappleidentifier", "downloadtype", "campaign", "counts"].map(
      (column) => columns.indexOf(column),
    );
    if (indexes.includes(-1)) throw new Error("Apple Downloads Detailed columns have changed");
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = line.split("\t");
      const [date, app, type, campaign, count] = indexes.map((index) => row[index]);
      if (app !== appId) continue;
      if (!datePattern.test(date) || count === undefined)
        throw new Error("Invalid Apple download row");
      if (!days.has(date)) days.set(date, {});
      if (normalize(type) !== "firsttimedownload" || !channels.has(campaign)) continue;
      const number = Number(count);
      if (!/^\d+$/.test(count) || !Number.isSafeInteger(number)) {
        throw new Error("Invalid Apple campaign download count");
      }
      const counts = days.get(date);
      counts[campaign] = (counts[campaign] ?? 0) + number;
      if (counts[campaign] > 2147483647)
        throw new Error("Apple campaign count exceeds the import limit");
    }
  }
  return days;
}

async function readSegment(segment) {
  const { url: rawURL, sizeInBytes } = segment.attributes;
  const url = new URL(rawURL);
  if (url.protocol !== "https:" || url.username || url.password || sizeInBytes > maxSegmentBytes) {
    throw new Error("Invalid or oversized Apple report segment");
  }
  // Apple gives an expiring download URL. Never attach the API credential to it.
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Apple report download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxSegmentBytes)
    throw new Error("Apple report segment exceeds the import limit");
  return bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes, { maxOutputLength: maxSegmentBytes }).toString("utf8")
    : bytes.toString("utf8");
}

async function main(args) {
  if (args.length !== 1 || !["--enable", "--preview", "--import"].includes(args[0])) {
    throw new Error(
      "Usage: node apps/mobile/scripts/asc-acquisition.mjs --enable|--preview|--import",
    );
  }
  const [mode] = args;
  const cfg = JSON.parse(readFileSync(resolve(mobileDir, "eas.json"), "utf8")).submit.production
    .ios;
  const appId = String(cfg.ascAppId);
  const apple = appleClient(cfg);
  const requests = await apple.list(
    `/v1/apps/${encodeURIComponent(appId)}/analyticsReportRequests`,
  );
  const ongoing = requests.find(
    (entry) =>
      entry.attributes.accessType === "ONGOING" && !entry.attributes.stoppedDueToInactivity,
  );
  if (mode === "--enable") {
    if (!ongoing) {
      await apple.request("/v1/analyticsReportRequests", {
        type: "analyticsReportRequests",
        attributes: { accessType: "ONGOING" },
        relationships: { app: { data: { type: "apps", id: appId } } },
      });
    }
    console.log("Ongoing Apple analytics reports are enabled for Kaata.");
    return;
  }
  if (!ongoing) throw new Error("Enable ongoing Apple reports with --enable first");
  const reports = await apple.list(`/v1/analyticsReportRequests/${ongoing.id}/reports?limit=200`);
  const report = reports.find((entry) =>
    /^App Store Downloads Detailed$/i.test(entry.attributes.name),
  );
  const instances = report
    ? await apple.list(
        `/v1/analyticsReports/${report.id}/instances?filter%5Bgranularity%5D=DAILY&limit=200`,
      )
    : [];
  const days = new Map();
  for (const instance of instances.sort((a, b) =>
    a.attributes.processingDate.localeCompare(b.attributes.processingDate),
  )) {
    const processingDate = instance.attributes.processingDate;
    if (!datePattern.test(processingDate)) throw new Error("Invalid Apple report processing date");
    const segments = await apple.list(
      `/v1/analyticsReportInstances/${instance.id}/segments?limit=200`,
    );
    const tsvs = [];
    for (const segment of segments) tsvs.push(await readSegment(segment));
    for (const [date, downloads] of readAppleDownloads(tsvs, appId)) {
      days.set(date, { date, processing_date: processingDate, downloads });
    }
  }
  if (days.size === 0) {
    console.log("Apple has not published daily download data for Kaata yet.");
    return;
  }
  const payload = { days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  if (mode === "--preview") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const adminKey = process.env.KAATA_ADMIN_API_KEY?.trim();
  if (!adminKey) throw new Error("KAATA_ADMIN_API_KEY is required for --import");
  const response = await fetch(kaataAPI, {
    method: "PUT",
    headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Kaata acquisition import returned HTTP ${response.status}`);
  console.log(`Imported ${days.size} days of Apple campaign data into Kaata.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
