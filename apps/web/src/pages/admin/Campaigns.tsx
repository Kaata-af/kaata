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
        description="Print a QR flyer per campaign, then read its funnel per source below."
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
  const qrBoxRef = useRef<HTMLDivElement>(null);
  const url = `https://kaata.af/download?s=${slug}`;

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
      title="QR generator"
      sub="one slug per flyer batch — the slug becomes the install source below"
    >
      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <label className="text-xs font-medium text-[#475467]" htmlFor="campaign-slug">
            Campaign slug
          </label>
          <input
            id="campaign-slug"
            value={slug}
            onChange={(e) => setSlug(sanitizeSlug(e.target.value))}
            placeholder="e.g. mandawi-flyer-1"
            className="w-full max-w-xs rounded-lg border border-[#eaecf0] px-3 py-2 text-sm text-[#101828] placeholder-[#98a2b3] focus:border-[#98a2b3] focus:outline-none"
          />
          <p className="break-all font-mono text-xs text-[#98a2b3]" dir="ltr">
            {slug ? url : "https://kaata.af/download?s=…"}
          </p>
          <div className="mt-1 flex gap-2">
            <button
              onClick={downloadSvg}
              disabled={!slug}
              className="rounded-lg bg-[#101828] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              Download SVG
            </button>
            <button
              onClick={downloadPng}
              disabled={!slug}
              className="rounded-lg border border-[#eaecf0] px-3 py-1.5 text-sm font-medium text-[#101828] hover:bg-[#f9fafb] disabled:opacity-40"
            >
              Download PNG
            </button>
          </div>
          <p className="text-xs text-[#98a2b3]">
            Scanning opens the download page with{" "}
            <span className="font-mono">?s={slug || "…"}</span>; the visit stamps that source onto
            installs made within 60 minutes on the same network.
          </p>
        </div>
        <div ref={qrBoxRef} className="flex shrink-0 items-center justify-center">
          {slug ? (
            <QRCodeSVG value={url} size={224} level="M" includeMargin className="rounded-lg" />
          ) : (
            <div className="flex h-[224px] w-[224px] items-center justify-center rounded-lg border border-dashed border-[#eaecf0] px-6 text-center text-xs text-[#98a2b3]">
              Type a slug to render the QR
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function PerformanceCard(props: { stats: Stats }) {
  // Sorted by attributed installs — the number that actually matters.
  const rows = [...props.stats.by_source].sort((a, b) => b.attributed - a.attributed);
  // Old backend without store_clicks → show the legacy APK-download column
  // honestly instead of zeros.
  const hasStore = props.stats.store_clicks !== undefined;
  const clicksLabel = hasStore ? "Store clicks" : "APK downloads (legacy)";
  return (
    <Card
      title="Campaign performance"
      sub="deduped web traffic and QR/IP-attributed installs per source"
    >
      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-[#98a2b3]">No web visits recorded yet.</p>
      ) : (
        <Table>
          <TableHead>
            <TableRow className="border-b border-[#eaecf0]">
              <TableHeaderCell className="px-0 py-2 text-xs text-[#98a2b3]">Source</TableHeaderCell>
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#98a2b3]">
                Visits
              </TableHeaderCell>
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#98a2b3]">
                {clicksLabel}
              </TableHeaderCell>
              <TableHeaderCell className="px-0 py-2 text-right text-xs text-[#98a2b3]">
                Installs
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
                  {r.source}
                </TableCell>
                <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#475467]">
                  {fmtInt(r.visits)}
                </TableCell>
                <TableCell className="px-0 py-2 text-right text-sm tabular-nums text-[#475467]">
                  {fmtInt(hasStore ? (r.store_clicks ?? 0) : r.downloads)}
                </TableCell>
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
    </Card>
  );
}
