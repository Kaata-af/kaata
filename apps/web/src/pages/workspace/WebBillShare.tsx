import { useEffect, useId, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useI18n } from "../../lib/i18n";
import type { MultiCurrencyBill } from "../../lib/shared-ledger";
import { getWebSession, type WebSession } from "../../lib/web-auth";
import {
  buildWebBill,
  canPreviewWebBill,
  createWebBillLink,
  WebBillError,
} from "../../lib/web-bill";
import type { WebLedger, WebPerson } from "../../lib/web-ledger";
import { openWebRouteDialog } from "../../lib/web-route-dialog";
import { Ledger } from "../CustomerView";
import "./WebBillShare.css";

const copy = {
  en: {
    bill: "Customer bill",
    title: "Review customer bill",
    print: "Print or save PDF",
    publish: "Create permanent link",
    publishing: "Creating link…",
    privacy:
      "Anyone with the link can see this bill, including the customer’s name, entries, and entry notes. The link is permanent and cannot be revoked.",
    disabled: "Bill links are turned off for this Kaata.",
    stale:
      "The bill changed while you were reviewing it. Close this preview and reopen it after the Kaata refreshes.",
    unavailable: "This bill is unavailable. Refresh the Kaata and try again.",
    invalid: "This bill is too large or contains an amount that cannot be shared accurately.",
    publish_failed: "The bill link could not be retrieved. Try again.",
    close: "Close",
    link: "Permanent bill link",
    copy: "Copy link",
    copied: "Link copied.",
    manual: "Select and copy the link.",
    open: "Open bill",
    whatsapp: "Share via WhatsApp",
  },
  fa: {
    bill: "بیل مشتری",
    title: "بررسی بیل مشتری",
    print: "چاپ یا ذخیره PDF",
    publish: "ساخت لینک دایمی",
    publishing: "در حال ساخت لینک…",
    privacy:
      "هر کسی که لینک را داشته باشد می‌تواند بیل، نام مشتری، ثبت‌ها و یادداشت‌های ثبت را ببیند. این لینک دایمی است و لغو نمی‌شود.",
    disabled: "لینک بیل برای این کاتا خاموش است.",
    stale:
      "بیل در جریان بررسی تغییر کرد. پیش‌نمایش را ببندید و پس از تازه‌سازی کاتا دوباره باز کنید.",
    unavailable: "این بیل در دسترس نیست. کاتا را تازه‌سازی کنید و دوباره کوشش کنید.",
    invalid: "این بیل بسیار بزرگ است یا مبلغی دارد که نمی‌توان آن را به‌صورت دقیق شریک ساخت.",
    publish_failed: "لینک بیل دریافت نشد. دوباره کوشش کنید.",
    close: "بستن",
    link: "لینک دایمی بیل",
    copy: "کاپی لینک",
    copied: "لینک کاپی شد.",
    manual: "لینک را انتخاب و کاپی کنید.",
    open: "باز کردن بیل",
    whatsapp: "ارسال در واتساپ",
  },
  ps: {
    bill: "د پېرودونکي بل",
    title: "د پېرودونکي بل وګورئ",
    print: "چاپ یا د PDF خوندي کول",
    publish: "دایمي لینک جوړ کړئ",
    publishing: "لینک جوړېږي…",
    privacy:
      "هر څوک چې لینک ولري، بل، د پېرودونکي نوم، ثبتونه او د ثبت یادښتونه لیدلی شي. لینک دایمي دی او لغوه کېدای نشي.",
    disabled: "د دې کاټا د بل لینکونه بند دي.",
    stale: "بل د کتنې پر مهال بدل شو. مخکتنه وتړئ او د کاټا تر تازه کېدو وروسته یې بیا پرانیزئ.",
    unavailable: "دا بل نشته. کاټا تازه کړئ او بیا هڅه وکړئ.",
    invalid: "دا بل ډېر لوی دی یا داسې اندازه لري چې په کره توګه نشي شریکېدای.",
    publish_failed: "د بل لینک ترلاسه نشو. بیا هڅه وکړئ.",
    close: "تړل",
    link: "د بل دایمي لینک",
    copy: "لینک کاپي کړئ",
    copied: "لینک کاپي شو.",
    manual: "لینک وټاکئ او کاپي یې کړئ.",
    open: "بل پرانیزئ",
    whatsapp: "په واټساپ کې شریک کړئ",
  },
};

type BillShareProps = { ledger: WebLedger; person: WebPerson; online: boolean };

export function WebBillShare(props: BillShareProps) {
  const { ledger, person } = props;
  if (!canPreviewWebBill(person)) return null;
  return <BillShareControl key={`${ledger.vault_id}:${person.relationship_id}`} {...props} />;
}

function BillShareControl({ ledger, person, online }: BillShareProps) {
  const { lang } = useI18n();
  const c = copy[lang];
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const [review, setReview] = useState<{ bill: MultiCurrencyBill; session: WebSession } | null>(
    null,
  );
  const [printing, setPrinting] = useState(false);
  const [link, setLink] = useState("");
  const [copyStatus, setCopyStatus] = useState<"copied" | "manual" | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WebBillError["code"] | null>(null);
  const open = review !== null || error !== null;
  const linksEnabled = ledger.bill_links_enabled === true;

  useEffect(() => {
    if (open && dialog.current) return openWebRouteDialog(dialog.current);
  }, [open]);
  useEffect(() => {
    const afterPrint = () => setPrinting(false);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      window.removeEventListener("afterprint", afterPrint);
      const controller = active.current;
      active.current = null;
      controller?.abort();
    };
  }, []);

  function showReview() {
    const session = getWebSession();
    if (!online || !session) return;
    try {
      setReview({ bill: buildWebBill(ledger, person.relationship_id, lang), session });
    } catch (cause) {
      setError(cause instanceof WebBillError ? cause.code : "invalid");
    }
  }

  function close() {
    if (active.current) return;
    dialog.current?.close();
    setReview(null);
    setPrinting(false);
    setLink("");
    setError(null);
    setCopyStatus("");
  }

  async function publish() {
    if (!review || !online || active.current || link || error || !linksEnabled) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    const timer = window.setTimeout(() => controller.abort(), 25_000);
    try {
      const created = await createWebBillLink(
        review.session,
        ledger.vault_id,
        person.relationship_id,
        lang,
        review.bill,
        controller.signal,
      );
      if (active.current === controller) setLink(created);
    } catch (cause) {
      if (active.current === controller)
        setError(cause instanceof WebBillError ? cause.code : "publish_failed");
    } finally {
      window.clearTimeout(timer);
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopyStatus("copied");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setCopyStatus("manual");
    }
  }

  return (
    <>
      <button type="button" className="workspace-button" disabled={!online} onClick={showReview}>
        {c.bill}
      </button>
      {open ? (
        <dialog
          ref={dialog}
          className="workspace-dialog workspace-bill-dialog"
          aria-labelledby={heading}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <div className="workspace-dialog-heading">
            <h2 id={heading}>{c.title}</h2>
            <button
              type="button"
              className="workspace-icon-button"
              aria-label={c.close}
              disabled={busy}
              onClick={close}
            >
              ×
            </button>
          </div>
          {review ? (
            <>
              <div className="workspace-bill-paper" role="region" aria-label={c.bill} tabIndex={0}>
                <Ledger data={review.bill} />
              </div>
              {link ? (
                <div className="workspace-bill-link">
                  <label>
                    {c.link}
                    <input ref={linkInput} value={link} readOnly dir="ltr" />
                  </label>
                  <div className="workspace-bill-actions">
                    <button
                      type="button"
                      className="workspace-button primary"
                      onClick={() => void copyLink()}
                    >
                      {c.copy}
                    </button>
                    <a className="workspace-button" href={link} target="_blank" rel="noreferrer">
                      {c.open}
                    </a>
                    <a
                      className="workspace-button"
                      href={`https://wa.me/?text=${encodeURIComponent(link)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {c.whatsapp}
                    </a>
                  </div>
                  <p role="status">{copyStatus ? c[copyStatus] : null}</p>
                </div>
              ) : (
                <p className="workspace-dialog-description">
                  {linksEnabled ? c.privacy : c.disabled}
                </p>
              )}
            </>
          ) : null}
          {error ? (
            <p role="alert" className="workspace-form-error">
              {c[error]}
            </p>
          ) : null}
          {review ? (
            <div className="workspace-dialog-footer">
              <button
                type="button"
                className="workspace-button"
                disabled={busy}
                onClick={() => {
                  flushSync(() => setPrinting(true));
                  window.print();
                }}
              >
                {c.print}
              </button>
              {!link && linksEnabled ? (
                <button
                  type="button"
                  className="workspace-button primary"
                  disabled={busy || !online || error !== null}
                  onClick={() => void publish()}
                >
                  {busy ? c.publishing : c.publish}
                </button>
              ) : null}
            </div>
          ) : null}
        </dialog>
      ) : null}
      {printing && review
        ? createPortal(
            <div className="workspace-bill-print">
              <Ledger data={review.bill} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
