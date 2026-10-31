import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { BrandLogo } from "../../components/BrandLogo";
import { useI18n, type Lang } from "../../lib/i18n";
import { WebApiError, type WebSession } from "../../lib/web-auth";
import { WEB_ROUTES } from "../../lib/web-routes";
import { openWebRouteDialog } from "../../lib/web-route-dialog";
import {
  createWebProCheckout,
  getWebProOrder,
  getWebProStatus,
  WEB_PRO_OFFERS,
  webProCanStartCheckout,
  validateWebProCheckoutURL,
  webProReturnOrder,
  type WebProCheckout,
  type WebProOrder,
  type WebProPlan,
  type WebProStatus,
} from "../../lib/web-pro";
import "./WebPro.css";

const UPDATE_EVENT = "kaata:web-pro-updated";
const copies = {
  en: {
    name: "Kaata Pro",
    trial: "Free trial",
    active: "Pro active",
    subscribe: "Subscribe",
    manage: "Your subscription",
    trialBody: "All web features are available during the free trial.",
    back: "Back to your kaatas",
    language: "Language",
    heading: "More room for your kaata.",
    intro: "Use Kaata on Windows, Mac, and the web with one Pro subscription for your account.",
    open: "Your trial stays open. You can keep using every web feature without subscribing for now.",
    monthly: "Monthly",
    yearly: "Yearly",
    month: "1 month",
    year: "12 months",
    coverage: "For your Kaata web account",
    prepaid: "Pay for the period you choose. No automatic renewal.",
    features: [
      "Your people and tallies, synced with your phone",
      "Notes, history, and credit limits",
      "All your currencies and statement exports",
    ],
    choose: "Choose your plan",
    pay: "Subscribe with HesabPay",
    extend: "Add more Pro time",
    preparing: "Preparing checkout…",
    continue: "Continue to HesabPay",
    checkoutReady: "Your checkout is ready.",
    secure: "Complete payment on HesabPay’s secure checkout.",
    checkoutPeriod: "Your selected plan",
    notReady:
      "HesabPay payments are being set up. Your free trial remains open; check back here to subscribe.",
    loading: "Loading subscription…",
    error: "Subscription details could not load. Your web access is still available.",
    checkoutError: "Checkout could not be prepared. Try again or check your subscription status.",
    checkoutPending:
      "Your checkout is still being prepared. Check your subscription status before trying again.",
    refresh: "Check status",
    retry: "Try again",
    expires: "Pro is active until {date}.",
    paymentPending:
      "Payment confirmation is pending. Your trial remains open while we check with HesabPay.",
    paymentConfirmed: "Payment confirmed. Your Pro subscription is active.",
    paymentFailed:
      "This payment was not completed. Your trial remains open, and you can try again.",
    paymentExpired:
      "This checkout link has expired. A payment already started may still be confirmed. Check status before making another payment.",
    paymentUnknown:
      "We could not check this payment yet. Keep using your kaatas and check status again shortly.",
    paymentNotFound:
      "This payment link does not match a payment for your account. You can choose a plan below.",
    pendingOther:
      "Another payment for your account is still awaiting confirmation. Review it before starting another checkout.",
    reviewPending: "Review earlier payment",
    replaceWarning:
      "The earlier checkout has expired, but an already-started payment may still be confirmed. Check HesabPay before starting another payment.",
    replaceAcknowledge: "I checked HesabPay and want to start a new checkout.",
    phone: "This plan is for Kaata Web. Pro subscriptions in the phone app will come later.",
  },
  fa: {
    name: "کاتا پرو",
    trial: "دورۀ آزمایشی رایگان",
    active: "پرو فعال است",
    subscribe: "خرید اشتراک",
    manage: "اشتراک شما",
    trialBody: "در دورۀ آزمایشی رایگان، همۀ امکانات وب در دسترس شما است.",
    back: "بازگشت به کاتاهای شما",
    language: "زبان",
    heading: "جای بیشتر برای کاتای شما.",
    intro: "با یک اشتراک پرو برای حساب‌تان، کاتا را در ویندوز، مک و وب استفاده کنید.",
    open: "دورۀ آزمایشی شما باز است. فعلاً می‌توانید بدون خرید اشتراک از همۀ امکانات وب استفاده کنید.",
    monthly: "ماهانه",
    yearly: "سالانه",
    month: "۱ ماه",
    year: "۱۲ ماه",
    coverage: "برای حساب کاتای وب شما",
    prepaid: "برای دورۀ دلخواه پرداخت کنید. تمدید خودکار ندارد.",
    features: [
      "اشخاص و ثبت‌های شما، همگام با تلفون",
      "یادداشت‌ها، تاریخچه و حد اعتبار",
      "همۀ واحدهای پول و صدور صورت‌حساب",
    ],
    choose: "اشتراک خود را انتخاب کنید",
    pay: "خرید اشتراک با حساب‌پی",
    extend: "افزودن مدت اشتراک پرو",
    preparing: "آماده‌سازی پرداخت…",
    continue: "ادامه در حساب‌پی",
    checkoutReady: "صفحۀ پرداخت شما آماده است.",
    secure: "پرداخت را در صفحۀ امن حساب‌پی تکمیل کنید.",
    checkoutPeriod: "اشتراک انتخاب‌شدۀ شما",
    notReady:
      "پرداخت با حساب‌پی در حال آماده‌سازی است. دورۀ آزمایشی شما باز می‌ماند؛ برای خرید اشتراک دوباره سر بزنید.",
    loading: "اشتراک بارگذاری می‌شود…",
    error: "جزئیات اشتراک بارگذاری نشد. دسترسی شما به وب همچنان باز است.",
    checkoutError: "صفحۀ پرداخت آماده نشد. دوباره کوشش کنید یا وضعیت اشتراک را بررسی کنید.",
    checkoutPending:
      "صفحۀ پرداخت هنوز آماده می‌شود. پیش از کوشش دوباره، وضعیت اشتراک را بررسی کنید.",
    refresh: "بررسی وضعیت",
    retry: "کوشش دوباره",
    expires: "اشتراک پرو تا {date} فعال است.",
    paymentPending:
      "تأیید پرداخت در انتظار است. تا بررسی با حساب‌پی، دورۀ آزمایشی شما باز می‌ماند.",
    paymentConfirmed: "پرداخت تأیید شد. اشتراک پرو شما فعال است.",
    paymentFailed: "این پرداخت تکمیل نشد. دورۀ آزمایشی شما باز است و می‌توانید دوباره کوشش کنید.",
    paymentExpired:
      "مهلت این پیوند پرداخت پایان یافته است. پرداختی که آغاز شده، ممکن است هنوز تأیید شود. پیش از پرداخت دوباره، وضعیت را بررسی کنید.",
    paymentUnknown:
      "هنوز نتوانستیم این پرداخت را بررسی کنیم. از کاتاهای‌تان استفاده کنید و کمی بعد وضعیت را دوباره بررسی کنید.",
    paymentNotFound:
      "این پیوند به پرداختی برای حساب شما مربوط نیست. می‌توانید اشتراک دلخواه را در پایین انتخاب کنید.",
    pendingOther:
      "پرداخت دیگری برای حساب شما هنوز در انتظار تأیید است. پیش از باز کردن صفحۀ پرداخت تازه، آن را بررسی کنید.",
    reviewPending: "بررسی پرداخت قبلی",
    replaceWarning:
      "مهلت صفحۀ پرداخت قبلی پایان یافته، اما پرداختی که آغاز شده ممکن است هنوز تأیید شود. پیش از پرداخت دوباره، حساب‌پی را بررسی کنید.",
    replaceAcknowledge: "حساب‌پی را بررسی کردم و می‌خواهم صفحۀ پرداخت تازه باز کنم.",
    phone: "این اشتراک برای کاتای وب است. اشتراک پرو در اپ تلفون بعداً اضافه می‌شود.",
  },
  ps: {
    name: "کاتا پرو",
    trial: "وړیا ازمایښتي دوره",
    active: "پرو فعال دی",
    subscribe: "ګډون واخلئ",
    manage: "ستاسو ګډون",
    trialBody: "د وړیا ازمایښتي دورې پر مهال د وېب ټولې اسانتیاوې شته.",
    back: "بېرته خپلو کاتاګانو ته",
    language: "ژبه",
    heading: "ستاسو د کاتا لپاره ډېر ځای.",
    intro: "د خپل حساب په یوه پرو ګډون سره کاتا په وینډوز، مک او وېب کې وکاروئ.",
    open: "ستاسو ازمایښتي دوره پرانیستې ده. اوس د ګډون له اخیستلو پرته د وېب ټولې اسانتیاوې کارولی شئ.",
    monthly: "میاشتنی",
    yearly: "کلنی",
    month: "۱ میاشت",
    year: "۱۲ میاشتې",
    coverage: "ستاسو د کاتا وېب حساب لپاره",
    prepaid: "د خپلې خوښې مودې لپاره پیسې ورکړئ. په خپله نه نوي کېږي.",
    features: [
      "ستاسو کسان او ثبتونه، له موبایل سره همغږي",
      "یادښتونه، تاریخچه او د پور حدونه",
      "ټول اسعار او د حساب پاڼو صادرول",
    ],
    choose: "خپل ګډون وټاکئ",
    pay: "د حساب‌پی له لارې ګډون",
    extend: "د پرو موده زیاته کړئ",
    preparing: "د پیسو پاڼه چمتو کېږي…",
    continue: "په حساب‌پی کې دوام",
    checkoutReady: "ستاسو د پیسو پاڼه چمتو ده.",
    secure: "پیسې د حساب‌پی په خوندي پاڼه کې ورکړئ.",
    checkoutPeriod: "ستاسو ټاکل شوی ګډون",
    notReady:
      "د حساب‌پی تادیات چمتو کېږي. ستاسو وړیا ازمایښتي دوره پرانیستې ده؛ د ګډون لپاره وروسته بیا راشئ.",
    loading: "ګډون بارېږي…",
    error: "د ګډون معلومات بار نه شول. وېب ته ستاسو لاسرسی لا هم شته.",
    checkoutError: "د پیسو پاڼه چمتو نه شوه. بیا هڅه وکړئ یا د ګډون حالت وګورئ.",
    checkoutPending: "د پیسو پاڼه لا چمتو کېږي. تر بیا هڅې مخکې د ګډون حالت وګورئ.",
    refresh: "حالت وګورئ",
    retry: "بیا هڅه",
    expires: "پرو تر {date} پورې فعال دی.",
    paymentPending:
      "د پیسو تایید ته انتظار دی. له حساب‌پی سره د کتنې پر مهال ستاسو ازمایښتي دوره پرانیستې ده.",
    paymentConfirmed: "پیسې تایید شوې. ستاسو پرو ګډون فعال دی.",
    paymentFailed: "دا تادیه بشپړه نه شوه. ستاسو ازمایښتي دوره پرانیستې ده او بیا هڅه کولی شئ.",
    paymentExpired:
      "د دې تادیې د تړوني موده پای ته رسېدلې. پیل شوې تادیه لا هم تایید کېدای شي. تر بلې تادیې مخکې حالت وګورئ.",
    paymentUnknown: "دا تادیه مو لا ونه کتله. خپلې کاتاګانې وکاروئ او لږ وروسته حالت بیا وګورئ.",
    paymentNotFound: "دا تړونی ستاسو د حساب له تادیې سره سمون نه خوري. لاندې خپل ګډون ټاکلی شئ.",
    pendingOther:
      "ستاسو د حساب بله تادیه لا هم تایید ته په تمه ده. د نوې تادیې د پاڼې تر پرانیستلو مخکې هغه وګورئ.",
    reviewPending: "پخوانۍ تادیه وګورئ",
    replaceWarning:
      "د پخوانۍ تادیې د پاڼې موده پای ته رسېدلې، خو پیل شوې تادیه لا هم تایید کېدای شي. تر بلې تادیې مخکې حساب‌پی وګورئ.",
    replaceAcknowledge: "حساب‌پی مې وکوت او غواړم د تادیې نوې پاڼه پرانیزم.",
    phone: "دا ګډون د کاتا وېب لپاره دی. د موبایل اپ پرو ګډون به وروسته راشي.",
  },
};

function locale(lang: Lang) {
  return lang === "en" ? "en" : lang === "fa" ? "fa-AF" : "ps-AF";
}
function expiresAt(value: string, lang: Lang) {
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: "medium", calendar: "gregory" }).format(
    new Date(value),
  );
}
function useWebProStatus(session: WebSession) {
  const [status, setStatus] = useState<WebProStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const next = await getWebProStatus(session, controller.signal);
      if (!controller.signal.aborted) setStatus(next);
      return next;
    } catch {
      if (!controller.signal.aborted) setFailed(true);
      return null;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [session]);
  useEffect(() => {
    void refresh();
    const update = () => {
      void refresh();
    };
    window.addEventListener("focus", update);
    window.addEventListener(UPDATE_EVENT, update);
    return () => {
      request.current?.abort();
      window.removeEventListener("focus", update);
      window.removeEventListener(UPDATE_EVENT, update);
    };
  }, [refresh]);
  return { status, loading, failed, refresh };
}

export function WebProBanner({ session }: { session: WebSession }) {
  const { lang } = useI18n();
  const c = copies[lang];
  const { status } = useWebProStatus(session);
  const active = status?.status === "active";
  return (
    <section className="web-pro-banner" aria-label={c.name}>
      <div>
        <strong>{c.name}</strong>
        <span className="web-pro-badge">{active ? c.active : c.trial}</span>
        <p>
          {active && status.subscription_expires_at
            ? c.expires.replace("{date}", expiresAt(status.subscription_expires_at, lang))
            : c.trialBody}
        </p>
      </div>
      <Link to={WEB_ROUTES.subscription}>{active ? c.manage : c.subscribe}</Link>
    </section>
  );
}

export function WebProPage({ session }: { session: WebSession }) {
  const { lang, setLang } = useI18n();
  const c = copies[lang];
  const navigate = useNavigate();
  const location = useLocation();
  const dialog = useRef<HTMLDialogElement>(null);
  const { status, loading, failed, refresh } = useWebProStatus(session);
  const [selected, setSelected] = useState<WebProPlan["id"]>("web_pro_monthly");
  const [checkout, setCheckout] = useState<WebProCheckout | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [returnOrder] = useState(() => webProReturnOrder(location.search));
  const [localOrderID, setLocalOrderID] = useState<string | null>(null);
  const [order, setOrder] = useState<WebProOrder | null>(null);
  const [failedOrderID, setFailedOrderID] = useState<string | null>(null);
  const [missingOrderID, setMissingOrderID] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<string | null>(null);
  const [orderRetry, setOrderRetry] = useState(0);
  const requestID = useRef<string | null>(null);
  const checkoutRequest = useRef<AbortController | null>(null);
  const reflectedOrder = useRef<string | null>(null);
  const offers = status?.plans.length ? status.plans : WEB_PRO_OFFERS;
  const plan = offers.find((offer) => offer.id === selected) ?? offers[0];
  const active = status?.status === "active";
  const trackedOrderID = localOrderID ?? returnOrder ?? status?.pending_order_id;
  const currentOrder = order?.order_id === trackedOrderID ? order : null;
  const orderNotFound = !!trackedOrderID && missingOrderID === trackedOrderID;
  const orderFailed = !!trackedOrderID && failedOrderID === trackedOrderID;
  const hasDifferentPending =
    !!status?.pending_order_id && status.pending_order_id !== trackedOrderID;
  const canStartCheckout =
    !hasDifferentPending &&
    webProCanStartCheckout(
      !!trackedOrderID,
      currentOrder?.status ?? null,
      orderNotFound,
      currentOrder?.can_start_new_checkout,
      replacement === trackedOrderID,
    );
  let preparedCheckout: WebProCheckout | null = null;
  if (
    !currentOrder?.can_start_new_checkout &&
    !["paid", "failed"].includes(currentOrder?.status ?? "")
  ) {
    if (checkout?.order_id === trackedOrderID) preparedCheckout = checkout;
    else if (trackedOrderID && currentOrder?.checkout_url && status) {
      try {
        preparedCheckout = {
          order_id: trackedOrderID,
          checkout_url: validateWebProCheckoutURL(currentOrder.checkout_url, status.checkout_hosts),
        };
      } catch {
        /* Leave an invalid provider link unavailable. */
      }
    }
  }
  const checkoutPlan = offers.find((offer) => offer.id === currentOrder?.plan_id) ?? plan;

  useEffect(() => {
    const element = dialog.current;
    const close = element ? openWebRouteDialog(element) : undefined;
    return () => {
      checkoutRequest.current?.abort();
      close?.();
    };
  }, []);
  useEffect(() => {
    // HesabPay may append result metadata. It is neither payment proof nor
    // content for our UI, and does not need to remain in browser history.
    if (location.search || location.hash) navigate(WEB_ROUTES.subscription, { replace: true });
  }, [location.search, location.hash, navigate]);
  useEffect(() => {
    if (!trackedOrderID) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const check = async () => {
      try {
        const next = await getWebProOrder(session, trackedOrderID, controller.signal);
        if (controller.signal.aborted) return;
        setOrder(next);
        setFailedOrderID(null);
        setMissingOrderID(null);
        if (reflectedOrder.current !== trackedOrderID) {
          reflectedOrder.current = trackedOrderID;
          setSelected(next.plan_id);
          setReplacement(null);
        }
        if (next.status === "paid") {
          await refresh();
          setLocalOrderID(null);
          window.dispatchEvent(new Event(UPDATE_EVENT));
        } else if (["creating", "pending"].includes(next.status) && ++attempts < 10) {
          timer = setTimeout(() => void check(), 3000);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const notFound =
            error instanceof WebApiError &&
            error.status === 404 &&
            error.code === "order_not_found";
          setMissingOrderID(notFound ? trackedOrderID : null);
          setFailedOrderID(notFound ? null : trackedOrderID);
        }
      }
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session, trackedOrderID, orderRetry, refresh]);

  async function prepareCheckout() {
    if (!status?.checkout_ready || busy || !plan || !canStartCheckout) return;
    setBusy(true);
    setCheckoutError("");
    const controller = new AbortController();
    checkoutRequest.current = controller;
    requestID.current ??= crypto.randomUUID();
    try {
      const result = await createWebProCheckout(
        session,
        plan,
        requestID.current,
        status.checkout_hosts,
        controller.signal,
        replacement === trackedOrderID && currentOrder?.can_start_new_checkout
          ? (trackedOrderID ?? undefined)
          : undefined,
      );
      if (!controller.signal.aborted) {
        setCheckout(result);
        setLocalOrderID(result.order_id);
        setReplacement(null);
        void refresh();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setCheckoutError(
          error instanceof WebApiError && error.code === "checkout_pending"
            ? c.checkoutPending
            : c.checkoutError,
        );
        void refresh();
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function checkStatus() {
    void refresh();
    if (trackedOrderID) setOrderRetry((value) => value + 1);
  }
  return (
    <dialog
      ref={dialog}
      className="web-pro-page"
      dir={lang === "en" ? "ltr" : "rtl"}
      aria-labelledby="web-pro-title"
      onCancel={(event) => {
        event.preventDefault();
        navigate(WEB_ROUTES.workspace);
      }}
    >
      <header className="web-pro-header">
        <Link to={WEB_ROUTES.workspace} className="web-pro-brand">
          <BrandLogo className="h-8 w-8" />
          {lang === "en" ? "kaata." : "کاتا."}
        </Link>
        <label>
          <span className="sr-only">{c.language}</span>
          <select value={lang} onChange={(event) => setLang(event.target.value as Lang)}>
            <option value="en">English</option>
            <option value="fa">دری</option>
            <option value="ps">پښتو</option>
          </select>
        </label>
      </header>
      <main className="web-pro-content">
        <Link className="web-pro-back" to={WEB_ROUTES.workspace}>
          ← {c.back}
        </Link>
        <div className="web-pro-intro">
          <span className="web-pro-badge">{active ? c.active : c.trial}</span>
          <p className="web-pro-eyebrow">{c.name}</p>
          <h1 id="web-pro-title" tabIndex={-1}>
            {c.heading}
          </h1>
          <p>{c.intro}</p>
        </div>
        <div className="web-pro-access" role="status">
          {active && status?.subscription_expires_at
            ? c.expires.replace("{date}", expiresAt(status.subscription_expires_at, lang))
            : c.open}
        </div>
        {trackedOrderID && (
          <div className={`web-pro-result ${orderFailed ? "is-warning" : ""}`} role="status">
            {orderNotFound
              ? c.paymentNotFound
              : orderFailed
                ? c.paymentUnknown
                : currentOrder?.status === "paid"
                  ? c.paymentConfirmed
                  : currentOrder?.status === "expired"
                    ? c.paymentExpired
                    : currentOrder?.status === "failed"
                      ? c.paymentFailed
                      : c.paymentPending}
          </div>
        )}
        {hasDifferentPending && (
          <div className="web-pro-payment-note" role="status">
            <p>{c.pendingOther}</p>
            <button
              type="button"
              onClick={() => {
                setLocalOrderID(status!.pending_order_id);
                setCheckout(null);
                setReplacement(null);
              }}
            >
              {c.reviewPending}
            </button>
          </div>
        )}
        <ul className="web-pro-features">
          {c.features.map((feature) => (
            <li key={feature}>
              <span aria-hidden="true">✓</span>
              {feature}
            </li>
          ))}
        </ul>
        <section className="web-pro-plans" aria-label={c.choose}>
          <div className="web-pro-options" role="radiogroup" aria-label={c.choose}>
            {offers.map((offer) => (
              <label
                key={offer.id}
                className={`web-pro-plan ${plan.id === offer.id ? "is-selected" : ""}`}
              >
                <input
                  type="radio"
                  name="web-pro-plan"
                  value={offer.id}
                  checked={plan.id === offer.id}
                  disabled={busy || !canStartCheckout}
                  onChange={() => {
                    setSelected(offer.id);
                    requestID.current = null;
                    setCheckout(null);
                    setCheckoutError("");
                  }}
                />
                <span className="web-pro-plan-name">
                  {offer.duration_months === 1 ? c.monthly : c.yearly}
                </span>
                <strong>
                  <bdi>
                    {new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 2 }).format(
                      offer.amount_minor / 100,
                    )}{" "}
                    <small>AFN</small>
                  </bdi>
                </strong>
                <span>{offer.duration_months === 1 ? c.month : c.year}</span>
              </label>
            ))}
          </div>
          <p className="web-pro-coverage">{c.coverage}</p>
          <p className="web-pro-prepaid">{c.prepaid}</p>
          {loading && !status ? (
            <p role="status">{c.loading}</p>
          ) : failed ? (
            <div className="web-pro-payment-note" role="status">
              <p>{c.error}</p>
              <button type="button" onClick={checkStatus}>
                {c.retry}
              </button>
            </div>
          ) : null}
          {!status?.checkout_ready && !loading && !failed && (
            <p className="web-pro-payment-note">{c.notReady}</p>
          )}
          {checkoutError && (
            <p className="web-pro-payment-note is-warning" role="alert">
              {checkoutError}
            </p>
          )}
          {trackedOrderID &&
            currentOrder?.can_start_new_checkout &&
            !["paid", "failed"].includes(currentOrder.status) && (
              <div className="web-pro-payment-note is-warning">
                <p>{c.replaceWarning}</p>
                <label className="web-pro-replace">
                  <input
                    type="checkbox"
                    checked={replacement === trackedOrderID}
                    onChange={(event) => {
                      setReplacement(event.target.checked ? trackedOrderID : null);
                      requestID.current = null;
                      setCheckout(null);
                    }}
                  />
                  {c.replaceAcknowledge}
                </label>
              </div>
            )}
          {preparedCheckout ? (
            <div className="web-pro-checkout" role="status">
              <strong>{c.checkoutReady}</strong>
              <p>
                {c.checkoutPeriod}: {checkoutPlan.duration_months === 1 ? c.monthly : c.yearly} ·{" "}
                <bdi>
                  {new Intl.NumberFormat(locale(lang)).format(checkoutPlan.amount_minor / 100)} AFN
                </bdi>
              </p>
              <a
                className="web-pro-primary"
                href={preparedCheckout.checkout_url}
                referrerPolicy="origin"
              >
                {c.continue} <span aria-hidden="true">↗</span>
              </a>
              <p>{c.secure}</p>
            </div>
          ) : (
            <button
              type="button"
              className="web-pro-primary"
              disabled={!status?.checkout_ready || loading || busy || failed || !canStartCheckout}
              onClick={() => void prepareCheckout()}
            >
              {busy ? c.preparing : active ? c.extend : c.pay}
            </button>
          )}
          <button
            type="button"
            className="web-pro-refresh"
            disabled={loading}
            onClick={checkStatus}
          >
            {c.refresh}
          </button>
        </section>
        <p className="web-pro-phone">{c.phone}</p>
      </main>
    </dialog>
  );
}
