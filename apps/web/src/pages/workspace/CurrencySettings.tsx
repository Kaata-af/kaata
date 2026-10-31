import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { CURRENCIES, getCurrencyNameForLocale, searchCurrencies } from "../../lib/mobile-domain";
import {
  getWebLedger,
  updateWebCurrencies,
  WebLedgerError,
  type WebLedger,
} from "../../lib/web-ledger";

const copy = {
  en: {
    title: "Currencies",
    search: "Search currency or country",
    default: "Default for new tallies",
    enabled: "Enabled currencies",
    hint: "Choose up to 64. Saved tallies keep their original currency.",
    limit: "Choose no more than 64 currencies.",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    error: "Currencies could not be saved. Try again.",
    stale: "Currencies changed on another device. Load the latest choices before saving.",
    reload: "Load latest choices",
    none: "No currencies found",
    close: "Close",
    selected: "selected",
  },
  fa: {
    title: "واحدهای پول",
    search: "جستجوی واحد پول یا کشور",
    default: "واحد پیش‌فرض ثبت‌های جدید",
    enabled: "واحدهای فعال",
    hint: "تا ۶۴ واحد انتخاب کنید. واحد پول ثبت‌های قبلی تغییر نمی‌کند.",
    limit: "بیشتر از ۶۴ واحد انتخاب نکنید.",
    save: "ثبت",
    saving: "در حال ثبت…",
    cancel: "لغو",
    error: "واحدهای پول ثبت نشد. دوباره کوشش کنید.",
    stale: "واحدهای پول در دستگاه دیگری تغییر کرده‌اند. پیش از ثبت، گزینه‌های تازه را بار کنید.",
    reload: "بارگذاری گزینه‌های تازه",
    none: "واحد پول پیدا نشد",
    close: "بستن",
    selected: "انتخاب‌شده",
  },
  ps: {
    title: "د پیسو واحدونه",
    search: "د پیسو واحد یا هېواد ولټوئ",
    default: "د نویو ثبتونو اصلي واحد",
    enabled: "فعال واحدونه",
    hint: "تر ۶۴ واحدونو وټاکئ. د پخوانیو ثبتونو واحد نه بدلېږي.",
    limit: "له ۶۴ څخه ډېر واحدونه مه ټاکئ.",
    save: "ساتل",
    saving: "ساتل کېږي…",
    cancel: "لغوه",
    error: "واحدونه خوندي نه شول. بیا هڅه وکړئ.",
    stale: "واحدونه په بله وسیله بدل شوي. له ساتلو مخکې تازه ټاکنې راواخلئ.",
    reload: "تازه ټاکنې راواخلئ",
    none: "واحد ونه موندل شو",
    close: "تړل",
    selected: "ټاکل شوي",
  },
};

export function CurrencyPicker({
  value,
  onChange,
  codes,
  disabled = false,
  label,
}: {
  value: string;
  onChange: (code: string) => void;
  codes?: readonly string[];
  disabled?: boolean;
  label?: string;
}) {
  const { lang } = useI18n();
  const c = copy[lang];
  const [query, setQuery] = useState("");
  const details = useRef<HTMLDetailsElement>(null);
  const available = codes ? new Set(codes) : null;
  const choices = searchCurrencies(query, lang).filter(
    (item) => !available || available.has(item.code),
  );
  const custom =
    codes?.filter(
      (code) =>
        !CURRENCIES.some((item) => item.code === code) &&
        code.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  return (
    <div className="workspace-currency-picker">
      {label && <p className="workspace-control-label">{label}</p>}
      <details ref={details}>
        <summary
          aria-disabled={disabled}
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
        >
          <bdi>{value}</bdi> · {getCurrencyNameForLocale(value, lang)}
        </summary>
        <div className="workspace-currency-options">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={c.search}
            placeholder={c.search}
            disabled={disabled}
          />
          <div className="workspace-currency-list">
            {[...choices.map((item) => item.code), ...custom].map((code) => (
              <button
                type="button"
                key={code}
                disabled={disabled}
                aria-pressed={code === value}
                onClick={() => {
                  onChange(code);
                  if (details.current) details.current.open = false;
                  setQuery("");
                }}
              >
                <bdi>{code}</bdi>
                <span>{getCurrencyNameForLocale(code, lang)}</span>
                {code === value && <span aria-hidden="true">✓</span>}
              </button>
            ))}
            {!choices.length && !custom.length && <p>{c.none}</p>}
          </div>
        </div>
      </details>
    </div>
  );
}

export function EnabledCurrencies({
  value,
  defaultCurrency,
  onChange,
  disabled = false,
}: {
  value: readonly string[];
  defaultCurrency: string;
  onChange: (codes: string[]) => void;
  disabled?: boolean;
}) {
  const { lang } = useI18n();
  const c = copy[lang];
  const [query, setQuery] = useState("");
  const choices = searchCurrencies(query, lang).map((item) => item.code);
  const custom = value.filter(
    (code) =>
      !CURRENCIES.some((item) => item.code === code) &&
      code.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <fieldset className="workspace-enabled-currencies" disabled={disabled}>
      <legend>
        {c.enabled}{" "}
        <small>
          {value.length}/64 {c.selected}
        </small>
      </legend>
      <p>{c.hint}</p>
      <input
        type="search"
        aria-label={c.search}
        placeholder={c.search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="workspace-currency-list">
        {[...choices, ...custom].map((code) => (
          <label key={code}>
            <input
              type="checkbox"
              checked={value.includes(code)}
              disabled={
                disabled ||
                code === defaultCurrency ||
                (!value.includes(code) && value.length >= 64)
              }
              onChange={(event) =>
                onChange(
                  event.target.checked ? [...value, code] : value.filter((item) => item !== code),
                )
              }
            />
            <bdi>{code}</bdi>
            <span>{getCurrencyNameForLocale(code, lang)}</span>
          </label>
        ))}
        {!choices.length && !custom.length && <p>{c.none}</p>}
      </div>
    </fieldset>
  );
}

export function CurrencySettings({
  ledger,
  onClose,
  onSaved,
}: {
  ledger: WebLedger;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { lang } = useI18n();
  const c = copy[lang];
  const [defaultCurrency, setDefaultCurrency] = useState(ledger.default_entry_currency);
  const [baseline, setBaseline] = useState(ledger);
  const [stale, setStale] = useState(false);
  const [enabled, setEnabled] = useState([...ledger.enabled_currencies]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="workspace-dialog"
      aria-labelledby="currency-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await updateWebCurrencies(baseline, {
              default_entry_currency: defaultCurrency,
              enabled_currencies: enabled,
            });
            await onSaved();
          } catch (reason) {
            const changed = reason instanceof WebLedgerError && reason.code === "stale_currencies";
            setStale(changed);
            setError(changed ? c.stale : c.error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="workspace-dialog-heading">
          <h2 id="currency-settings-title">{c.title}</h2>
          <button
            type="button"
            className="workspace-icon-button"
            aria-label={c.close}
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <fieldset disabled={busy}>
          <CurrencyPicker
            label={c.default}
            value={defaultCurrency}
            disabled={busy}
            onChange={(code) => {
              if (!enabled.includes(code) && enabled.length >= 64) {
                setError(c.limit);
                return;
              }
              setDefaultCurrency(code);
              setEnabled((current) => (current.includes(code) ? current : [...current, code]));
              setError("");
            }}
          />
          <EnabledCurrencies
            value={enabled}
            defaultCurrency={defaultCurrency}
            onChange={setEnabled}
            disabled={busy}
          />
        </fieldset>
        {error && (
          <p role="alert" className="workspace-form-error">
            {error}
          </p>
        )}
        {stale && (
          <button
            type="button"
            className="workspace-inline-link"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const fresh = await getWebLedger(ledger.vault_id);
                setBaseline(fresh);
                setDefaultCurrency(fresh.default_entry_currency);
                setEnabled([...fresh.enabled_currencies]);
                setStale(false);
                setError("");
              } catch {
                setError(c.error);
              } finally {
                setBusy(false);
              }
            }}
          >
            {c.reload}
          </button>
        )}
        <div className="workspace-dialog-footer">
          <button type="button" className="workspace-button" disabled={busy} onClick={onClose}>
            {c.cancel}
          </button>
          <button type="submit" className="workspace-button primary" disabled={busy || stale}>
            {busy ? c.saving : c.save}
          </button>
        </div>
      </form>
    </dialog>
  );
}
