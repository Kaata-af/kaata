import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { BrandLogo } from "../../components/BrandLogo";
import { useI18n } from "../../lib/i18n";
import {
  consumeWebAppleCallback,
  dismissWebAppleCallback,
  type WebAppleCallback,
} from "../../lib/web-apple";
import { getWebSession, WEB_SESSION_EVENT } from "../../lib/web-auth";
import { WEB_AUTH_ROUTE_EVENT, WEB_ROUTES, webAuthMode } from "../../lib/web-routes";

const Auth = lazy(() => import("./Auth").then((module) => ({ default: module.WorkspaceAuth })));
const Ledger = lazy(() => import("./Workspace"));
const NO_APPLE_RETURN: WebAppleCallback = { status: "none" };

const titles = {
  en: {
    workspace: "Your workspace",
    signin: "Sign in",
    signup: "Create an account",
    reset: "Reset your password",
    missing: "Page not found",
    loading: "Opening Kaata…",
    missingBody: "This page could not be found.",
    back: "Back to your kaatas",
  },
  fa: {
    workspace: "کاتای وب",
    signin: "ورود",
    signup: "ساختن حساب",
    reset: "بازنشانی رمز عبور",
    missing: "صفحه پیدا نشد",
    loading: "کاتا باز می‌شود…",
    missingBody: "این صفحه پیدا نشد.",
    back: "بازگشت به کاتاهای شما",
  },
  ps: {
    workspace: "د وېب کاتا",
    signin: "ننوتل",
    signup: "حساب جوړول",
    reset: "پټنوم بیا ټاکل",
    missing: "پاڼه ونه موندل شوه",
    loading: "کاتا پرانیستل کېږي…",
    missingBody: "دا پاڼه ونه موندل شوه.",
    back: "بېرته خپلو کاتاګانو ته",
  },
};

export default function WorkspaceRoutes() {
  const location = useLocation();
  const { lang } = useI18n();
  const copy = titles[lang];
  const [initial] = useState(() => {
    const session = getWebSession();
    // The backend's existing /app fragment return stays compatible. Scrub it
    // synchronously before a route redirect, script load, or network request.
    const appleReturn = consumeWebAppleCallback();
    if (session && appleReturn.status !== "none") dismissWebAppleCallback();
    return { session, appleReturn: session ? NO_APPLE_RETURN : appleReturn };
  });
  const [session, setSession] = useState(initial.session);
  const [appleReturn, setAppleReturn] = useState(initial.appleReturn);
  const clearAppleReturn = useCallback(() => setAppleReturn(NO_APPLE_RETURN), []);
  const signedIn = useCallback(() => {
    setSession(getWebSession());
    setAppleReturn(NO_APPLE_RETURN);
  }, []);

  useEffect(() => {
    window.addEventListener(WEB_SESSION_EVENT, signedIn);
    window.addEventListener(WEB_AUTH_ROUTE_EVENT, clearAppleReturn);
    return () => {
      window.removeEventListener(WEB_SESSION_EVENT, signedIn);
      window.removeEventListener(WEB_AUTH_ROUTE_EVENT, clearAppleReturn);
    };
  }, [signedIn, clearAppleReturn]);

  const pathname = location.pathname.replace(/\/$/, "");
  const mode = webAuthMode(pathname);
  const workspace = pathname === WEB_ROUTES.workspace;

  useEffect(() => {
    const previous = document.title;
    const brand = { en: "Kaata", fa: "کاتا", ps: "کاتا" }[lang];
    document.title = `${brand} · ${copy[mode ?? (workspace ? "workspace" : "missing")]}`;
    return () => {
      document.title = previous;
    };
  }, [copy, lang, mode, workspace]);

  if (location.pathname !== pathname && (workspace || mode))
    return <Navigate replace to={pathname} />;

  // Only known routes are guarded. A typo must not silently open a ledger.
  if (!workspace && !mode)
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-neutral-50 px-6 text-center text-neutral-900">
        <BrandLogo className="mb-8 h-10 w-10" />
        <p className="text-xs font-medium text-neutral-400">404</p>
        <h1 className="mt-3 text-2xl font-semibold">{copy.missing}</h1>
        <p className="mt-3 text-sm text-neutral-500">{copy.missingBody}</p>
        <Link
          className="mt-7 text-sm font-medium underline underline-offset-4"
          to={WEB_ROUTES.workspace}
        >
          {copy.back}
        </Link>
      </main>
    );

  if (!session && workspace) return <Navigate replace to={WEB_ROUTES.signin} />;
  if (session && mode) return <Navigate replace to={WEB_ROUTES.workspace} />;

  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-dvh items-center justify-center bg-neutral-50 text-sm text-neutral-500"
          role="status"
        >
          {copy.loading}
        </div>
      }
    >
      {session ? (
        <Ledger key={session.install_id} session={session} />
      ) : (
        <Auth
          key={location.key}
          mode={mode!}
          appleReturn={appleReturn}
          onAppleReturnHandled={clearAppleReturn}
          onSignedIn={signedIn}
        />
      )}
    </Suspense>
  );
}
