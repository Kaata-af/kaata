// Shared chrome for the admin dashboard — quiet-fintech light theme matching
// the public site (CustomerView palette): ink #101828, borders #eaecf0, white
// Tremor cards, Inter, tabular-nums on every number.

import type { ReactNode } from "react";
import { REPORTING_TIME_ZONE } from "./dates";

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
  teal: "#199e70", // resurrected / installs series
  red: "#e34948", // churned
  gray: "#d0d5dd", // unknown locale, subtle segments
};

// Tremor receives the hex values above at runtime and emits Tailwind
// ARBITRARY-VALUE classes (fill-[#2a78d6], bg-[#2a78d6], …) that the content
// scanner cannot discover in node_modules (they're template-built). The
// literal class names below exist ONLY so Tailwind generates their CSS —
// keep this block in sync with `C`:
//
// bg-[#2a78d6] text-[#2a78d6] fill-[#2a78d6] stroke-[#2a78d6]
// bg-[#008300] text-[#008300] fill-[#008300] stroke-[#008300]
// bg-[#199e70] text-[#199e70] fill-[#199e70] stroke-[#199e70]
// bg-[#e34948] text-[#e34948] fill-[#e34948] stroke-[#e34948]
// bg-[#d0d5dd] text-[#d0d5dd] fill-[#d0d5dd] stroke-[#d0d5dd]
// bg-[#101828] text-[#101828] fill-[#101828] stroke-[#101828]

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
  return d.toLocaleDateString(undefined, {
    timeZone: REPORTING_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// "last seen" relative label + whether the device is effectively online now
// (checked in within 10 min — the app re-checks-in on foreground). Preserved
// from the old dashboard so the green "online" label means the same thing.
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

// Recency status for the Users table dot: green = seen within 7 days,
// amber = within 30, gray = colder than that (or never seen).
export type SeenStatus = "green" | "amber" | "gray";
export function seenStatus(iso: string): SeenStatus {
  if (!iso) return "gray";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return "gray";
  if (ms < 7 * 86_400_000) return "green";
  if (ms < 30 * 86_400_000) return "amber";
  return "gray";
}
export const SEEN_DOT: Record<SeenStatus, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  gray: "bg-gray-300",
};

export function Card(props: {
  title?: string;
  sub?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section
      className={`min-w-0 w-full max-w-full rounded-2xl border border-[#e4e7ec] bg-white p-4 shadow-[0_2px_8px_-4px_rgba(16,24,40,0.08)] sm:p-5 ${props.className ?? ""}`}
    >
      {props.title ? (
        <div className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-3 sm:mb-5">
          <div className="min-w-0 max-w-full">
            <h2 className="break-words text-[15px] font-semibold tracking-[-0.01em] text-[#101828]">
              {props.title}
            </h2>
            {props.sub ? (
              <p className="mt-1 max-w-2xl break-words text-xs leading-relaxed text-[#667085]">
                {props.sub}
              </p>
            ) : null}
          </div>
          {props.action ? <div className="min-w-0 max-w-full">{props.action}</div> : null}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

// Pulse skeleton — one per card while its query is pending.
export function Skeleton(props: { className?: string }) {
  return (
    <div
      className={`max-w-full animate-pulse rounded-lg bg-[#f2f4f7] ${props.className ?? "h-24"}`}
    />
  );
}

export function SkeletonCard(props: { lines?: number; className?: string }) {
  return (
    <div
      className={`min-w-0 max-w-full rounded-2xl border border-[#e4e7ec] bg-white p-4 sm:p-5 ${props.className ?? ""}`}
      aria-label="Loading dashboard data"
      role="status"
    >
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
    <div
      role="alert"
      className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-4 rounded-2xl border border-red-100 bg-red-50/50 p-4 sm:p-5"
    >
      <div className="min-w-0 break-words text-sm text-[#475467]">{props.message}</div>
      <button
        onClick={props.onRetry}
        className="min-h-11 shrink-0 rounded-lg border border-[#eaecf0] px-3 py-1.5 text-sm font-medium text-[#101828] hover:bg-[#f9fafb]"
      >
        Retry
      </button>
    </div>
  );
}

// Section page header — title + one-line description, per the spec IA.
export function PageHeader(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <header className="mb-5 flex min-w-0 max-w-full flex-wrap items-start justify-between gap-3 sm:mb-7 sm:gap-4">
      <div className="min-w-0 max-w-full">
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-[#101828] sm:text-[30px]">
          {props.title}
        </h1>
        <p className="mt-2 max-w-2xl break-words text-sm leading-relaxed text-[#667085]">
          {props.description}
        </p>
      </div>
      {props.action ? <div className="min-w-0 max-w-full">{props.action}</div> : null}
    </header>
  );
}
