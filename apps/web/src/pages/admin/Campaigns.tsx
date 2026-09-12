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
    <div>
      <PageHeader
        title="Campaigns"
        description="Create a trackable flyer link and see which campaigns bring installs."
      />
      <div className="flex flex-col gap-4">
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
      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <label className="text-xs font-medium text-[#475467]" htmlFor="campaign-slug">
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
            className="w-full max-w-sm rounded-lg border border-[#d0d5dd] px-3 py-2.5 text-sm text-[#101828] placeholder-[#98a2b3] focus:border-[#0c745a] focus:outline-none focus:ring-2 focus:ring-[#0c745a]/15"
          />
          <label className="text-xs font-medium text-[#475467]" htmlFor="campaign-link">
            Campaign link
          </label>
          <input
            id="campaign-link"
            readOnly
            value={slug ? url : ""}
            placeholder="Enter a campaign name to create the link"
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border border-[#eaecf0] bg-[#f9fafb] px-3 py-2 font-mono text-xs text-[#475467] focus:outline focus:outline-2 focus:outline-[#0c745a]"
            dir="ltr"
          />
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              onClick={downloadSvg}
              disabled={!slug}
              className="rounded-lg bg-[#0c745a] px-3 py-2 text-sm font-medium text-white hover:bg-[#095e49] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download SVG
            </button>
            <button
              onClick={downloadPng}
              disabled={!slug}
              className="rounded-lg border border-[#d0d5dd] px-3 py-2 text-sm font-medium text-[#344054] hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download PNG
            </button>
            <button
              onClick={() => void copyLink()}
              disabled={!slug}
              className="rounded-lg border border-[#d0d5dd] px-3 py-2 text-sm font-medium text-[#344054] hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {copyState === "copied" ? "Copied" : "Copy link"}
            </button>
          </div>
          <p role="status" className="text-xs text-[#667085]">
            {copyState === "failed"
              ? "Select the campaign link above to copy it manually."
              : copyState === "copied"
                ? "Campaign link copied to clipboard."
                : "SVG for print layouts; PNG for an image you can share."}
          </p>
          <p className="max-w-lg text-xs leading-relaxed text-[#667085]">
            A scan opens the download page. An install may be attributed to this campaign when its
            first check-in happens within 60 minutes on the same network.
          </p>
        </div>
        <div ref={qrBoxRef} className="flex shrink-0 items-center justify-center">
          {slug ? (
            <QRCodeSVG value={url} size={224} level="M" includeMargin className="rounded-lg" />
          ) : (
            <div className="flex h-[224px] w-[224px] items-center justify-center rounded-lg border border-dashed border-[#eaecf0] px-6 text-center text-xs text-[#98a2b3]">
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
          className="w-full rounded-lg border border-[#d0d5dd] px-3 py-2 text-sm text-[#344054] focus:border-[#0c745a] focus:outline-none focus:ring-2 focus:ring-[#0c745a]/15 sm:w-52"
        />
      }
    >
      {rows.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm font-medium text-[#344054]">
            {search ? "No matching campaign sources" : "No campaign traffic yet"}
          </p>
          <p className="mt-2 text-xs text-[#667085]">
            {search
              ? "Try another source name or clear your search."
              : "A source appears after its first recorded visit. Creating a QR alone does not add a row."}
          </p>
        </div>
      ) : (
        <Table style={{ minWidth: 640 }}>
          <TableHead>
            <TableRow className="border-b border-[#eaecf0]">
              <TableHeaderCell className="px-0 py-2 text-xs text-[#98a2b3]">Source</TableHeaderCell>
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#98a2b3]">
                Visits
              </TableHeaderCell>
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#98a2b3]">
                {clicksLabel}
              </TableHeaderCell>
              {hasExcluded ? (
                <TableHeaderCell
                  className="px-0 py-2 text-right text-xs text-[#98a2b3]"
                  title="Web hits excluded as operator or bot traffic, including test scans."
                >
                  Excluded
                </TableHeaderCell>
              ) : null}
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#98a2b3]">
                Attributed installs
              </TableHeaderCell>
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#98a2b3]">
                Visit → install
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.source} className="border-b border-[#f2f4f7] last:border-0">
                <TableCell className="px-0 py-2 text-sm font-medium text-[#101828]">
                  {r.source === "(direct)" ? "Direct / untagged" : r.source}
                </TableCell>
                <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#475467]">
                  {fmtInt(r.visits)}
                </TableCell>
                <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#475467]">
                  {fmtInt(hasStore ? (r.store_clicks ?? 0) : r.downloads)}
                </TableCell>
                {hasExcluded ? (
                  <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#98a2b3]">
                    {r.excluded ? fmtInt(r.excluded) : "—"}
                  </TableCell>
                ) : null}
                <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#101828]">
                  {fmtInt(r.attributed)}
                </TableCell>
                <TableCell className="px-0 py-2 text-right text-xs tabular-nums text-[#98a2b3]">
                  {fmtPct(r.attributed, r.visits)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {hasExcluded ? (
        <p className="pt-4 text-xs leading-relaxed text-[#667085]">
          Excluded hits include operator test scans, bots, and link previews. A browser keeps its
          first campaign source, so later scans on the same browser can remain attributed to an
          earlier campaign. Attribution is an estimate based on a shared network and a 60-minute
          window.
        </p>
      ) : null}
    </Card>
  );
}
