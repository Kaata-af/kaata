import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getWebSession, WebApiError } from "../../lib/web-auth";
import {
  effectiveWebCreditPolicy,
  loadWebCreditPolicies,
  parseWebCreditAmount,
  saveWebCreditPolicy,
  WEB_DEFAULT_CREDIT_ID,
  webCreditAmount,
  webCreditDetail,
  webCreditExposureKnown,
  WebCreditError,
  type WebCreditPolicy,
} from "../../lib/web-credit";
import { CURRENCIES, getCurrencyNameForLocale, searchCurrencies } from "../../lib/mobile-domain";
import { useI18n, type Lang } from "../../lib/i18n";
import type { WebLedger, WebPerson } from "../../lib/web-ledger";
import { money } from "./model";
import "./CreditPanel.css";

const en = {
  title: "Credit limits",
  defaults: "Kaata credit defaults",
  manage: "Manage",
  close: "Close",
  loading: "Loading credit limits…",
  loadError: "Credit limits could not be refreshed.",
  retry: "Try again",
  collect: "They owe us",
  pay: "We owe them",
  unlimited: "Unlimited",
  cap: "Limit",
  remaining: "Left",
  overBy: "Over by",
  near: "Near limit",
  reached: "Limit reached",
  over: "Over limit",
  inherited: "Kaata default",
  custom: "Customer limit",
  none: "No limit set",
  unknown: "Credit exposure is unavailable for this account. Limits are still shown.",
  defaultsHint:
    "These limits apply to customers without their own limits, separately for each currency.",
  currency: "Currency",
  search: "Find a currency",
  noCurrencies: "No matching currencies.",
  collectCap: "Maximum they owe us",
  payCap: "Maximum we owe them",
  amountHint: "Leave blank for unlimited. Zero allows no new credit in that direction.",
  behavior: "When a limit is exceeded",
  warn: "Warn only",
  clerks: "Restrict clerks",
  staff: "Restrict editors and clerks",
  ownerHint: "Owners and admins remain exempt. Repayments are allowed.",
  inheritHint:
    "Saving creates a customer limit for this currency. Other currencies keep their settings.",
  saved: "Limits saved.",
  save: "Save this currency",
  saving: "Saving…",
  cancel: "Cancel",
  permission: "Only the owner or an admin can change credit limits.",
  invalid: "Enter an amount up to 9,999,999,999.99 with at most two decimal places.",
  changed: "These limits changed elsewhere. Reload this currency and review it before saving.",
  reload: "Reload this currency",
  unavailable: "Credit settings are unavailable. Please try again.",
  network: "Cannot reach Kaata. Check your connection and try again.",
  enrollment:
    "Restricted staff must sign in and sync on their phones before this limit can be enabled.",
  saveError: "The save could not be confirmed. Your changes are still here; try again.",
  discard: "Discard unsaved credit-limit changes?",
  keep: "Keep editing",
  discardButton: "Discard changes",
  modeHint: "Saving applies only to the selected currency.",
};
type Copy = { [K in keyof typeof en]: string };
const copies: Record<Lang, Copy> = {
  en,
  fa: {
    title: "حد اعتبار",
    defaults: "حد اعتبار پیش‌فرض کاتا",
    manage: "تنظیم",
    close: "بستن",
    loading: "حد اعتبار بارگذاری می‌شود…",
    loadError: "تازه‌سازی حد اعتبار ممکن نشد.",
    retry: "کوشش دوباره",
    collect: "آن‌ها به ما بدهکارند",
    pay: "ما به آن‌ها بدهکاریم",
    unlimited: "بدون محدودیت",
    cap: "حد",
    remaining: "باقی‌مانده",
    overBy: "بیشتر از حد",
    near: "نزدیک به حد",
    reached: "حد پُر شده",
    over: "بیش از حد",
    inherited: "پیش‌فرض کاتا",
    custom: "حد این شخص",
    none: "حدی تعیین نشده",
    unknown:
      "مقدار اعتبار استفاده‌شده برای این حساب در دسترس نیست. حدهای تعیین‌شده نشان داده می‌شوند.",
    defaultsHint:
      "این حدها برای اشخاصی که حد جداگانه ندارند، برای هر واحد پول به‌صورت مستقل اعمال می‌شوند.",
    currency: "واحد پول",
    search: "جستجوی واحد پول",
    noCurrencies: "واحد پولی پیدا نشد.",
    collectCap: "حداکثر بدهی آن‌ها به ما",
    payCap: "حداکثر بدهی ما به آن‌ها",
    amountHint: "خالی یعنی بدون محدودیت. صفر یعنی اعتبار جدید در آن جهت مجاز نیست.",
    behavior: "وقتی بدهی از حد می‌گذرد",
    warn: "فقط هشدار",
    clerks: "محدود کردن ثبت‌کنندگان",
    staff: "محدود کردن ویرایشگران و ثبت‌کنندگان",
    ownerHint: "مالک و مدیر مستثنا هستند. بازپرداخت مجاز است.",
    inheritHint:
      "ذخیره، برای همین واحد پول حد مخصوص این شخص می‌سازد. تنظیمات واحدهای دیگر حفظ می‌شوند.",
    saved: "حدها ذخیره شدند.",
    save: "ذخیرۀ این واحد پول",
    saving: "در حال ذخیره…",
    cancel: "لغو",
    permission: "فقط مالک یا مدیر می‌تواند حد اعتبار را تغییر دهد.",
    invalid: "مبلغی تا ۹٬۹۹۹٬۹۹۹٬۹۹۹٫۹۹ با حداکثر دو رقم اعشار وارد کنید.",
    changed:
      "این حدها در جای دیگری تغییر کرده‌اند. این واحد پول را تازه‌سازی و پیش از ذخیره بررسی کنید.",
    reload: "تازه‌سازی این واحد پول",
    unavailable: "تنظیمات اعتبار در دسترس نیست. دوباره کوشش کنید.",
    network: "اتصال به کاتا ممکن نشد. انترنت را بررسی کنید و دوباره کوشش کنید.",
    enrollment: "کارکنان محدودشده باید نخست در تلفون خود وارد شوند و همگام‌سازی کنند.",
    saveError: "ذخیره تأیید نشد. تغییرات شما هنوز اینجا است؛ دوباره کوشش کنید.",
    discard: "تغییرات ذخیره‌نشدۀ حد اعتبار کنار گذاشته شوند؟",
    keep: "ادامۀ ویرایش",
    discardButton: "کنار گذاشتن تغییرات",
    modeHint: "ذخیره فقط برای واحد پول انتخاب‌شده اعمال می‌شود.",
  },
  ps: {
    title: "د پور حدونه",
    defaults: "د کاتا د پور اصلي حدونه",
    manage: "تنظیم",
    close: "تړل",
    loading: "د پور حدونه بارېږي…",
    loadError: "د پور حدونه تازه نه شول.",
    retry: "بیا هڅه وکړئ",
    collect: "دوی زموږ پوروړي دي",
    pay: "موږ د دوی پوروړي یو",
    unlimited: "بې محدودیت",
    cap: "حد",
    remaining: "پاتې",
    overBy: "له حده زیات",
    near: "حد ته نږدې",
    reached: "حد پوره شوی",
    over: "له حده اوښتی",
    inherited: "د کاتا اصلي حد",
    custom: "د دې کس حد",
    none: "حد نه دی ټاکل شوی",
    unknown: "د دې حساب کارول شوی پور نه دی معلوم. ټاکل شوي حدونه ښودل کېږي.",
    defaultsHint: "دا حدونه پر هغو کسانو پلي کېږي چې خپل حدونه نه لري، د هرې پیسې لپاره جلا.",
    currency: "د پیسو ډول",
    search: "د پیسو ډول ولټوئ",
    noCurrencies: "د پیسو ډول ونه موندل شو.",
    collectCap: "د دوی د پور تر ټولو لوړه اندازه",
    payCap: "زموږ د پور تر ټولو لوړه اندازه",
    amountHint: "تش پرېښودل بې محدودیت دی. صفر په هغه لوري کې نوی پور نه پرېږدي.",
    behavior: "کله چې پور له حده واوړي",
    warn: "یوازې خبرتیا",
    clerks: "ثبتوونکي محدود کړئ",
    staff: "سموونکي او ثبتوونکي محدود کړئ",
    ownerHint: "مالک او اډمین مستثنا دي. بېرته ورکړه اجازه لري.",
    inheritHint: "ساتل د همدې پیسو لپاره د دې کس خپل حد جوړوي. د نورو پیسو تنظیمات ساتل کېږي.",
    saved: "حدونه وساتل شول.",
    save: "د همدې پیسو حد ساتل",
    saving: "ساتل کېږي…",
    cancel: "لغوه",
    permission: "یوازې مالک یا اډمین د پور حد بدلولی شي.",
    invalid: "تر ۹٬۹۹۹٬۹۹۹٬۹۹۹٫۹۹ پورې اندازه له تر دوو اعشاري شمېرو سره ولیکئ.",
    changed: "دا حدونه بل ځای بدل شوي دي. د دې پیسو حد تازه او تر ساتلو مخکې یې وګورئ.",
    reload: "د دې پیسو حد تازه کړئ",
    unavailable: "د پور تنظیمات د لاسرسي وړ نه دي. بیا هڅه وکړئ.",
    network: "له کاتا سره اړیکه ټینګه نه شوه. انټرنېټ وګورئ او بیا هڅه وکړئ.",
    enrollment: "محدود شوي کارکوونکي باید لومړی پر خپلو ټیلیفونونو ننوځي او همغږي وکړي.",
    saveError: "ساتل تایید نه شول. بدلونونه مو لا دلته دي؛ بیا هڅه وکړئ.",
    discard: "د پور د حد ناساتل شوي بدلونونه پرېږدئ؟",
    keep: "سمون ته دوام",
    discardButton: "بدلونونه پرېښودل",
    modeHint: "ساتل یوازې د ټاکل شوو پیسو لپاره دي.",
  },
};

type Balances = ReadonlyArray<{ currency: string; balance: bigint }>;
type Props = {
  ledger: WebLedger;
  person?: WebPerson;
  balances?: Balances;
  canConfigure: boolean;
  onSaved?: () => void | Promise<void>;
};

function creditError(reason: unknown, c: Copy): string {
  if (reason instanceof WebCreditError) {
    if (reason.code === "invalid_credit_amount") return c.invalid;
    if (reason.code === "stale_credit_policy") return c.changed;
    if (reason.code === "permission_denied" || reason.code === "session_changed")
      return c.permission;
    return c.unavailable;
  }
  if (reason instanceof WebApiError) {
    if (reason.status === 403 || reason.status === 401) return c.permission;
    if (reason.code === "network") return c.network;
    if (
      ["clerk_cloud_enrollment_required", "staff_cloud_enrollment_required"].includes(reason.code)
    )
      return c.enrollment;
    if (reason.status === 404) return c.unavailable;
  }
  return c.saveError;
}

function currencyOptions(
  ledger: WebLedger,
  policies: readonly WebCreditPolicy[],
  balances?: Balances,
) {
  return [
    ...new Set([
      ledger.default_entry_currency,
      ledger.legacy_currency,
      ...ledger.enabled_currencies,
      ...ledger.entries.map((entry) => entry.currency),
      ...policies.map((policy) => policy.currency),
      ...(balances?.map((row) => row.currency) ?? []),
    ]),
  ]
    .filter((code) => /^[A-Z]{3}$/.test(code))
    .sort((a, b) =>
      a === b
        ? 0
        : a === ledger.default_entry_currency
          ? -1
          : b === ledger.default_entry_currency
            ? 1
            : a.localeCompare(b),
    );
}

export function CreditPanel({ ledger, person, balances, canConfigure, onSaved }: Props) {
  const { lang } = useI18n();
  const c = copies[lang];
  const identity = getWebSession();
  const relationship = person?.relationship_id ?? WEB_DEFAULT_CREDIT_ID;
  const scope = JSON.stringify([
    identity?.account_id,
    identity?.install_id,
    ledger.vault_id,
    relationship,
  ]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [data, setData] = useState<{ scope: string; policies: WebCreditPolicy[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const policies = data?.scope === scope ? data.policies : null;
  const shouldLoad = !!person || open === scope;
  useEffect(() => {
    // A return to an earlier Kaata must not reopen its old dialog or drafts.
    setOpen(null);
    setData(null);
    setFailed(false);
  }, [scope]);
  useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void loadWebCreditPolicies(ledger.vault_id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && currentScope.current === scope)
          setData({ scope, policies: value });
      })
      .catch(() => {
        if (!controller.signal.aborted && currentScope.current === scope) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted && currentScope.current === scope) setLoading(false);
      });
    return () => controller.abort();
  }, [ledger, scope, retry, shouldLoad]);
  const relevant =
    policies?.filter(
      (row) =>
        row.relationship_id === relationship || row.relationship_id === WEB_DEFAULT_CREDIT_ID,
    ) ?? [];
  const currencies = currencyOptions(ledger, relevant, balances);
  const allowed =
    canConfigure &&
    ["owner", "manager"].includes(ledger.role) &&
    ledger.archived_at_ms == null &&
    (!person || person.archived_at == null);
  const exposureKnown = !failed && webCreditExposureKnown(ledger, person, balances);
  const editor =
    open === scope ? (
      policies ? (
        <CreditDialog
          key={scope}
          ledger={ledger}
          person={person}
          policies={policies}
          currencies={currencies}
          allowed={allowed}
          c={c}
          lang={lang}
          onPolicies={(value) => setData({ scope, policies: value })}
          onClose={() => setOpen(null)}
          onSaved={onSaved}
        />
      ) : (
        <CreditLoadingDialog
          key={scope}
          c={c}
          lang={lang}
          failed={failed}
          onClose={() => setOpen(null)}
          onRetry={() => setRetry((value) => value + 1)}
        />
      )
    ) : null;
  if (!person)
    return (
      <>
        <button
          type="button"
          className="workspace-button"
          disabled={!allowed}
          onClick={() => {
            // Defaults are a settings action, not another background policy
            // reader alongside the currently open customer's credit panel.
            setData(null);
            setFailed(false);
            setOpen(scope);
          }}
        >
          {c.defaults}
        </button>
        {editor}
      </>
    );
  return (
    <section className="web-credit-panel" aria-label={person ? c.title : c.defaults}>
      <div className="web-credit-heading">
        <h3>{person ? c.title : c.defaults}</h3>
        {allowed && (
          <button
            type="button"
            className="web-credit-link"
            disabled={!policies}
            onClick={() => setOpen(scope)}
          >
            {c.manage}
          </button>
        )}
      </div>
      {!person && <p className="web-credit-hint">{c.defaultsHint}</p>}
      {loading && !policies && (
        <p role="status" className="web-credit-hint">
          {c.loading}
        </p>
      )}
      {failed && (
        <p role="status" className="web-credit-hint">
          {c.loadError}{" "}
          <button
            type="button"
            className="web-credit-link"
            onClick={() => setRetry((value) => value + 1)}
          >
            {c.retry}
          </button>
        </p>
      )}
      {policies && (
        <div className="web-credit-currencies">
          {currencies.map((currency) => {
            const policy = effectiveWebCreditPolicy(policies, relationship, currency);
            const balance = balances?.find((row) => row.currency === currency)?.balance ?? 0n;
            return (
              <div className="web-credit-currency" key={currency}>
                <div className="web-credit-currency-label">
                  <strong dir="ltr">{currency}</strong>
                  <small>
                    {policy
                      ? policy.relationship_id === WEB_DEFAULT_CREDIT_ID
                        ? c.inherited
                        : c.custom
                      : c.none}
                  </small>
                </div>
                {(["collect", "pay"] as const).map((direction) => {
                  const cap =
                    direction === "collect"
                      ? (policy?.max_collect_minor ?? null)
                      : (policy?.max_pay_minor ?? null);
                  const exposure =
                    direction === "collect"
                      ? balance > 0n
                        ? balance
                        : 0n
                      : balance < 0n
                        ? -balance
                        : 0n;
                  const detail = webCreditDetail(cap, exposure);
                  return (
                    <div
                      key={direction}
                      className={`web-credit-direction ${exposureKnown ? detail.status : ""}`}
                    >
                      <span>{c[direction]}</span>
                      <span>
                        {c.cap}:{" "}
                        <bdi>
                          {cap === null ? c.unlimited : `${money(BigInt(cap))} ${currency}`}
                        </bdi>
                      </span>
                      {exposureKnown && detail.remaining !== null && (
                        <small>
                          {detail.remaining < 0n ? c.overBy : c.remaining}:{" "}
                          <bdi>
                            {money(detail.remaining)} {currency}
                          </bdi>
                          {detail.status !== "none" && (
                            <strong className="web-credit-status">{c[detail.status]}</strong>
                          )}
                        </small>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {person && policies && !exposureKnown && <p className="web-credit-hint">{c.unknown}</p>}
      {editor}
    </section>
  );
}

function CreditLoadingDialog({
  c,
  lang,
  failed,
  onClose,
  onRetry,
}: {
  c: Copy;
  lang: Lang;
  failed: boolean;
  onClose: () => void;
  onRetry: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="web-credit-dialog"
      dir={lang === "en" ? "ltr" : "rtl"}
      aria-labelledby="web-credit-loading-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="web-credit-loading-title">{c.defaults}</h2>
        <button type="button" aria-label={c.close} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="web-credit-discard">
        <p role="status">{failed ? c.loadError : c.loading}</p>
        {failed && (
          <div className="web-credit-actions">
            <button type="button" onClick={onRetry}>
              {c.retry}
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}

type Draft = {
  collect: string;
  pay: string;
  behavior: "warn" | "clerks" | "staff";
  expected: WebCreditPolicy | null;
  base: string;
};
function draftFor(
  policies: readonly WebCreditPolicy[],
  relationship: string,
  currency: string,
): Draft {
  const effective = effectiveWebCreditPolicy(policies, relationship, currency);
  const value = {
    collect: webCreditAmount(effective?.max_collect_minor ?? null),
    pay: webCreditAmount(effective?.max_pay_minor ?? null),
    behavior:
      effective?.mode === "clerk_block"
        ? effective.restrict_editors
          ? ("staff" as const)
          : ("clerks" as const)
        : ("warn" as const),
  };
  return {
    ...value,
    expected:
      policies.find((row) => row.relationship_id === relationship && row.currency === currency) ??
      null,
    base: JSON.stringify(value),
  };
}
function dirty(draft: Draft): boolean {
  return (
    JSON.stringify({ collect: draft.collect, pay: draft.pay, behavior: draft.behavior }) !==
    draft.base
  );
}

function CreditDialog({
  ledger,
  person,
  policies,
  currencies,
  allowed,
  c,
  lang,
  onPolicies,
  onClose,
  onSaved,
}: {
  ledger: WebLedger;
  person?: WebPerson;
  policies: WebCreditPolicy[];
  currencies: string[];
  allowed: boolean;
  c: Copy;
  lang: Lang;
  onPolicies: (policies: WebCreditPolicy[]) => void;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  const relationship = person?.relationship_id ?? WEB_DEFAULT_CREDIT_ID;
  const [currency, setCurrency] = useState(currencies[0] ?? ledger.default_entry_currency);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => ({
    [currency]: draftFor(policies, relationship, currency),
  }));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [saved, setSaved] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const saving = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const latestAllowed = useRef(allowed);
  latestAllowed.current = allowed;
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    return () => {
      alive.current = false;
      controller.current?.abort();
      dialog.current?.close();
    };
  }, []);
  useEffect(() => {
    if (!allowed) controller.current?.abort();
  }, [allowed]);
  const draft = drafts[currency] ?? draftFor(policies, relationship, currency);
  const matches = useMemo(() => {
    if (!query.trim()) return currencies;
    const found = new Set(searchCurrencies(query, lang).map((item) => item.code));
    return currencies.filter(
      (code) =>
        found.has(code) ||
        (!CURRENCIES.some((item) => item.code === code) &&
          code.toLowerCase().includes(query.trim().toLowerCase())),
    );
  }, [currencies, query, lang]);
  function choose(next: string) {
    setDrafts((current) =>
      current[next] ? current : { ...current, [next]: draftFor(policies, relationship, next) },
    );
    setCurrency(next);
    setError("");
    setChanged(false);
    setSaved(false);
  }
  function update(values: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [currency]: { ...draft, ...values } }));
    setSaved(false);
    setError("");
    setChanged(false);
  }
  function close() {
    if (saving.current) return;
    if (Object.values(drafts).some(dirty)) setDiscard(true);
    else onClose();
  }
  async function reload() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    const request = new AbortController();
    controller.current = request;
    try {
      const latest = await loadWebCreditPolicies(ledger.vault_id, request.signal);
      if (!alive.current) return;
      onPolicies(latest);
      setDrafts((current) => ({
        ...current,
        [currency]: draftFor(latest, relationship, currency),
      }));
      setChanged(false);
    } catch (reason) {
      if (alive.current) setError(creditError(reason, c));
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !latestAllowed.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    setChanged(false);
    const request = new AbortController();
    controller.current = request;
    try {
      const input = {
        relationship_id: relationship,
        currency,
        max_collect_minor: parseWebCreditAmount(draft.collect),
        max_pay_minor: parseWebCreditAmount(draft.pay),
        mode: draft.behavior === "warn" ? ("warn" as const) : ("clerk_block" as const),
        restrict_editors: draft.behavior === "staff",
      };
      const result = await saveWebCreditPolicy(ledger, input, draft.expected, request.signal);
      if (!alive.current) return;
      const next = policies
        .filter((row) => row.relationship_id !== relationship || row.currency !== currency)
        .concat(result);
      onPolicies(next);
      setDrafts((current) => ({ ...current, [currency]: draftFor(next, relationship, currency) }));
      setSaved(true);
      void Promise.resolve(onSaved?.()).catch(() => {});
    } catch (reason) {
      if (alive.current) {
        setError(creditError(reason, c));
        setChanged(reason instanceof WebCreditError && reason.code === "stale_credit_policy");
      }
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="web-credit-dialog"
      dir={lang === "en" ? "ltr" : "rtl"}
      aria-labelledby="web-credit-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <h2 id="web-credit-title">{person ? c.title : c.defaults}</h2>
          <p>{person?.name ?? ledger.name}</p>
        </div>
        <button type="button" disabled={busy} aria-label={c.close} onClick={close}>
          ×
        </button>
      </header>
      {discard ? (
        <div className="web-credit-discard">
          <p>{c.discard}</p>
          <div className="web-credit-actions">
            <button type="button" onClick={() => setDiscard(false)}>
              {c.keep}
            </button>
            <button type="button" className="danger" onClick={onClose}>
              {c.discardButton}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          {!person && <p className="web-credit-hint">{c.defaultsHint}</p>}
          <fieldset disabled={busy || !allowed}>
            {currencies.length > 1 && (
              <div className="web-credit-picker">
                <label htmlFor="web-credit-search">{c.currency}</label>
                <input
                  id="web-credit-search"
                  type="search"
                  placeholder={c.search}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <select
                  aria-label={c.currency}
                  value={currency}
                  onChange={(event) => choose(event.target.value)}
                >
                  {[...new Set([currency, ...matches])].map((code) => (
                    <option key={code} value={code}>
                      {code} · {getCurrencyNameForLocale(code, lang)}
                    </option>
                  ))}
                </select>
                {!matches.length && <small>{c.noCurrencies}</small>}
              </div>
            )}
            <p className="web-credit-selected">
              <bdi>{currency}</bdi> · {getCurrencyNameForLocale(currency, lang)}
            </p>
            {(["collect", "pay"] as const).map((direction) => (
              <label className="web-credit-field" key={direction}>
                <span>{direction === "collect" ? c.collectCap : c.payCap}</span>
                <span className="web-credit-amount">
                  <input
                    dir="ltr"
                    inputMode="decimal"
                    maxLength={32}
                    value={draft[direction]}
                    placeholder={c.unlimited}
                    onChange={(event) => update({ [direction]: event.target.value })}
                  />
                  <bdi>{currency}</bdi>
                </span>
              </label>
            ))}
            <p className="web-credit-hint">{c.amountHint}</p>
            <label className="web-credit-field">
              <span>{c.behavior}</span>
              <select
                value={draft.behavior}
                onChange={(event) => update({ behavior: event.target.value as Draft["behavior"] })}
              >
                <option value="warn">{c.warn}</option>
                <option value="clerks">{c.clerks}</option>
                <option value="staff">{c.staff}</option>
              </select>
            </label>
            <p className="web-credit-hint">{c.ownerHint}</p>
            {person && draft.expected === null && (
              <p className="web-credit-hint">{c.inheritHint}</p>
            )}
          </fieldset>
          {!allowed && (
            <p className="web-credit-error" role="alert">
              {c.permission}
            </p>
          )}
          {error && (
            <p className="web-credit-error" role="alert">
              {error}{" "}
              {changed && (
                <button
                  type="button"
                  className="web-credit-link"
                  disabled={busy}
                  onClick={() => void reload()}
                >
                  {c.reload}
                </button>
              )}
            </p>
          )}
          {saved && (
            <p className="web-credit-success" role="status">
              {c.saved}
            </p>
          )}
          <p className="web-credit-hint">{c.modeHint}</p>
          <div className="web-credit-actions">
            <button type="button" disabled={busy} onClick={close}>
              {c.cancel}
            </button>
            <button type="submit" className="primary" disabled={busy || !allowed}>
              {busy ? c.saving : c.save}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
