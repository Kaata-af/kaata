import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { BrandLogo } from "../../components/BrandLogo";
import { useToast } from "../../components/Toast";
import { useI18n, type Lang } from "../../lib/i18n";
import {
  signInWithGoogle,
  loadWebAuthProviders,
  cancelPendingWebSignIn,
  WebApiError,
  type WebSession,
} from "../../lib/web-auth";
import { mountGoogleButton } from "../../lib/web-google";
import {
  dismissWebAppleCallback,
  startWebAppleSignIn,
  type WebAppleCallback,
} from "../../lib/web-apple";

const en = {
  language: "Language",
  heading: "Welcome to Kaata",
  subtitle: "Continue with Apple or Google to open your kaatas.",
  apple: "Continue with Apple",
  providersLoading: "Loading sign-in options…",
  providersError: "Sign-in is temporarily unavailable. Please try again.",
  retry: "Try again",
  wait: "Signing you in…",
  appleError: "Apple sign-in could not finish. Please try again.",
  appleStorage: "Allow this site to use browser storage, then try Apple sign-in again.",
  googleError: "Google sign-in could not load. Please try again.",
  providerHelp: "Already use Kaata on your phone? Use the same sign-in method and account.",
  privacy: "Privacy",
  terms: "Terms",
  session: "On a shared computer? Sign out when you’re done.",
  accountHelp: "About your account",
  network: "Cannot reach Kaata. Check your connection and try again.",
  rate: "Too many attempts. Please wait before trying again.",
  unavailable: "Sign-in is temporarily unavailable. Please try again shortly.",
  disabled: "This account is not available. Contact Kaata support for help.",
  deletionHint:
    "If you requested account deletion, signing in during the recovery period cancels it.",
  deletionCancelled: "Your account has been restored and its scheduled deletion cancelled.",
};
type Copy = { [K in keyof typeof en]: string };
const fa: Copy = {
  language: "زبان",
  heading: "به کاتا خوش آمدید",
  subtitle: "برای باز کردن کاتاهای خود، با اپل یا گوگل ادامه دهید.",
  apple: "ادامه با اپل",
  providersLoading: "گزینه‌های ورود بارگذاری می‌شوند…",
  providersError: "ورود فعلاً ممکن نیست. دوباره کوشش کنید.",
  retry: "کوشش دوباره",
  wait: "در حال ورود…",
  appleError: "ورود با اپل تکمیل نشد. دوباره کوشش کنید.",
  appleStorage: "به این سایت اجازۀ ذخیره‌سازی در مرورگر بدهید، سپس دوباره با اپل وارد شوید.",
  googleError: "ورود با گوگل بارگذاری نشد. دوباره کوشش کنید.",
  providerHelp: "در تلفون کاتا دارید؟ از همان روش ورود و حساب استفاده کنید.",
  privacy: "حریم خصوصی",
  terms: "شرایط استفاده",
  session: "در کمپیوتر مشترک، پس از کار از حساب خارج شوید.",
  accountHelp: "دربارۀ حساب شما",
  network: "اتصال به کاتا ممکن نشد. انترنت را بررسی کنید و دوباره کوشش کنید.",
  rate: "تلاش‌ها زیاد شده است. کمی صبر کنید و دوباره کوشش کنید.",
  unavailable: "ورود فعلاً ممکن نیست. کمی بعد دوباره کوشش کنید.",
  disabled: "این حساب در دسترس نیست. با پشتیبانی کاتا تماس بگیرید.",
  deletionHint: "اگر درخواست حذف حساب داده‌اید، ورود در مهلت بازیابی آن درخواست را لغو می‌کند.",
  deletionCancelled: "حساب شما بازیابی شد و درخواست حذف آن لغو گردید.",
};
const ps: Copy = {
  language: "ژبه",
  heading: "کاتا ته ښه راغلاست",
  subtitle: "د خپلو کاتاګانو د پرانیستلو لپاره له اپل یا ګوګل سره دوام ورکړئ.",
  apple: "له اپل سره دوام ورکړئ",
  providersLoading: "د ننوتلو لارې بارېږي…",
  providersError: "ننوتل اوس ممکن نه دي. بیا هڅه وکړئ.",
  retry: "بیا هڅه وکړئ",
  wait: "د ننوتلو په حال کې…",
  appleError: "له اپل سره ننوتل بشپړ نه شول. بیا هڅه وکړئ.",
  appleStorage: "دې سایټ ته په براوزر کې د ساتلو اجازه ورکړئ، بیا له اپل سره د ننوتلو هڅه وکړئ.",
  googleError: "د ګوګل ننوتل بار نه شول. بیا هڅه وکړئ.",
  providerHelp: "په ټیلیفون کې کاتا لرئ؟ د ننوتلو هماغه لاره او حساب وکاروئ.",
  privacy: "محرمیت",
  terms: "شرطونه",
  session: "پر ګډ کمپیوټر د کار له پای وروسته ووځئ.",
  accountHelp: "ستاسو د حساب په اړه",
  network: "له کاتا سره اړیکه ټینګه نه شوه. انټرنېټ وګورئ او بیا هڅه وکړئ.",
  rate: "هڅې ډېرې شوې. لږ انتظار وکړئ او بیا هڅه وکړئ.",
  unavailable: "ننوتل اوس ممکن نه دي. لږ وروسته بیا هڅه وکړئ.",
  disabled: "دا حساب د لاسرسي وړ نه دی. د کاتا له ملاتړ سره اړیکه ونیسئ.",
  deletionHint:
    "که مو د حساب د ړنګولو غوښتنه کړې وي، د بېرته راګرځولو په موده کې ننوتل دا غوښتنه لغوه کوي.",
  deletionCancelled: "ستاسو حساب بېرته راګرځول شوی او د ړنګولو غوښتنه یې لغوه شوې ده.",
};
const copies: Record<Lang, Copy> = { en, fa, ps };

function errorText(error: unknown, copy: Copy): string {
  if (!(error instanceof WebApiError)) return copy.unavailable;
  switch (error.code) {
    case "network":
      return copy.network;
    case "account_disabled":
    case "account_deletion_expired":
      return copy.disabled;
    case "rate_limited":
    case "too_many_requests":
    case "too_many_attempts":
      return copy.rate;
    default:
      return error.status === 429 ? copy.rate : copy.unavailable;
  }
}

export function WorkspaceAuth({
  appleReturn,
  onAppleReturnHandled,
  onSignedIn,
}: {
  appleReturn: WebAppleCallback;
  onAppleReturnHandled: () => void;
  onSignedIn: (session: WebSession) => void;
}) {
  const { lang, setLang, t } = useI18n();
  const toast = useToast();
  const copy = copies[lang];
  const [busy, setBusy] = useState(appleReturn.status === "ready");
  const busyRef = useRef(appleReturn.status === "ready");
  const appleLeaving = useRef(false);
  const [error, setError] = useState("");
  const [googleError, setGoogleError] = useState(false);
  const [providers, setProviders] = useState<Awaited<
    ReturnType<typeof loadWebAuthProviders>
  > | null>(null);
  const [providersError, setProvidersError] = useState(false);
  const [providerAttempt, setProviderAttempt] = useState(0);
  const [googleAttempt, setGoogleAttempt] = useState(0);
  const googleContainer = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const completeSignIn = (session: WebSession) => {
    if (session.deletion_cancelled) toast.push(copy.deletionCancelled, "info");
    onSignedIn(session);
  };
  const latest = useRef({ completeSignIn, copy, onAppleReturnHandled });
  latest.current = { completeSignIn, copy, onAppleReturnHandled };

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const resumed = (event: PageTransitionEvent) => {
      if (event.persisted && appleLeaving.current) {
        appleLeaving.current = false;
        busyRef.current = false;
        setBusy(false);
      }
    };
    window.addEventListener("pageshow", resumed);
    return () => window.removeEventListener("pageshow", resumed);
  }, []);

  useEffect(() => {
    if (appleReturn.status === "error") {
      setError(latest.current.copy.appleError);
      dismissWebAppleCallback();
      latest.current.onAppleReturnHandled();
      return;
    }
    if (appleReturn.status === "cancelled") {
      dismissWebAppleCallback();
      latest.current.onAppleReturnHandled();
    }
    if (appleReturn.status !== "ready") return;
    let active = true;
    void appleReturn
      .complete()
      .then((session) => {
        if (active) latest.current.completeSignIn(session);
      })
      .catch((reason) => {
        if (active) setError(errorText(reason, latest.current.copy));
      })
      .finally(() => {
        if (active) {
          busyRef.current = false;
          setBusy(false);
          latest.current.onAppleReturnHandled();
        }
      });
    return () => {
      active = false;
    };
  }, [appleReturn]);

  useEffect(() => {
    const controller = new AbortController();
    setProviders(null);
    setProvidersError(false);
    void loadWebAuthProviders(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setProviders(value);
        setProvidersError(!value.apple && !value.google);
      })
      .catch(() => {
        if (!controller.signal.aborted) setProvidersError(true);
      });
    return () => controller.abort();
  }, [providerAttempt]);

  useEffect(() => {
    if (!providers?.google || !googleContainer.current) return;
    const controller = new AbortController();
    setGoogleError(false);
    void mountGoogleButton(
      googleContainer.current,
      lang,
      providers.google.client_id,
      (credential, nonce) => {
        if (busyRef.current) {
          setGoogleAttempt((value) => value + 1);
          return;
        }
        busyRef.current = true;
        setBusy(true);
        setError("");
        void signInWithGoogle(credential, nonce)
          .then((session) => latest.current.completeSignIn(session))
          .catch((reason) => {
            setError(errorText(reason, latest.current.copy));
            setGoogleAttempt((value) => value + 1);
          })
          .finally(() => {
            busyRef.current = false;
            setBusy(false);
          });
      },
      controller.signal,
    ).catch(() => {
      if (!controller.signal.aborted) setGoogleError(true);
    });
    return () => controller.abort();
  }, [lang, providers?.google?.client_id, googleAttempt]);

  function appleSignIn() {
    if (busyRef.current || !providers?.apple) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      appleLeaving.current = true;
      startWebAppleSignIn(providers.apple.start_url);
    } catch (reason) {
      appleLeaving.current = false;
      setError(
        reason instanceof WebApiError && reason.code === "apple_storage_unavailable"
          ? copy.appleStorage
          : copy.appleError,
      );
      busyRef.current = false;
      setBusy(false);
    }
  }

  function leaveSignIn(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    cancelPendingWebSignIn();
    dismissWebAppleCallback();
  }

  return (
    <div
      className="flex min-h-dvh flex-col bg-neutral-50 text-neutral-900"
      dir={lang === "en" ? "ltr" : "rtl"}
    >
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8 sm:py-7">
        <Link to="/" onClick={leaveSignIn} className="flex items-center gap-2.5" aria-label="Kaata">
          <BrandLogo className="h-8 w-8" />
          <span className="text-xl font-bold">{t("brand.wordmark")}</span>
        </Link>
        <label className="flex items-center gap-2 text-sm text-neutral-500">
          <span className="sr-only">{copy.language}</span>
          <select
            value={lang}
            onChange={(event) => setLang(event.target.value as Lang)}
            className="rounded-lg border border-neutral-200 bg-white px-3 py-2"
          >
            <option value="en">English</option>
            <option value="fa">دری</option>
            <option value="ps">پښتو</option>
          </select>
        </label>
      </header>
      <main className="flex flex-1 items-center justify-center px-5 pb-10 pt-3 sm:pb-16 sm:pt-6">
        <section
          className="w-full max-w-[424px] rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8"
          aria-labelledby="web-auth-heading"
          aria-busy={busy}
        >
          <h1
            ref={heading}
            tabIndex={-1}
            id="web-auth-heading"
            className="text-2xl font-semibold leading-snug tracking-tight outline-none focus:outline-none"
          >
            {copy.heading}
          </h1>
          <p className="mb-7 mt-2 text-sm leading-relaxed text-neutral-500">{copy.subtitle}</p>
          <div className="mb-6 space-y-3">
            {!providers && !providersError && (
              <p role="status" className="text-sm text-neutral-500">
                {copy.providersLoading}
              </p>
            )}
            {providersError && (
              <div role="status" className="text-sm leading-relaxed text-neutral-500">
                <p>{copy.providersError}</p>
                <button
                  type="button"
                  disabled={busy}
                  className="mt-2 underline underline-offset-4"
                  onClick={() => setProviderAttempt((value) => value + 1)}
                >
                  {copy.retry}
                </button>
              </div>
            )}
            {providers?.apple && (
              <button
                type="button"
                onClick={appleSignIn}
                disabled={busy}
                className="flex h-11 w-full items-center justify-center gap-3 rounded-md border border-black bg-black px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:opacity-60"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-5 w-5 shrink-0"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.75 3.08.81 1.18-.24 2.3-.94 3.56-.85 1.51.12 2.64.72 3.39 1.8-3.11 1.87-2.37 5.98.48 7.13-.57 1.5-1.31 2.99-2.52 4.09l.01-.01ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z" />
                </svg>
                {copy.apple}
              </button>
            )}
            {providers?.google && (
              <div>
                <div
                  ref={googleContainer}
                  className={`flex min-h-11 justify-center ${busy ? "pointer-events-none opacity-60" : ""}`}
                  inert={busy}
                />
                {googleError && (
                  <div role="status" className="mt-2 text-xs leading-relaxed text-neutral-500">
                    <p>{copy.googleError}</p>
                    <button
                      type="button"
                      disabled={busy}
                      className="mt-2 underline underline-offset-4"
                      onClick={() => setGoogleAttempt((value) => value + 1)}
                    >
                      {copy.retry}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          {busy && (
            <p role="status" className="mt-4 text-sm text-neutral-500">
              {copy.wait}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-relaxed text-red-800"
            >
              {error}
            </p>
          )}
          <p className="mt-6 border-t border-neutral-100 pt-5 text-xs leading-relaxed text-neutral-500">
            {copy.providerHelp}
          </p>
          <details className="mt-4 text-xs leading-relaxed text-neutral-500">
            <summary className="cursor-pointer underline-offset-4 hover:text-neutral-900 hover:underline">
              {copy.accountHelp}
            </summary>
            <p className="mt-3">{copy.session}</p>
            <p className="mt-2">{copy.deletionHint}</p>
          </details>
        </section>
      </main>
      <footer className="flex justify-center gap-5 px-5 pb-6 text-xs text-neutral-500">
        <Link to="/privacy" onClick={leaveSignIn} className="hover:underline">
          {copy.privacy}
        </Link>
        <Link to="/terms" onClick={leaveSignIn} className="hover:underline">
          {copy.terms}
        </Link>
      </footer>
    </div>
  );
}
