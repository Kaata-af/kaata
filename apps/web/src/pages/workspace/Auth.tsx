import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { BrandLogo } from "../../components/BrandLogo";
import { useToast } from "../../components/Toast";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useI18n, type Lang } from "../../lib/i18n";
import {
  signInWithGoogle,
  loadWebAuthProviders,
  cancelPendingWebSignIn,
  signInWithPassword,
  startEmailCode,
  verifyEmailCode,
  WebApiError,
  type WebSession,
} from "../../lib/web-auth";
import { mountGoogleButton } from "../../lib/web-google";
import {
  consumeWebAppleCallback,
  dismissWebAppleCallback,
  startWebAppleSignIn,
} from "../../lib/web-apple";

const en = {
  web: "Kaata for web",
  beta: "Early access",
  language: "Language",
  heading: "Your kaata.\nA little more room.",
  intro: "The same people, the same balances. Now at your desk.",
  one: "Keep your people and balances together",
  two: "Record what you gave and received",
  three: "Continue with the account you use on your phone",
  online:
    "This first web version needs an internet connection. Your phone’s unsynced records appear after they reach Kaata.",
  signin: "Welcome back",
  signup: "Create your account",
  reset: "Reset your password",
  signinSub: "Sign in to open your kaatas on this computer.",
  signupSub: "Choose how you’d like to create your account.",
  resetSub: "Enter the email you use to sign in with a password.",
  identifier: "Email or username",
  email: "Email address",
  password: "Password",
  newPassword: "New password",
  confirm: "Confirm password",
  passwordHint: "8–128 characters. Use a password you do not use elsewhere.",
  code: "6-digit verification code",
  continue: "Sign in",
  create: "Create account",
  savePassword: "Set password and sign in",
  send: "Send code",
  resend: "Send another code",
  resendWait: "Resend in {seconds}s",
  changeEmail: "Change email",
  sent: "If this address is eligible, an email is on its way. Check your inbox and spam folder.",
  resetWarning: "Resetting your password signs you out on your other devices.",
  forgot: "Forgot password?",
  newHere: "New to Kaata?",
  haveAccount: "Already have an account?",
  createLink: "Create an account",
  back: "Back to sign in",
  wait: "Please wait…",
  or: "or use your password",
  orEmail: "or continue with email",
  apple: "Continue with Apple",
  providersLoading: "Loading sign-in options…",
  providersError: "Apple and Google sign-in could not load. Try again or use your password.",
  retry: "Try again",
  appleError: "Apple sign-in could not finish. Please try again.",
  appleStorage: "Allow this site to use browser storage, then try Apple sign-in again.",
  providerHelp:
    "Choose the same sign-in method and account you use on your phone to open your existing kaatas.",
  privacy: "Privacy",
  terms: "Terms",
  session:
    "Sign out when you finish on a shared computer. Your session is kept in this browser tab.",
  network: "Cannot reach Kaata. Check your connection and try again.",
  credentials: "The email, username or password is incorrect.",
  invalidCode: "That code is incorrect or has expired. Try again or request a new code.",
  weak: "Choose a stronger password of 8–128 characters. Avoid common passwords, repeated characters and your name or email.",
  invalidEmail: "Enter a valid personal email address.",
  exists: "This email already has an account. Sign in or reset your password.",
  rate: "Too many attempts. Please wait before trying again.",
  unavailable: "Sign-in is temporarily unavailable. Please try again shortly.",
  disabled: "This account is not available. Contact Kaata support for help.",
  mismatch: "The passwords do not match.",
  googleError: "Google sign-in could not load. Try again later or use your Kaata password.",
  deletionHint:
    "If you requested account deletion, signing in during the recovery period cancels it.",
  deletionCancelled: "Your account has been restored and its scheduled deletion cancelled.",
};
type Copy = { [K in keyof typeof en]: string };
const fa: Copy = {
  web: "کاتا در وب",
  beta: "نسخۀ ابتدایی",
  language: "زبان",
  heading: "همان کاتای شما.\nبا جای بیشتر.",
  intro: "همان اشخاص و همان حساب‌ها، حالا روی کمپیوتر شما.",
  one: "اشخاص و حساب‌های خود را یکجا نگه دارید",
  two: "داده‌ها و گرفته‌های خود را ثبت کنید",
  three: "با همان حساب تلفون خود وارد شوید",
  online:
    "این نسخۀ وب به انترنت نیاز دارد. ثبت‌های همگام‌نشدۀ تلفون پس از رسیدن به کاتا اینجا دیده می‌شوند.",
  signin: "خوش آمدید",
  signup: "حساب بسازید",
  reset: "رمز عبور را بازنشانی کنید",
  signinSub: "برای باز کردن کاتاهای خود در این کمپیوتر وارد شوید.",
  signupSub: "روش ساختن حساب خود را انتخاب کنید.",
  resetSub: "ایمیلی را وارد کنید که با آن و رمز عبور وارد می‌شوید.",
  identifier: "ایمیل یا نام کاربری",
  email: "آدرس ایمیل",
  password: "رمز عبور",
  newPassword: "رمز عبور جدید",
  confirm: "تأیید رمز عبور",
  passwordHint: "۸ تا ۱۲۸ نویسه. رمزی انتخاب کنید که جای دیگری استفاده نمی‌کنید.",
  code: "کد تأیید ۶ رقمی",
  continue: "ورود",
  create: "ساختن حساب",
  savePassword: "ذخیرۀ رمز و ورود",
  send: "فرستادن کد",
  resend: "فرستادن کد دیگر",
  resendWait: "فرستادن دوباره تا {seconds} ثانیه",
  changeEmail: "تغییر ایمیل",
  sent: "اگر این آدرس واجد شرایط باشد، ایمیل فرستاده می‌شود. صندوق ورودی و پوشۀ اسپم را ببینید.",
  resetWarning: "با بازنشانی رمز، از حساب خود در دستگاه‌های دیگر خارج می‌شوید.",
  forgot: "رمز را فراموش کرده‌اید؟",
  newHere: "حساب کاتا ندارید؟",
  haveAccount: "از قبل حساب دارید؟",
  createLink: "حساب بسازید",
  back: "بازگشت به ورود",
  wait: "لطفاً صبر کنید…",
  or: "یا با رمز عبور وارد شوید",
  orEmail: "یا با ایمیل ادامه دهید",
  apple: "ادامه با اپل",
  providersLoading: "گزینه‌های ورود بارگذاری می‌شوند…",
  providersError: "ورود با اپل و گوگل بارگذاری نشد. دوباره کوشش کنید یا از رمز عبور استفاده کنید.",
  retry: "کوشش دوباره",
  appleError: "ورود با اپل تکمیل نشد. دوباره کوشش کنید.",
  appleStorage: "به این سایت اجازۀ ذخیره‌سازی در مرورگر بدهید، سپس دوباره با اپل وارد شوید.",
  providerHelp:
    "برای باز کردن کاتاهای موجود، همان روش ورود و حسابی را انتخاب کنید که در تلفون استفاده می‌کنید.",
  privacy: "حریم خصوصی",
  terms: "شرایط استفاده",
  session:
    "در کمپیوتر مشترک، پس از کار از حساب خارج شوید. نشست شما در همین تب مرورگر نگه داشته می‌شود.",
  network: "اتصال به کاتا ممکن نشد. انترنت را بررسی کنید و دوباره کوشش کنید.",
  credentials: "ایمیل، نام کاربری یا رمز عبور درست نیست.",
  invalidCode: "کد درست نیست یا منقضی شده است. دوباره کوشش کنید یا کد جدید بخواهید.",
  weak: "رمز قوی‌تری با ۸ تا ۱۲۸ نویسه انتخاب کنید. از رمزهای رایج، نویسه‌های تکراری و نام یا ایمیل خود استفاده نکنید.",
  invalidEmail: "یک آدرس ایمیل شخصی معتبر وارد کنید.",
  exists: "این ایمیل از قبل حساب دارد. وارد شوید یا رمز را بازنشانی کنید.",
  rate: "تلاش‌ها زیاد شده است. کمی صبر کنید و دوباره کوشش کنید.",
  unavailable: "ورود فعلاً ممکن نیست. کمی بعد دوباره کوشش کنید.",
  disabled: "این حساب در دسترس نیست. با پشتیبانی کاتا تماس بگیرید.",
  mismatch: "رمزهای عبور یکسان نیستند.",
  googleError: "ورود با گوگل بارگذاری نشد. بعداً کوشش کنید یا از رمز کاتا استفاده کنید.",
  deletionHint: "اگر درخواست حذف حساب داده‌اید، ورود در مهلت بازیابی آن درخواست را لغو می‌کند.",
  deletionCancelled: "حساب شما بازیابی شد و درخواست حذف آن لغو گردید.",
};
const ps: Copy = {
  web: "کاتا په وېب کې",
  beta: "لومړنۍ نسخه",
  language: "ژبه",
  heading: "ستاسو هماغه کاتا.\nپه پراخه پرده.",
  intro: "هماغه خلک او هماغه حسابونه، اوس ستاسو پر کمپیوټر.",
  one: "خپل خلک او حسابونه یو ځای وساتئ",
  two: "خپلې ورکړې او اخیستنې ثبت کړئ",
  three: "د خپل ټیلیفون په هماغه حساب ننوځئ",
  online:
    "دا لومړنۍ وېب نسخه انټرنېټ ته اړتیا لري. د ټیلیفون نالېږل شوي ثبتونه کاتا ته تر رسېدو وروسته دلته ښکاري.",
  signin: "ښه راغلاست",
  signup: "حساب جوړ کړئ",
  reset: "پټنوم بیا وټاکئ",
  signinSub: "پر دې کمپیوټر د خپلو کاتاګانو د پرانیستلو لپاره ننوځئ.",
  signupSub: "د خپل حساب جوړولو لاره وټاکئ.",
  resetSub: "هغه برېښنالیک ولیکئ چې په پټنوم ورسره ننوځئ.",
  identifier: "برېښنالیک یا کارن نوم",
  email: "برېښنالیک پته",
  password: "پټنوم",
  newPassword: "نوی پټنوم",
  confirm: "پټنوم تایید کړئ",
  passwordHint: "له ۸ تر ۱۲۸ تورو. داسې پټنوم وکاروئ چې بل ځای یې نه کاروئ.",
  code: "۶ عددي تایید کوډ",
  continue: "ننوتل",
  create: "حساب جوړول",
  savePassword: "پټنوم ساتل او ننوتل",
  send: "کوډ لېږل",
  resend: "بل کوډ لېږل",
  resendWait: "په {seconds} ثانیو کې بیا لېږل",
  changeEmail: "برېښنالیک بدلول",
  sent: "که دا پته وړ وي، برېښنالیک به درولېږل شي. خپل انباکس او سپم وګورئ.",
  resetWarning: "د پټنوم په بیا ټاکلو سره به له نورو وسیلو ووځئ.",
  forgot: "پټنوم مو هېر شوی؟",
  newHere: "په کاتا کې نوي یاست؟",
  haveAccount: "حساب لرئ؟",
  createLink: "حساب جوړ کړئ",
  back: "بېرته ننوتلو ته",
  wait: "لطفاً انتظار وکړئ…",
  or: "یا په پټنوم ننوځئ",
  orEmail: "یا په برېښنالیک دوام ورکړئ",
  apple: "له اپل سره دوام ورکړئ",
  providersLoading: "د ننوتلو لارې بارېږي…",
  providersError: "د اپل او ګوګل ننوتل بار نه شول. بیا هڅه وکړئ یا خپل پټنوم وکاروئ.",
  retry: "بیا هڅه وکړئ",
  appleError: "له اپل سره ننوتل بشپړ نه شول. بیا هڅه وکړئ.",
  appleStorage: "دې سایټ ته په براوزر کې د ساتلو اجازه ورکړئ، بیا له اپل سره د ننوتلو هڅه وکړئ.",
  providerHelp:
    "د خپلو شته کاتاګانو د پرانیستلو لپاره د ټیلیفون هماغه د ننوتلو لاره او حساب وټاکئ.",
  privacy: "محرمیت",
  terms: "شرطونه",
  session: "پر ګډ کمپیوټر د کار له پای وروسته ووځئ. ستاسو ناسته د براوزر په همدې ټب کې ساتل کېږي.",
  network: "له کاتا سره اړیکه ټینګه نه شوه. انټرنېټ وګورئ او بیا هڅه وکړئ.",
  credentials: "برېښنالیک، کارن نوم یا پټنوم ناسم دی.",
  invalidCode: "کوډ ناسم دی یا وخت یې تېر شوی. بیا هڅه وکړئ یا نوی کوډ وغواړئ.",
  weak: "له ۸ تر ۱۲۸ تورو پیاوړی پټنوم غوره کړئ. عام پټنومونه، تکراري توري او خپل نوم یا برېښنالیک مه کاروئ.",
  invalidEmail: "د خپل برېښنالیک سمه پته ولیکئ.",
  exists: "دا برېښنالیک حساب لري. ننوځئ یا پټنوم بیا وټاکئ.",
  rate: "هڅې ډېرې شوې. لږ انتظار وکړئ او بیا هڅه وکړئ.",
  unavailable: "ننوتل اوس ممکن نه دي. لږ وروسته بیا هڅه وکړئ.",
  disabled: "دا حساب د لاسرسي وړ نه دی. د کاتا له ملاتړ سره اړیکه ونیسئ.",
  mismatch: "پټنومونه یو شان نه دي.",
  googleError: "د ګوګل ننوتل بار نه شول. وروسته بیا هڅه وکړئ یا د کاتا پټنوم وکاروئ.",
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
    case "invalid_credentials":
      return copy.credentials;
    case "invalid_code":
    case "invalid_code_format":
      return copy.invalidCode;
    case "weak_password":
      return copy.weak;
    case "invalid_email":
      return copy.invalidEmail;
    case "account_exists":
      return copy.exists;
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

export function WorkspaceAuth({ onSignedIn }: { onSignedIn: (session: WebSession) => void }) {
  // Consume the return before any provider script loads; tokens never stay in
  // the address bar. The helper caches one completion across StrictMode effects.
  const [appleReturn] = useState(consumeWebAppleCallback);
  const { lang, setLang, t } = useI18n();
  const toast = useToast();
  const copy = copies[lang];
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(appleReturn.status === "ready");
  const busyRef = useRef(appleReturn.status === "ready");
  const appleLeaving = useRef(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [googleError, setGoogleError] = useState(false);
  const [providers, setProviders] = useState<Awaited<
    ReturnType<typeof loadWebAuthProviders>
  > | null>(null);
  const [providersError, setProvidersError] = useState(false);
  const [providerAttempt, setProviderAttempt] = useState(0);
  const [googleAttempt, setGoogleAttempt] = useState(0);
  const googleContainer = useRef<HTMLDivElement>(null);
  const completeSignIn = (session: WebSession) => {
    if (session.deletion_cancelled) toast.push(copy.deletionCancelled, "info");
    onSignedIn(session);
  };
  const latest = useRef({ completeSignIn, copy });
  latest.current = { completeSignIn, copy };

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
      return;
    }
    if (appleReturn.status === "cancelled") dismissWebAppleCallback();
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
        }
      });
    return () => {
      active = false;
    };
  }, [appleReturn]);

  useEffect(() => {
    const controller = new AbortController();
    setProvidersError(false);
    void loadWebAuthProviders(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setProviders(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setProvidersError(true);
      });
    return () => controller.abort();
  }, [providerAttempt]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (!providers?.google || mode === "reset" || sent || !googleContainer.current) return;
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
  }, [lang, mode, sent, providers?.google?.client_id, googleAttempt]);

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

  const switchMode = (next: typeof mode) => {
    setMode(next);
    setPassword("");
    setConfirm("");
    setCode("");
    setSent(false);
    setError("");
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    if (mode !== "signin" && sent && password !== confirm) {
      setError(copy.mismatch);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      if (mode === "signin") {
        const session = await signInWithPassword(identifier, password);
        setPassword("");
        completeSignIn(session);
      } else if (!sent) {
        const result = await startEmailCode(mode, identifier, lang);
        setSent(true);
        setCooldown(Math.max(60, result.resend_after_s || 60));
      } else {
        const session = await verifyEmailCode(mode, identifier, code, password, lang);
        setPassword("");
        setConfirm("");
        completeSignIn(session);
      }
    } catch (reason) {
      setError(errorText(reason, copy));
      if (reason instanceof WebApiError && reason.retryAfterSeconds)
        setCooldown(reason.retryAfterSeconds);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function resend() {
    if (mode === "signin" || cooldown || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await startEmailCode(mode, identifier, lang);
      setCooldown(Math.max(60, result.resend_after_s || 60));
    } catch (reason) {
      setError(errorText(reason, copy));
      if (reason instanceof WebApiError && reason.retryAfterSeconds)
        setCooldown(reason.retryAfterSeconds);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <header className="mx-auto flex max-w-[1440px] items-center justify-between px-6 py-6 sm:px-10">
        <Link to="/" onClick={leaveSignIn} className="flex items-center gap-2.5" aria-label="Kaata">
          <BrandLogo className="h-9 w-9" />
          <span className="text-xl font-bold">{t("brand.wordmark")}</span>
          <span className="ms-2 rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] font-medium text-neutral-500">
            {copy.beta}
          </span>
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
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-12 pt-8 sm:px-10 lg:min-h-[calc(100vh-110px)] lg:grid-cols-2 lg:gap-24 lg:py-16">
        <section className="hidden lg:block">
          <p className="mb-6 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            {copy.web}
          </p>
          <h1 className="whitespace-pre-line text-5xl font-semibold leading-[1.18]">
            {copy.heading}
          </h1>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-neutral-500">{copy.intro}</p>
          <ul className="mt-12 space-y-5 text-sm text-neutral-700">
            {[copy.one, copy.two, copy.three].map((item) => (
              <li key={item} className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-xs"
                >
                  ✓
                </span>
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-12 max-w-sm border-t border-neutral-200 pt-5 text-xs leading-relaxed text-neutral-500">
            {copy.online}
          </p>
        </section>
        <section className="mx-auto w-full max-w-sm" aria-labelledby="web-auth-heading">
          <h2 id="web-auth-heading" className="text-3xl font-semibold">
            {copy[mode]}
          </h2>
          <p className="mb-8 mt-3 text-sm leading-relaxed text-neutral-500">{copy[`${mode}Sub`]}</p>
          {mode !== "reset" && !sent && (
            <div className="mx-auto mb-6 max-w-[360px] space-y-3">
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
                  className="flex h-11 w-full items-center justify-center gap-3 rounded border border-black bg-black px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:opacity-60"
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
              {(providers?.apple || providers?.google) && (
                <div className="!mt-6 flex items-center gap-3 text-xs text-neutral-400">
                  <span className="h-px flex-1 bg-neutral-200" />
                  {mode === "signin" ? copy.or : copy.orEmail}
                  <span className="h-px flex-1 bg-neutral-200" />
                </div>
              )}
            </div>
          )}
          <form onSubmit={submit} className="space-y-5">
            <fieldset disabled={busy} className="space-y-5 disabled:opacity-70">
              <div className="space-y-2">
                <label htmlFor="web-email" className="block text-sm font-medium">
                  {mode === "signin" ? copy.identifier : copy.email}
                </label>
                <Input
                  id="web-email"
                  name="username"
                  type={mode === "signin" ? "text" : "email"}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  readOnly={sent}
                  maxLength={254}
                  dir="ltr"
                  className="h-11 bg-white"
                />
                {sent && (
                  <button
                    type="button"
                    className="text-xs underline underline-offset-4"
                    onClick={() => {
                      setSent(false);
                      setCode("");
                      setError("");
                    }}
                  >
                    {copy.changeEmail}
                  </button>
                )}
              </div>
              {sent && (
                <>
                  <p
                    role="status"
                    className="rounded-lg bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-600"
                  >
                    {copy.sent}
                  </p>
                  <div className="space-y-2">
                    <label htmlFor="web-code" className="block text-sm font-medium">
                      {copy.code}
                    </label>
                    <Input
                      id="web-code"
                      name="code"
                      value={code}
                      required
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      dir="ltr"
                      className="h-11"
                      onChange={(event) =>
                        setCode(
                          event.target.value
                            .replace(/[۰-۹٠-٩]/g, (char) =>
                              String(char.charCodeAt(0) - (char >= "۰" ? 1776 : 1632)),
                            )
                            .replace(/\D/g, "")
                            .slice(0, 6),
                        )
                      }
                    />
                  </div>
                </>
              )}
              {(mode === "signin" || sent) && (
                <div className="space-y-2">
                  <label htmlFor="web-password" className="block text-sm font-medium">
                    {mode === "reset" ? copy.newPassword : copy.password}
                  </label>
                  <Input
                    id="web-password"
                    name="password"
                    type="password"
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    value={password}
                    required
                    maxLength={256}
                    dir="ltr"
                    className="h-11"
                    onChange={(event) => setPassword(event.target.value)}
                    aria-describedby={mode === "signin" ? undefined : "web-password-hint"}
                  />
                  {mode !== "signin" && (
                    <p id="web-password-hint" className="text-xs leading-relaxed text-neutral-500">
                      {copy.passwordHint}
                    </p>
                  )}
                </div>
              )}
              {sent && (
                <div className="space-y-2">
                  <label htmlFor="web-confirm" className="block text-sm font-medium">
                    {copy.confirm}
                  </label>
                  <Input
                    id="web-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    required
                    maxLength={256}
                    dir="ltr"
                    className="h-11"
                    onChange={(event) => setConfirm(event.target.value)}
                  />
                </div>
              )}
              {mode === "reset" && sent && (
                <p className="text-xs leading-relaxed text-neutral-500">{copy.resetWarning}</p>
              )}
              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-relaxed text-red-800"
                >
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="h-11 w-full"
                disabled={busy || (mode !== "signin" && !sent && cooldown > 0)}
              >
                {busy
                  ? copy.wait
                  : mode === "signin"
                    ? copy.continue
                    : !sent
                      ? cooldown > 0
                        ? copy.resendWait.replace("{seconds}", String(cooldown))
                        : copy.send
                      : mode === "signup"
                        ? copy.create
                        : copy.savePassword}
              </Button>
              {sent && (
                <button
                  type="button"
                  className="w-full text-center text-sm underline underline-offset-4 disabled:text-neutral-400"
                  disabled={cooldown > 0}
                  onClick={() => void resend()}
                >
                  {cooldown > 0
                    ? copy.resendWait.replace("{seconds}", String(cooldown))
                    : copy.resend}
                </button>
              )}
              {mode === "signin" && (
                <button
                  type="button"
                  onClick={() => switchMode("reset")}
                  className="block w-full text-center text-sm text-neutral-600 underline underline-offset-4"
                >
                  {copy.forgot}
                </button>
              )}
            </fieldset>
          </form>
          <div className="mt-7 border-t border-neutral-200 pt-6 text-center text-sm text-neutral-500">
            {mode === "signin" ? (
              <>
                {copy.newHere}{" "}
                <button
                  disabled={busy}
                  onClick={() => switchMode("signup")}
                  className="font-medium text-neutral-900 underline underline-offset-4"
                >
                  {copy.createLink}
                </button>
              </>
            ) : (
              <button
                disabled={busy}
                onClick={() => switchMode("signin")}
                className="font-medium text-neutral-900 underline underline-offset-4"
              >
                {copy.back}
              </button>
            )}
          </div>
          {mode === "signin" && (
            <p className="mt-6 text-xs leading-relaxed text-neutral-500">{copy.providerHelp}</p>
          )}
          <p className="mt-5 text-xs leading-relaxed text-neutral-400">{copy.session}</p>
          <p className="mt-3 text-xs leading-relaxed text-neutral-500">{copy.deletionHint}</p>
          <div className="mt-6 flex gap-5 text-xs text-neutral-500">
            <Link to="/privacy" onClick={leaveSignIn} className="hover:underline">
              {copy.privacy}
            </Link>
            <Link to="/terms" onClick={leaveSignIn} className="hover:underline">
              {copy.terms}
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
