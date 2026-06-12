import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { getInviteInfo, type InviteInfo, type InviteInfoError } from "../lib/api";
import { useI18n } from "../lib/i18n";

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
  // Bumped by the error view's Retry button — re-runs the fetch effect.
  const [retryNonce, setRetryNonce] = useState(0);

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
  }, [token, retryNonce]);

  return (
    <main>
      <SiteHeader />
      <section className="px-6 py-16 md:py-24 max-w-xl mx-auto">
        {state.kind === "loading" && <LoadingView />}
        {state.kind === "error" && (
          <ErrorView
            err={state.err}
            onRetry={() => {
              setState({ kind: "loading" });
              setRetryNonce((n) => n + 1);
            }}
          />
        )}
        {state.kind === "ok" && <DetailsView info={state.info} token={token} />}
      </section>
      <SiteFooter />
    </main>
  );
}

function LoadingView() {
  const { t } = useI18n();
  return (
    <div className="text-center">
      <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
        {t("invite.loading")}
      </p>
      <div className="mx-auto h-2 w-32 rounded-full bg-neutral-200 overflow-hidden">
        <div className="h-full w-1/2 bg-neutral-900 animate-pulse" />
      </div>
    </div>
  );
}

function ErrorView({ err, onRetry }: { err: InviteInfoError; onRetry: () => void }) {
  const { t } = useI18n();
  let title = t("invite.error.unavailable.title");
  let body = t("invite.error.unavailable.body");
  // Transient failures get a Retry button; the collapsed not-found state
  // (expired/revoked/accepted) doesn't — retrying can't change it.
  let retryable = false;

  if (err.kind === "rate_limited") {
    title = t("invite.error.rateLimited.title");
    const wait =
      err.retryAfterSeconds && err.retryAfterSeconds > 0
        ? t("invite.error.rateLimited.minutes", {
            count: Math.max(1, Math.ceil(err.retryAfterSeconds / 60)),
          })
        : t("invite.error.rateLimited.fallbackWait");
    body = t("invite.error.rateLimited.body", { wait });
    retryable = true;
  } else if (err.kind === "network") {
    title = t("invite.error.network.title");
    body = t("invite.error.network.body");
    retryable = true;
  } else if (err.kind === "server") {
    title = t("invite.error.server.title");
    body = t("invite.error.server.body");
    retryable = true;
  }

  return (
    <div className="text-center">
      <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
        {t("invite.kicker")}
      </p>
      <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-neutral-900">{title}</h1>
      <p className="mt-5 text-base text-neutral-600 leading-relaxed">{body}</p>
      {retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-8 inline-block bg-neutral-900 text-white font-semibold px-7 py-3 rounded-lg hover:bg-neutral-800 transition-colors text-sm"
        >
          {t("invite.tryAgain")}
        </button>
      ) : null}
      <Link
        to="/"
        className="mt-10 block text-sm text-neutral-600 hover:text-neutral-900 transition-colors font-medium"
      >
        {t("invite.backHome")}
      </Link>
    </div>
  );
}

function DetailsView({ info, token }: { info: InviteInfo; token: string }) {
  const { t } = useI18n();
  const onMobile = useIsMobile();
  // Android Chrome silently ignores unhandled custom-scheme navigations —
  // a plain kaata:// anchor did visibly nothing for invitees without the
  // app. intent:// gives Android a browser_fallback_url (the download
  // page); iOS and others keep the plain scheme.
  const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent ?? "");
  const deepLink = isAndroid
    ? `intent://invite/${encodeURIComponent(token)}#Intent;scheme=kaata;S.browser_fallback_url=${encodeURIComponent(
        "https://kaata.af/download",
      )};end`
    : `kaata://invite/${encodeURIComponent(token)}`;
  const roleLabel =
    info.role === "owner"
      ? t("invite.role.owner")
      : info.role === "editor"
        ? t("invite.role.editor")
        : info.role === "viewer"
          ? t("invite.role.viewer")
          : info.role;
  const expiresRelative = useMemo(() => formatExpiresIn(info.expires_at, t), [info.expires_at, t]);

  return (
    <div className="text-center">
      <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
        {t("invite.youreInvited")}
      </p>
      <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-neutral-900 leading-tight">
        {t("invite.join", { name: info.vault_name })}
        <span className="block text-neutral-500 mt-1 text-2xl md:text-3xl">
          {t("invite.asRole", { role: roleLabel })}
        </span>
      </h1>

      <dl className="mt-10 grid grid-cols-1 gap-4 text-start max-w-sm mx-auto">
        <Row
          label={t("invite.invitedBy")}
          value={info.inviter_name || info.inviter_email_redacted}
        />
        {info.inviter_name && info.inviter_email_redacted && (
          <Row label={t("invite.email")} value={info.inviter_email_redacted} />
        )}
        <Row label={t("invite.expires")} value={expiresRelative} />
      </dl>

      <div className="mt-12">
        {onMobile ? <MobileActions deepLink={deepLink} /> : <DesktopActions token={token} />}
      </div>

      <p className="mt-10 text-xs text-neutral-600 leading-relaxed">
        {info.role === "viewer" ? t("invite.privacyNote.view") : t("invite.privacyNote.edit")}
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
      <dd className="text-sm text-neutral-900 font-medium text-end break-words min-w-0">{value}</dd>
    </div>
  );
}

function MobileActions({ deepLink }: { deepLink: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <a
        href={deepLink}
        className="inline-flex justify-center items-center bg-neutral-900 text-white font-medium px-5 h-12 rounded-lg ring-0 ring-neutral-100 hover:ring-4 transition-[box-shadow] text-[15px]"
      >
        {t("invite.openInApp")}
      </a>
      <Link
        to="/download"
        className="inline-flex justify-center items-center text-neutral-700 hover:text-neutral-900 font-medium px-5 h-11 rounded-lg border border-neutral-200 hover:border-neutral-300 transition-colors text-[14px]"
      >
        {t("invite.downloadFallback")}
      </Link>
      <p className="mt-1 text-xs text-neutral-600 leading-relaxed">{t("invite.afterInstall")}</p>
    </div>
  );
}

function DesktopActions({ token }: { token: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 items-center">
      <p className="text-sm text-neutral-600">{t("invite.desktopHint")}</p>
      <div
        // dir="ltr": the token is opaque Latin data; keep it unidirectional
        // even on the Persian page so it can be read back digit by digit.
        dir="ltr"
        className="font-mono text-sm text-neutral-900 bg-neutral-100 rounded-lg px-4 py-3 max-w-full break-all border border-neutral-200"
        aria-label={t("invite.codeLabel")}
      >
        {token}
      </div>
      <Link
        to="/download"
        className="mt-4 inline-flex justify-center items-center text-neutral-700 hover:text-neutral-900 font-medium px-5 h-11 rounded-lg border border-neutral-200 hover:border-neutral-300 transition-colors text-[14px]"
      >
        {t("invite.downloadFallback")}
      </Link>
    </div>
  );
}

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

type Translate = ReturnType<typeof useI18n>["t"];

function formatExpiresIn(iso: string, t: Translate): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return t("invite.expires.soon");
  const deltaMs = parsed - Date.now();
  if (deltaMs <= 0) return t("invite.expires.expired");
  const hours = Math.floor(deltaMs / (60 * 60 * 1000));
  if (hours < 1) {
    const minutes = Math.max(1, Math.floor(deltaMs / (60 * 1000)));
    return t("invite.expires.minutes", { count: minutes });
  }
  if (hours < 48) return t("invite.expires.hours", { count: hours });
  const days = Math.floor(hours / 24);
  return t("invite.expires.days", { count: days });
}
