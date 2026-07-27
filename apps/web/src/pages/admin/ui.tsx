// Shared chrome for the admin dashboard — quiet-fintech light theme matching
// the public site (CustomerView palette): ink #101828, borders #eaecf0, white
// cards, Inter, tabular-nums on every number.

import type { ReactNode } from "react";

// Palette. Chart series colors were validated with the dataviz six-checks
// script (CVD ΔE ≥ 15, all ≥ 3:1 on white) — don't swap hues casually.
export const C = {
  ink: "#101828",
  sub: "#475467",
  mut: "#98a2b3",
  line: "#eaecf0",
  hair: "#f2f4f7",
  blue: "#2a78d6", // retained / active / English
  green: "#008300", // new / Dari
  teal: "#199e70", // resurrected
  red: "#e34948", // churned
  gray: "#d0d5dd", // unknown locale, subtle install bars
};

export function fmtInt(n: number | undefined | null): string {
  return n == null ? "—" : n.toLocaleString();
}

// Percent with at most 1 decimal; "—" for empty denominators so a 0/0 window
// never reads as a misleading 0%.
export function fmtPct(n: number, d: number): string {
  if (!d) return "—";
  const v = (n / d) * 100;
  return `${v >= 99.95 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)}%`;
}

export function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// "last seen" relative label + whether the device is effectively online now
// (checked in within 10 min — the app re-checks-in on foreground). Preserved
// from the old dashboard so the green dot means the same thing.
export function lastSeenInfo(iso: string): { label: string; online: boolean } {
  if (!iso) return { label: "never", online: false };
  const ms = Date.now() - new Date(iso).getTime();
  const online = ms >= 0 && ms < 10 * 60_000;
  let label: string;
  if (ms < 60_000) label = "just now";
  else if (ms < 3_600_000) label = `${Math.floor(ms / 60_000)}m ago`;
  else if (ms < 86_400_000) label = `${Math.floor(ms / 3_600_000)}h ago`;
  else label = `${Math.floor(ms / 86_400_000)}d ago`;
  return { label, online };
}

export function Card(props: {
  title?: string;
  sub?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-[#eaecf0] bg-white p-5 ${props.className ?? ""}`}>
      {props.title ? (
        <div className="mb-3">
          <div className="text-sm font-semibold text-[#101828]">{props.title}</div>
          {props.sub ? <div className="mt-0.5 text-xs text-[#98a2b3]">{props.sub}</div> : null}
        </div>
      ) : null}
      {props.children}
    </div>
  );
}

// Pulse skeleton — one per card while its query is pending.
export function Skeleton(props: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-[#f2f4f7] ${props.className ?? "h-24"}`} />;
}

export function SkeletonCard(props: { lines?: number; className?: string }) {
  return (
    <div className={`rounded-xl border border-[#eaecf0] bg-white p-5 ${props.className ?? ""}`}>
      <Skeleton className="mb-3 h-4 w-32" />
      {Array.from({ length: props.lines ?? 3 }).map((_, i) => (
        <Skeleton key={i} className="mb-2 h-3 w-full" />
      ))}
    </div>
  );
}

// Per-query error state with retry — every section renders one of these
// instead of its cards when its query fails (network, 5xx).
export function ErrorCard(props: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-[#eaecf0] bg-white p-5">
      <div className="text-sm text-[#475467]">{props.message}</div>
      <button
        onClick={props.onRetry}
        className="shrink-0 rounded-lg border border-[#eaecf0] px-3 py-1.5 text-sm font-medium text-[#101828] hover:bg-[#f9fafb]"
      >
        Retry
      </button>
    </div>
  );
}

// Label + count + horizontal proportion bar (adoption rows, language split).
export function ProportionRow(props: {
  label: string;
  n: number;
  total: number;
  color?: string;
  subLabel?: string;
}) {
  const frac = props.total > 0 ? Math.min(1, props.n / props.total) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="w-40 shrink-0 truncate text-sm text-[#475467]">{props.label}</div>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#f2f4f7]">
        <div
          className="h-2 rounded-full"
          style={{ width: `${frac * 100}%`, background: props.color ?? C.ink }}
        />
      </div>
      <div className="w-24 shrink-0 text-right text-sm tabular-nums text-[#101828]">
        {fmtInt(props.n)}
        <span className="ml-1 text-xs text-[#98a2b3]">{fmtPct(props.n, props.total)}</span>
      </div>
      {props.subLabel ? (
        <div className="w-16 shrink-0 text-right text-xs text-[#98a2b3]">{props.subLabel}</div>
      ) : null}
    </div>
  );
}

// Section page header — title + one-line description, per the spec IA.
export function PageHeader(props: { title: string; description: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-xl font-semibold text-[#101828]">{props.title}</h1>
      <p className="mt-1 text-sm text-[#98a2b3]">{props.description}</p>
    </header>
  );
}
