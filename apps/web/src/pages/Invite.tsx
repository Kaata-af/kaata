import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { getInviteInfo, type InviteInfo, type InviteInfoError } from "../lib/api";

// /i/:token landing for vault invites. Purely informational; actual
// acceptance happens in the mobile app via POST /v1/vaults/invites/accept.
//   - On mobile: surface a deep-link button to kaata://invite/<token> and
//     a download fallback for users without the app.
//   - On desktop: instruct the user to open Kaata on their phone with the
//     token shown.
export function Invite() {
  const { token = "" } = useParams<{ token: string }>();
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ok"; info: InviteInfo } | { kind: "error"; err: InviteInfoError }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getInviteInfo(token);
      if (cancelled) return;
      if (result.ok) setState({ kind: "ok", info: result.info });
      else setState({ kind: "error", err: result.error });
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main>
      <SiteHeader />
      <section className="px-6 py-16 md:py-24 max-w-xl mx-auto">
        {state.kind === "loading" && <LoadingView />}
        {state.kind === "error" && <ErrorView err={state.err} />}
        {state.kind === "ok" && <DetailsView info={state.info} token={token} />}
      </section>
      <SiteFooter />
    </main>
  );
}

function LoadingView() {
  return (
    <div className="text-center">
      <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
        Loading invitation
      </p>
      <div className="mx-auto h-2 w-32 rounded-full bg-neutral-200 overflow-hidden">
        <div className="h-full w-1/2 bg-neutral-900 animate-pulse" />
      </div>
    </div>
  );
}

function ErrorView({ err }: { err: InviteInfoError }) {
  let title = "This invitation isn't available";
  let body =
    "It may have expired, been revoked, or already been accepted. Ask the person who invited you to send a new link.";

  if (err.kind === "rate_limited") {
    title = "Too many tries";
    body =
      "We've throttled this link for the moment. Wait a minute and reload, or ask the inviter to send a fresh link.";
  } else if (err.kind === "network") {
    title = "Can't reach Kaata";
    body =
      "Check your connection and reload the page. If the problem persists, ask the inviter to resend.";
  } else if (err.kind === "server") {
    title = "Something went wrong";
    body = "Reload the page in a minute. If it keeps failing, ask the inviter to resend.";
  }

  return (
    <div className="text-center">
      <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
        Invitation
      </p>
      <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-neutral-900">{title}</h1>
      <p className="mt-5 text-base text-neutral-600 leading-relaxed">{body}</p>
      <Link
        to="/"
        className="mt-10 inline-block text-sm text-neutral-600 hover:text-neutral-900 transition-colors font-medium"
      >
        Back to Kaata
      </Link>
    </div>
  );
}

function DetailsView({ info, token }: { info: InviteInfo; token: string }) {
  const onMobile = useIsMobile();
  const deepLink = `kaata://invite/${encodeURIComponent(token)}`;
  const roleLabel = ROLE_LABELS[info.role] ?? info.role;
  const expiresRelative = useMemo(() => formatExpiresIn(info.expires_at), [info.expires_at]);

  return (
    <div className="text-center">
      <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
        You're invited
      </p>
      <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-neutral-900 leading-tight">
        Join <span className="text-neutral-900">{info.vault_name}</span>
        <span className="block text-neutral-500 mt-1 text-2xl md:text-3xl">as {roleLabel}</span>
      </h1>

      <dl className="mt-10 grid grid-cols-1 gap-4 text-left max-w-sm mx-auto">
        <Row label="Invited by" value={info.inviter_name || info.inviter_email_redacted} />
        {info.inviter_name && info.inviter_email_redacted && (
          <Row label="Email" value={info.inviter_email_redacted} />
        )}
        <Row label="Expires" value={expiresRelative} />
      </dl>

      <div className="mt-12">
        {onMobile ? <MobileActions deepLink={deepLink} /> : <DesktopActions token={token} />}
      </div>

      <p className="mt-10 text-xs text-neutral-400 leading-relaxed">
        Kaata never shows your ledger to anyone outside the people you invite. Accepting this
        invitation lets {roleLabel === "viewer" ? "you view" : "you edit"} this shop's entries on
        your device.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-neutral-100 pb-3">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 self-end">
        {label}
      </dt>
      <dd className="text-sm text-neutral-900 font-medium text-right break-words min-w-0">
        {value}
      </dd>
    </div>
  );
}

function MobileActions({ deepLink }: { deepLink: string }) {
  return (
    <div className="flex flex-col gap-3">
      <a
        href={deepLink}
        className="inline-flex justify-center items-center bg-neutral-900 text-white font-medium px-5 h-12 rounded-lg ring-0 ring-neutral-100 hover:ring-4 transition-[box-shadow] text-[15px]"
      >
        Open in Kaata
      </a>
      <Link
        to="/download"
        className="inline-flex justify-center items-center text-neutral-700 hover:text-neutral-900 font-medium px-5 h-11 rounded-lg border border-neutral-200 hover:border-neutral-300 transition-colors text-[14px]"
      >
        Don't have Kaata yet? Download
      </Link>
      <p className="mt-1 text-xs text-neutral-400 leading-relaxed">
        After installing, return to this page and tap "Open in Kaata".
      </p>
    </div>
  );
}

function DesktopActions({ token }: { token: string }) {
  return (
    <div className="flex flex-col gap-3 items-center">
      <p className="text-sm text-neutral-600">
        Open Kaata on your phone, then paste this code into <em>Pending invitations</em>:
      </p>
      <div
        className="font-mono text-sm text-neutral-900 bg-neutral-100 rounded-lg px-4 py-3 max-w-full break-all border border-neutral-200"
        aria-label="Invitation code"
      >
        {token}
      </div>
      <Link
        to="/download"
        className="mt-4 inline-flex justify-center items-center text-neutral-700 hover:text-neutral-900 font-medium px-5 h-11 rounded-lg border border-neutral-200 hover:border-neutral-300 transition-colors text-[14px]"
      >
        Don't have Kaata yet? Download
      </Link>
    </div>
  );
}

const ROLE_LABELS: Record<string, string> = {
  owner: "owner",
  editor: "editor",
  viewer: "viewer",
};

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => detectMobile());
  useEffect(() => {
    const onResize = () => setIsMobile(detectMobile());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

function detectMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPod/i.test(ua);
}

function formatExpiresIn(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "soon";
  const deltaMs = t - Date.now();
  if (deltaMs <= 0) return "expired";
  const hours = Math.floor(deltaMs / (60 * 60 * 1000));
  if (hours < 1) {
    const minutes = Math.max(1, Math.floor(deltaMs / (60 * 1000)));
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
