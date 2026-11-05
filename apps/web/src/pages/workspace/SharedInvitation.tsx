import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SelectField } from "../../components/ui/select-field";
import { useI18n } from "../../lib/i18n";
import { getWebSession, isSameWebSession, WebApiError } from "../../lib/web-auth";
import { createWebPerson, getWebLedger, type WebLedger } from "../../lib/web-ledger";
import {
  clearSharedInvitation,
  pendingSharedInvitation,
  sharedInvitationToken,
} from "../../lib/web-shared-invite";
import { openWebRouteDialog } from "../../lib/web-route-dialog";
import {
  findWebSharedInvitationContact,
  joinWebSharedInvitation,
  previewWebSharedInvitation,
  type WebSharedInvitation,
} from "../../lib/web-tabs";
import "./SharedInvitation.css";

const copy = {
  en: {
    title: "Join a shared account",
    link: "Invitation link",
    preview: "Review invitation",
    loading: "Opening invitation…",
    invalid: "Paste a Kaata shared-account invitation link.",
    failed: "This invitation could not be opened. Check the link and try again.",
    contact: "Person in this kaata",
    newPerson: "Add a new person",
    name: "Person’s name",
    join: "Join shared account",
    joining: "Joining…",
    cancel: "Cancel",
    close: "Close invitation",
    error: "We couldn’t join this account. Refresh your kaata and try again.",
    ownName: "Your name in the shared account",
    review: "Both people can propose tallies. The other person reviews each proposal.",
    notify: "Both people can record tallies without individual approval.",
    oneWay: "The person who sent this link records tallies. You can view the shared account.",
    from: "Invitation from",
    offline: "Reconnect to review or join this invitation.",
    permission: "Choose an active kaata you own or manage to join this invitation.",
    created:
      "This person has been added to your kaata. If joining fails, retry here or choose the same person when you open the invitation again.",
    balance:
      "This review account needs a person with a zero balance in its currencies. Choose a new person to keep your existing history intact.",
  },
  fa: {
    title: "پیوستن به حساب مشترک",
    link: "لینک دعوت",
    preview: "دیدن دعوت",
    loading: "دعوت باز می‌شود…",
    invalid: "لینک دعوت حساب مشترک کاتا را بنویسید.",
    failed: "دعوت باز نشد. لینک را بررسی کنید و دوباره کوشش کنید.",
    contact: "شخص در این کاتا",
    newPerson: "افزودن شخص جدید",
    name: "نام شخص",
    join: "پیوستن به حساب مشترک",
    joining: "در حال پیوستن…",
    cancel: "انصراف",
    close: "بستن دعوت",
    error: "به حساب پیوسته نتوانستیم. کاتا را تازه کنید و دوباره کوشش کنید.",
    ownName: "نام شما در حساب مشترک",
    review: "هر دو شخص می‌توانند ثبت پیشنهاد کنند. شخص مقابل هر پیشنهاد را بررسی می‌کند.",
    notify: "هر دو شخص می‌توانند بدون تأیید جداگانه ثبت کنند.",
    oneWay: "فرستندۀ لینک ثبت می‌کند. شما حساب مشترک را دیده می‌توانید.",
    from: "دعوت از",
    offline: "برای دیدن دعوت و پیوستن به انترنت وصل شوید.",
    permission: "برای پیوستن، یک کاتای فعال را که مالک یا مدیر آن هستید انتخاب کنید.",
    created:
      "این شخص به کاتای شما اضافه شد. اگر پیوستن ناکام شد، اینجا دوباره کوشش کنید یا هنگام باز کردن دوبارۀ دعوت، همین شخص را انتخاب کنید.",
    balance:
      "برای این حساب با تأیید، شخصی با موجودی صفر در ارزهای حساب انتخاب کنید. برای حفظ تاریخچۀ موجود، شخص جدید بسازید.",
  },
  ps: {
    title: "له ګډ حساب سره یوځای شئ",
    link: "د بلنې لینک",
    preview: "بلنه وګورئ",
    loading: "بلنه پرانیستل کېږي…",
    invalid: "د کاتا د ګډ حساب د بلنې لینک ولیکئ.",
    failed: "بلنه پرانیستل نه شوه. لینک وګورئ او بیا هڅه وکړئ.",
    contact: "په دې کاتا کې کس",
    newPerson: "نوی کس زیات کړئ",
    name: "د کس نوم",
    join: "له ګډ حساب سره یوځای شئ",
    joining: "یوځای کېږي…",
    cancel: "لغوه",
    close: "بلنه بنده کړئ",
    error: "له حساب سره یوځای نه شو. کاتا تازه کړئ او بیا هڅه وکړئ.",
    ownName: "په ګډ حساب کې ستاسو نوم",
    review: "دواړه کسان ثبتونه وړاندیزولی شي. مقابل کس هر وړاندیز ګوري.",
    notify: "دواړه کسان له جلا تایید پرته ثبتونه لیکلی شي.",
    oneWay: "د لینک لېږونکی ثبتونه لیکي. تاسو ګډ حساب لیدلی شئ.",
    from: "بلنه له",
    offline: "د بلنې د کتلو او یوځای کېدو لپاره انټرنېټ سره وصل شئ.",
    permission: "د یوځای کېدو لپاره فعاله کاتا وټاکئ چې مالک یا مدیر یې یاست.",
    created:
      "دا کس ستاسو کاتا ته زیات شو. که یوځای کېدل ناکام شي، دلته بیا هڅه وکړئ یا د بلنې د بیا پرانیستلو پر مهال همدا کس وټاکئ.",
    balance:
      "دا تاییدي حساب په خپلو اسعارو کې د صفر بیلانس لرونکي کس ته اړتیا لري. د پخوانۍ تاریخچې د ساتلو لپاره نوی کس وټاکئ.",
  },
};
export function sharedInvitationTitle(lang: "en" | "fa" | "ps") {
  return copy[lang].title;
}

export function SharedInvitation({
  ledger,
  online,
  onClose,
  onJoined,
}: {
  ledger: WebLedger;
  online: boolean;
  onClose: () => void;
  onJoined: (relationshipID: string) => Promise<void>;
}) {
  const { lang } = useI18n();
  const c = copy[lang];
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const session = useRef(getWebSession());
  const [link, setLink] = useState(() => pendingSharedInvitation() ?? "");
  const [invitation, setInvitation] = useState<WebSharedInvitation | null>(null);
  const [token, setToken] = useState("");
  const [target, setTarget] = useState("new");
  const [name, setName] = useState("");
  const [label, setLabel] = useState(() => getWebSession()?.user.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const created = useRef<string | null>(null);
  const canManage = !ledger.archived_at_ms && ["owner", "manager"].includes(ledger.role);
  useEffect(() => {
    const restore = dialog.current ? openWebRouteDialog(dialog.current) : undefined;
    return () => {
      request.current?.abort();
      restore?.();
    };
  }, []);

  async function preview() {
    if (busy || !online) return;
    const value = sharedInvitationToken(link);
    if (!value) {
      setError(c.invalid);
      return;
    }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = await previewWebSharedInvitation(value, controller.signal);
      if (controller.signal.aborted || !isSameWebSession(getWebSession(), session.current)) return;
      const meta = next.kind === "group" ? next.group : next.tab;
      const other = meta.parties[meta.you === "a" ? "b" : "a"];
      setName(other.label || other.account_name || "");
      setInvitation(next);
      setToken(value);
      const matched = findWebSharedInvitationContact(ledger, next);
      if (matched) setTarget(matched.relationship_id);
    } catch {
      if (!controller.signal.aborted) setError(c.failed);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function join() {
    if (!invitation || busy || !online || !canManage) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      let current = await getWebLedger(ledger.vault_id);
      controller.signal.throwIfAborted();
      if (!isSameWebSession(getWebSession(), session.current)) return;
      // Recover a completed join whose reply was lost before creating another
      // contact, including after reopening the invitation dialog.
      let relationshipID =
        findWebSharedInvitationContact(current, invitation)?.relationship_id ??
        (target === "new" ? created.current : target);
      if (!relationshipID) {
        relationshipID = await createWebPerson(current, { name });
        created.current = relationshipID;
        current = await getWebLedger(ledger.vault_id);
      }
      controller.signal.throwIfAborted();
      if (!isSameWebSession(getWebSession(), session.current)) return;
      const person = current.people.find((row) => row.relationship_id === relationshipID);
      if (!person) throw new Error("Person unavailable");
      await joinWebSharedInvitation(invitation, token, current, person, label, controller.signal);
      if (controller.signal.aborted || !isSameWebSession(getWebSession(), session.current)) return;
      clearSharedInvitation();
      await onJoined(relationshipID);
      onClose();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof WebApiError && cause.code === "shared_account_currency_history"
            ? c.balance
            : c.error,
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const meta = invitation
    ? invitation.kind === "group"
      ? invitation.group
      : invitation.tab
    : null;
  const other = meta?.parties[meta.you === "a" ? "b" : "a"];
  const eligible = ledger.people.filter(
    (person) =>
      person.archived_at == null &&
      (person === findWebSharedInvitationContact(ledger, invitation) ||
        !person.shared?.tabs.some((tab) => tab.closed_at_ms == null)),
  );
  return (
    <dialog
      ref={dialog}
      className="workspace-dialog shared-invitation-dialog"
      aria-label={c.title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="web-profile-heading">
        <h2>{c.title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy}
          aria-label={c.close}
          onClick={onClose}
        >
          ×
        </Button>
      </div>
      <form
        className="web-profile-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void (invitation ? join() : preview());
        }}
      >
        {!invitation ? (
          <>
            <label htmlFor={`${id}-link`}>{c.link}</label>
            <Input
              id={`${id}-link`}
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={link}
              disabled={busy}
              onChange={(event) => {
                setLink(event.target.value);
                setError("");
              }}
              required
            />
          </>
        ) : (
          <>
            <p className="shared-invitation-from">
              {c.from} <strong dir="auto">{other?.label || other?.account_name || "Kaata"}</strong>
            </p>
            <p>
              {meta?.recording_mode === "review"
                ? c.review
                : meta?.recording_mode === "notify_one_way"
                  ? c.oneWay
                  : c.notify}
            </p>
            <p dir="ltr">
              {invitation.kind === "group"
                ? invitation.group.currencies.join(" · ")
                : invitation.tab.currency}
            </p>
            <label htmlFor={`${id}-person`}>{c.contact}</label>
            <SelectField
              id={`${id}-person`}
              value={target}
              disabled={busy || !!created.current}
              onValueChange={setTarget}
              options={[
                { value: "new", label: c.newPerson },
                ...eligible.map((person) => ({
                  value: person.relationship_id,
                  label: person.name,
                })),
              ]}
            />
            {target === "new" && (
              <>
                <label htmlFor={`${id}-name`}>{c.name}</label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  dir="auto"
                  disabled={busy || !!created.current}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={1}
                  maxLength={120}
                />
              </>
            )}
            <label htmlFor={`${id}-label`}>{c.ownName}</label>
            <Input
              id={`${id}-label`}
              dir="auto"
              value={label}
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
              required
              maxLength={80}
            />
          </>
        )}
        <p>{ledger.name}</p>
        {created.current && <p role="status">{c.created}</p>}
        {!online && <p role="status">{c.offline}</p>}
        {!canManage && <p role="status">{c.permission}</p>}
        {error && (
          <p className="web-profile-error" role="alert">
            {error}
          </p>
        )}
        <div className="web-profile-actions">
          <Button
            type="submit"
            variant="brand"
            disabled={busy || !online || (!!invitation && !canManage)}
          >
            {busy ? (invitation ? c.joining : c.loading) : invitation ? c.join : c.preview}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {c.cancel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
