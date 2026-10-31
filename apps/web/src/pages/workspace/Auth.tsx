import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { BrandLogo } from "../../components/BrandLogo";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
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
import "./Auth.css";

const en = {
  eyebrow: "KAATA FOR WEB",
  pitch: "Your kaata.",
  pitchAccent: "Room to see it all.",
  pitchBody: "The people, balances, and history from your phone. Together on a bigger screen.",
  everywhere: "One account, every screen",
  synced: "Changes stay in sync",
  preview: "An everyday kaata",
  collect: "To collect",
  pay: "To pay",
  history: "Every tally, in its place",
  previewNote: "An example of a little more clarity.",
  private: "Your workspace, your account",
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
  eyebrow: "کاتا برای وب",
  pitch: "کاتای شما.",
  pitchAccent: "جای بیشتر برای دیدن همه‌چیز.",
  pitchBody: "اشخاص، بیلانس‌ها و تاریخچۀ تلفون‌تان، یک‌جا در صفحۀ بزرگ‌تر.",
  everywhere: "یک حساب، در هر صفحه",
  synced: "تغییرات همگام می‌مانند",
  preview: "یک کاتای روزمره",
  collect: "طلب شما",
  pay: "قرض شما",
  history: "هر ثبت، در جای خودش",
  previewNote: "نمونه‌ای از یک حساب روشن‌تر.",
  private: "کاتای شما، حساب شما",
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
  eyebrow: "کاتا د وېب لپاره",
  pitch: "ستاسو کاتا.",
  pitchAccent: "د هر څه د لیدلو لپاره ډېر ځای.",
  pitchBody: "ستاسو د ټیلیفون کسان، بیلانسونه او تاریخچه، په لویه پرده کې یو ځای.",
  everywhere: "یو حساب، په هره پرده",
  synced: "بدلونونه همغږي پاتې کېږي",
  preview: "یوه ورځنۍ کاتا",
  collect: "ستاسو طلب",
  pay: "ستاسو پور",
  history: "هر ثبت په خپل ځای کې",
  previewNote: "د یوه روښانه حساب بېلګه.",
  private: "ستاسو کاتا، ستاسو حساب",
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
    <div className="web-auth" dir={lang === "en" ? "ltr" : "rtl"}>
      <div className="web-auth-atmosphere" aria-hidden="true" />
      <header className="web-auth-header">
        <Link to="/" onClick={leaveSignIn} className="web-auth-brand" aria-label="Kaata">
          <BrandLogo className="h-9 w-9" />
          <span>{t("brand.wordmark")}</span>
        </Link>
        <label className="web-auth-language">
          <span className="sr-only">{copy.language}</span>
          <AuthSymbol kind="globe" />
          <select value={lang} onChange={(event) => setLang(event.target.value as Lang)}>
            <option value="en">English</option>
            <option value="fa">دری</option>
            <option value="ps">پښتو</option>
          </select>
        </label>
      </header>
      <main className="web-auth-main">
        <aside className="web-auth-story" aria-labelledby="web-auth-pitch">
          <p className="web-auth-eyebrow">
            <span />
            {copy.eyebrow}
          </p>
          <h2 id="web-auth-pitch">
            {copy.pitch}
            <br />
            <span>{copy.pitchAccent}</span>
          </h2>
          <p className="web-auth-story-body">{copy.pitchBody}</p>
          <div className="web-auth-benefits">
            <span>
              <AuthSymbol kind="screens" />
              {copy.everywhere}
            </span>
            <span>
              <AuthSymbol kind="sync" />
              {copy.synced}
            </span>
          </div>
          <div className="web-auth-preview" aria-hidden="true">
            <div className="web-auth-preview-heading">
              <span className="web-auth-preview-mark">
                <BrandLogo className="h-5 w-5" />
                {copy.preview}
              </span>
              <span className="web-auth-preview-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
            <div className="web-auth-preview-balances">
              <div className="web-auth-preview-collect">
                <span>
                  <AuthSymbol kind="in" />
                  {copy.collect}
                </span>
                <strong>
                  <bdi>
                    {new Intl.NumberFormat(lang === "en" ? "en" : `${lang}-AF`).format(12450)}{" "}
                    <small>AFN</small>
                  </bdi>
                </strong>
                <div className="web-auth-preview-chart">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="web-auth-preview-pay">
                <span>
                  <AuthSymbol kind="out" />
                  {copy.pay}
                </span>
                <strong>
                  <bdi>
                    {new Intl.NumberFormat(lang === "en" ? "en" : `${lang}-AF`).format(3200)}{" "}
                    <small>AFN</small>
                  </bdi>
                </strong>
                <div className="web-auth-preview-chart">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
            <div className="web-auth-preview-history">
              <span>
                <AuthSymbol kind="history" />
                {copy.history}
              </span>
              <span>↗</span>
            </div>
            <p className="web-auth-preview-note">{copy.previewNote}</p>
          </div>
        </aside>
        <Card
          className="web-auth-card"
          role="region"
          aria-labelledby="web-auth-heading"
          aria-busy={busy}
        >
          <div className="web-auth-card-kicker">
            <span>
              <AuthSymbol kind="lock" />
            </span>
            {copy.private}
          </div>
          <h1 ref={heading} tabIndex={-1} id="web-auth-heading">
            {copy.heading}
          </h1>
          <p className="web-auth-subtitle">{copy.subtitle}</p>
          <div className="web-auth-providers">
            {!providers && !providersError && (
              <div role="status" className="web-auth-provider-loading">
                <span className="sr-only">{copy.providersLoading}</span>
                <div aria-hidden="true" />
                <div aria-hidden="true" />
              </div>
            )}
            {providersError && (
              <div role="status" className="web-auth-provider-error">
                <p>{copy.providersError}</p>
                <Button
                  type="button"
                  disabled={busy}
                  variant="brand"
                  className="mt-3 rounded-full"
                  onClick={() => setProviderAttempt((value) => value + 1)}
                >
                  {copy.retry}
                </Button>
              </div>
            )}
            {providers?.google && (
              <div className="web-auth-google">
                <div
                  ref={googleContainer}
                  className={`web-auth-google-control ${busy ? "is-busy" : ""}`}
                  inert={busy}
                />
                {googleError && (
                  <div role="status" className="web-auth-provider-error">
                    <p>{copy.googleError}</p>
                    <Button
                      type="button"
                      variant="glass"
                      size="sm"
                      disabled={busy}
                      className="mt-2 rounded-full"
                      onClick={() => setGoogleAttempt((value) => value + 1)}
                    >
                      {copy.retry}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {providers?.apple && (
              <Button
                type="button"
                onClick={appleSignIn}
                disabled={busy}
                className="web-auth-apple h-10 w-full rounded-full"
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
              </Button>
            )}
          </div>
          {busy && (
            <p role="status" className="web-auth-wait">
              <span className="web-auth-spinner" aria-hidden="true" />
              {copy.wait}
            </p>
          )}
          {error && (
            <p role="alert" className="web-auth-error">
              {error}
            </p>
          )}
          <p className="web-auth-provider-help">
            <AuthSymbol kind="screens" />
            {copy.providerHelp}
          </p>
          <details className="web-auth-account-help">
            <summary>{copy.accountHelp}</summary>
            <p className="mt-3">{copy.session}</p>
            <p className="mt-2">{copy.deletionHint}</p>
          </details>
        </Card>
      </main>
      <footer className="web-auth-footer">
        <span>{copy.eyebrow}</span>
        <nav aria-label={copy.accountHelp}>
          <Link to="/privacy" onClick={leaveSignIn} className="hover:underline">
            {copy.privacy}
          </Link>
          <Link to="/terms" onClick={leaveSignIn} className="hover:underline">
            {copy.terms}
          </Link>
        </nav>
      </footer>
    </div>
  );
}

function AuthSymbol({
  kind,
}: {
  kind: "screens" | "sync" | "lock" | "globe" | "in" | "out" | "history";
}) {
  const paths = {
    screens: "M3 4h13v10H3z M7 18h5 M9 14v4 M18 8h3v13h-7v-5",
    sync: "M20 7v5h-5 M4 17v-5h5 M5.6 7a7 7 0 0 1 11.6-2L20 8 M4 16l2.8 3A7 7 0 0 0 18.4 17",
    lock: "M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3",
    globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18",
    in: "M7 5v12h12 M7 17 19 5",
    out: "M5 7h12v12 M17 7 5 19",
    history: "M3 4v5h5 M3 9a9 9 0 1 1 0 6 M12 7v5l3 2",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
