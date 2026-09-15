// Campaigns — flyer marketing tooling. A QR generator (all client-side: SVG
// rendered by qrcode.react, PNG rasterized through a local canvas — no
// external calls, CSP-safe) plus the per-source performance table so the
// operator prints a flyer and reads its results on one page.
//
// Attribution chain the QR relies on: scanning opens
// https://kaata.af/download?s=<slug> → the backend logs a web_visit with that
// source → the first check-in from the same network (IP) within 60 minutes
// stamps the source onto the install (see backend internal/checkin/service.go).

import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@tremor/react";
import { QRCodeSVG } from "qrcode.react";
import { useRef, useState } from "react";
import { useStats, type Stats } from "./api";
import { Card, ErrorCard, PageHeader, SkeletonCard, fmtInt, fmtPct } from "./ui";

// Lowercase + URL-unreserved characters only (a-z 0-9 - . _ ~); spaces become
// hyphens as you type. Applied live in onChange so the input can never hold an
// invalid slug.
function sanitizeSlug(v: string): string {
  return v
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._~-]/g, "")
    .slice(0, 40);
}

export function Campaigns() {
  const stats = useStats();
  return (
    <div className="min-w-0 max-w-full">
      <PageHeader
        title="Campaigns"
        description="Create a trackable flyer link and see which campaigns bring installs."
      />
      <div className="flex min-w-0 flex-col gap-4">
        <QrGeneratorCard />
        {stats.isPending ? (
          <SkeletonCard lines={4} />
        ) : stats.isError ? (
          <ErrorCard message="Couldn't load campaign data." onRetry={() => void stats.refetch()} />
        ) : (
          <PerformanceCard stats={stats.data} />
        )}
      </div>
    </div>
  );
}

function QrGeneratorCard() {
  const [slug, setSlug] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const qrBoxRef = useRef<HTMLDivElement>(null);
  const url = `https://kaata.af/download?s=${slug}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function serializeSvg(): string | null {
    const svg = qrBoxRef.current?.querySelector("svg");
    return svg ? new XMLSerializer().serializeToString(svg) : null;
  }

  function downloadBlob(blob: Blob, filename: string) {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Deferred revoke — revoking synchronously races the download in Safari.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }

  function downloadSvg() {
    const xml = serializeSvg();
    if (!xml) return;
    downloadBlob(new Blob([xml], { type: "image/svg+xml" }), `kaata-qr-${slug}.svg`);
  }

  // PNG = the same SVG serialized into an <img>, drawn onto a canvas at print
  // resolution, exported via toBlob. Entirely local; the data: URI keeps it
  // inside the page's CSP (no fetch, no external host).
  function downloadPng() {
    const xml = serializeSvg();
    if (!xml) return;
    const img = new Image();
    img.onload = () => {
      const px = 1024;
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, px, px);
      ctx.drawImage(img, 0, 0, px, px);
      canvas.toBlob((b) => {
        if (b) downloadBlob(b, `kaata-qr-${slug}.png`);
      }, "image/png");
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  }

  return (
    <Card
      title="Create a campaign QR"
      sub="Use a different campaign name for each location or flyer batch"
    >
      <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <label className="text-xs font-medium text-[#525252]" htmlFor="campaign-slug">
            Campaign name
          </label>
          <input
            id="campaign-slug"
            value={slug}
            onChange={(e) => {
              setSlug(sanitizeSlug(e.target.value));
              setCopyState("idle");
            }}
            placeholder="e.g. mandawi-flyer-1"
            className="min-h-11 min-w-0 w-full max-w-sm rounded-lg border border-[#e5e5e5] px-3 py-2.5 text-base text-[#171717] placeholder-[#a3a3a3] focus:border-[#171717] focus:outline-none focus:ring-2 focus:ring-[#171717]/15 sm:text-sm"
          />
          <label className="text-xs font-medium text-[#525252]" htmlFor="campaign-link">
            Campaign link
          </label>
          <input
            id="campaign-link"
            readOnly
            value={slug ? url : ""}
            placeholder="Enter a campaign name to create the link"
            onFocus={(e) => e.currentTarget.select()}
            className="min-h-11 min-w-0 w-full rounded-lg border border-[#e5e5e5] bg-[#fafafa] px-3 py-2 font-mono text-base text-[#525252] focus:outline focus:outline-2 focus:outline-[#171717] sm:text-xs"
            dir="ltr"
          />
          <div className="mt-1 grid min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <button
              onClick={downloadSvg}
              disabled={!slug}
              className="min-h-11 min-w-0 rounded-lg bg-emerald-500 px-2 py-2 text-sm font-medium text-white hover:bg-[#095e49] disabled:cursor-not-allowed disabled:opacity-40 sm:px-3"
            >
              Download SVG
            </button>
            <button
              onClick={downloadPng}
              disabled={!slug}
              className="min-h-11 min-w-0 rounded-lg border border-[#e5e5e5] px-2 py-2 text-sm font-medium text-[#404040] hover:bg-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40 sm:px-3"
            >
              Download PNG
            </button>
            <button
              onClick={() => void copyLink()}
              disabled={!slug}
              className="col-span-2 min-h-11 min-w-0 rounded-lg border border-[#e5e5e5] px-2 py-2 text-sm font-medium text-[#404040] hover:bg-[#fafafa] disabled:cursor-not-allowed disabled:opacity-40 sm:px-3"
            >
              {copyState === "copied" ? "Copied" : "Copy link"}
            </button>
          </div>
          <p role="status" className="text-xs text-[#737373]">
            {copyState === "failed"
              ? "Select the campaign link above to copy it manually."
              : copyState === "copied"
                ? "Campaign link copied to clipboard."
                : "SVG for print layouts; PNG for an image you can share."}
          </p>
          <p className="max-w-lg text-xs leading-relaxed text-[#737373]">
            A scan opens the download page. An install may be attributed to this campaign when its
            first check-in happens within 60 minutes on the same network.
          </p>
        </div>
        <div
          ref={qrBoxRef}
          className="flex min-w-0 w-full max-w-[224px] shrink-0 items-center justify-center self-center"
        >
          {slug ? (
            <QRCodeSVG
              value={url}
              size={224}
              level="M"
              includeMargin
              className="h-auto max-w-full rounded-lg"
            />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-[#e5e5e5] px-5 text-center text-xs text-[#a3a3a3]">
              Your campaign QR will appear here
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function PerformanceCard(props: { stats: Stats }) {
  const [search, setSearch] = useState("");
  // Sorted by attributed installs — the number that actually matters — but
  // falling through to visits and then EXCLUDED traffic. That last key is what
  // keeps a just-printed campaign findable: its only traffic is likely to be
  // the operator's own test scan, which is excluded from every real count, so
  // sorting on installs alone buried it at the bottom of the table.
  const allRows = [...props.stats.by_source].sort(
    (a, b) =>
      b.attributed - a.attributed || b.visits - a.visits || (b.excluded ?? 0) - (a.excluded ?? 0),
  );
  const rows = allRows.filter((row) =>
    row.source.toLowerCase().includes(search.trim().toLowerCase()),
  );
  // Old backend without per-source exclusion counts → hide the column rather
  // than render a wall of zeros that means "unknown", not "none".
  const hasExcluded = allRows.some((r) => r.excluded !== undefined);
  // Old backend without store_clicks → show the legacy APK-download column
  // honestly instead of zeros.
  const hasStore = props.stats.store_clicks !== undefined;
  const clicksLabel = hasStore ? "Store clicks" : "APK downloads (legacy)";
  return (
    <Card
      title="Campaign performance"
      sub="All-time web traffic and attributed installs, ordered by installs"
      action={
        <input
          aria-label="Search campaign sources"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sources…"
          className="min-h-11 min-w-0 w-full max-w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-base text-[#404040] focus:border-[#171717] focus:outline-none focus:ring-2 focus:ring-[#171717]/15 sm:w-52 sm:text-sm"
        />
      }
    >
      {rows.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm font-medium text-[#404040]">
            {search ? "No matching campaign sources" : "No campaign traffic yet"}
          </p>
          <p className="mt-2 text-xs text-[#737373]">
            {search
              ? "Try another source name or clear your search."
              : "A source appears after its first recorded visit. Creating a QR alone does not add a row."}
          </p>
        </div>
      ) : (
        <Table className="min-w-0 max-w-full overscroll-x-contain" style={{ minWidth: 640 }}>
          <TableHead>
            <TableRow className="border-b border-[#e5e5e5]">
              <TableHeaderCell className="px-0 py-2 text-xs text-[#a3a3a3]">Source</TableHeaderCell>
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#a3a3a3]">
                Visits
              </TableHeaderCell>
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#a3a3a3]">
                {clicksLabel}
              </TableHeaderCell>
              {hasExcluded ? (
                <TableHeaderCell
                  className="px-0 py-2 text-right text-xs text-[#a3a3a3]"
                  title="Web hits excluded as operator or bot traffic, including test scans."
                >
                  Excluded
                </TableHeaderCell>
              ) : null}
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#a3a3a3]">
                Attributed installs
              </TableHeaderCell>
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#a3a3a3]">
                Visit → install
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.source} className="border-b border-[#f5f5f5] last:border-0">
                <TableCell className="whitespace-normal px-0 py-3 pr-4 text-sm font-medium text-[#171717]">
                  <span className="block max-w-52 break-words [overflow-wrap:anywhere]">
                    {r.source === "(direct)" ? "Direct / untagged" : r.source}
                  </span>
                </TableCell>
                <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#525252]">
                  {fmtInt(r.visits)}
                </TableCell>
                <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#525252]">
                  {fmtInt(hasStore ? (r.store_clicks ?? 0) : r.downloads)}
                </TableCell>
                {hasExcluded ? (
                  <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#a3a3a3]">
                    {r.excluded ? fmtInt(r.excluded) : "—"}
                  </TableCell>
                ) : null}
                <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#171717]">
                  {fmtInt(r.attributed)}
                </TableCell>
                <TableCell className="px-0 py-2 text-right text-xs tabular-nums text-[#a3a3a3]">
                  {fmtPct(r.attributed, r.visits)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {hasExcluded ? (
        <p className="pt-4 text-xs leading-relaxed text-[#737373]">
          Excluded hits include operator test scans, bots, and link previews. A browser keeps its
          first campaign source, so later scans on the same browser can remain attributed to an
          earlier campaign. Attribution is an estimate based on a shared network and a 60-minute
          window.
        </p>
      ) : null}
    </Card>
  );
}
