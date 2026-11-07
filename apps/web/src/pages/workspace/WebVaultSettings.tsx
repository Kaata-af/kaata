import { useEffect, useId, useRef, useState } from "react";
import { openWebRouteDialog } from "../../lib/web-route-dialog";
import { useI18n } from "../../lib/i18n";
import { WebApiError } from "../../lib/web-auth";
import {
  canReadWebVaultAudit,
  canRenameWebVault,
  getWebVaultAudit,
  type WebVaultSettingsBook,
} from "../../lib/web-vault-settings";

const copy = {
  en: {
    title: "Kaata settings",
    name: "Kaata name",
    yourRole: "Your role",
    members: "Members",
    noMembers: "Member details are unavailable.",
    unnamed: "Kaata member",
    roles: {
      owner: "Owner",
      manager: "Manager",
      editor: "Editor",
      clerk: "Clerk",
      viewer: "Viewer",
    },
    save: "Save name",
    saving: "Saving…",
    saved: "Name saved.",
    stale: "The name changed on another device. Load the latest name before saving.",
    reload: "Load latest name",
    renameError: "The name could not be saved. Try again.",
    close: "Close",
    activity: "Team activity",
    hideActivity: "Hide team activity",
    scopedActivity: "Shows activity involving your account.",
    emptyActivity: "No activity to show.",
    loading: "Loading activity…",
    older: "Load older activity",
    activityError: "Activity could not be loaded.",
    activityUnavailable: "Activity is unavailable for this kaata.",
    offline: "Connect to the internet to load activity.",
    retry: "Try again",
    otherActivity: "Kaata activity",
    actions: {
      vault_settings_updated: "Settings changed",
      vault_archived: "Kaata archived",
      vault_unarchived: "Kaata restored",
      role_changed: "Role changed",
      invite_issued: "Invitation sent",
      invite_accepted: "Invitation accepted",
      invite_declined: "Invitation declined",
      member_revoked: "Member removed",
      member_left: "Member left",
      transfer_completed: "Ownership transferred",
      ownership_transferred: "Ownership transferred",
      credit_permission_changed: "Credit permission changed",
    },
  },
  fa: {
    title: "تنظیمات کاتا",
    name: "نام کاتا",
    yourRole: "نقش شما",
    members: "اعضا",
    noMembers: "جزئیات اعضا در دسترس نیست.",
    unnamed: "عضو کاتا",
    roles: {
      owner: "مالک",
      manager: "مدیر",
      editor: "ویرایشگر",
      clerk: "ثبت‌کننده",
      viewer: "بیننده",
    },
    save: "ذخیره نام",
    saving: "در حال ذخیره…",
    saved: "نام ذخیره شد.",
    stale: "نام در دستگاه دیگری تغییر کرده است. پیش از ذخیره، نام تازه را بار کنید.",
    reload: "بارگذاری نام تازه",
    renameError: "نام ذخیره نشد. دوباره کوشش کنید.",
    close: "بستن",
    activity: "فعالیت اعضا",
    hideActivity: "پنهان کردن فعالیت اعضا",
    scopedActivity: "فعالیت‌های مربوط به حساب شما را نشان می‌دهد.",
    emptyActivity: "فعالیتی برای نمایش وجود ندارد.",
    loading: "در حال بارگذاری فعالیت…",
    older: "بارگذاری فعالیت‌های قبلی",
    activityError: "فعالیت بارگذاری نشد.",
    activityUnavailable: "فعالیت این کاتا در دسترس نیست.",
    offline: "برای بارگذاری فعالیت به اینترنت وصل شوید.",
    retry: "دوباره کوشش کنید",
    otherActivity: "فعالیت کاتا",
    actions: {
      vault_settings_updated: "تنظیمات تغییر کرد",
      vault_archived: "کاتا بایگانی شد",
      vault_unarchived: "کاتا از بایگانی خارج شد",
      role_changed: "نقش تغییر کرد",
      invite_issued: "دعوت ارسال شد",
      invite_accepted: "دعوت پذیرفته شد",
      invite_declined: "دعوت رد شد",
      member_revoked: "عضو حذف شد",
      member_left: "عضو خارج شد",
      transfer_completed: "مالکیت منتقل شد",
      ownership_transferred: "مالکیت منتقل شد",
      credit_permission_changed: "اجازهٔ نسیه تغییر کرد",
    },
  },
  ps: {
    title: "د کاټې تنظیمات",
    name: "د کاټې نوم",
    yourRole: "ستاسو رول",
    members: "غړي",
    noMembers: "د غړو معلومات نشته.",
    unnamed: "د کاټې غړی",
    roles: {
      owner: "مالک",
      manager: "مدیر",
      editor: "سموونکی",
      clerk: "ثبتوونکی",
      viewer: "کتونکی",
    },
    save: "نوم خوندي کړئ",
    saving: "خوندي کېږي…",
    saved: "نوم خوندي شو.",
    stale: "نوم په بله وسیله بدل شوی. له خوندي کولو مخکې نوی نوم راواخلئ.",
    reload: "نوی نوم راواخلئ",
    renameError: "نوم خوندي نه شو. بیا هڅه وکړئ.",
    close: "تړل",
    activity: "د غړو فعالیت",
    hideActivity: "د غړو فعالیت پټ کړئ",
    scopedActivity: "ستاسو له حساب سره اړوند فعالیتونه ښکاره کوي.",
    emptyActivity: "د ښودلو لپاره فعالیت نشته.",
    loading: "فعالیت رااخیستل کېږي…",
    older: "پخوانی فعالیت راواخلئ",
    activityError: "فعالیت راوانه اخیستل شو.",
    activityUnavailable: "د دې کاټې فعالیت نشته.",
    offline: "د فعالیت لیدلو لپاره له انټرنېټ سره وصل شئ.",
    retry: "بیا هڅه وکړئ",
    otherActivity: "د کاټې فعالیت",
    actions: {
      vault_settings_updated: "تنظیمات بدل شول",
      vault_archived: "کاټه ارشیف شوه",
      vault_unarchived: "کاټه بېرته راوګرځول شوه",
      role_changed: "رول بدل شو",
      invite_issued: "بلنه ولېږل شوه",
      invite_accepted: "بلنه ومنل شوه",
      invite_declined: "بلنه رد شوه",
      member_revoked: "غړی لرې شو",
      member_left: "غړی ووت",
      transfer_completed: "مالکیت ولېږدول شو",
      ownership_transferred: "مالکیت ولېږدول شو",
      credit_permission_changed: "د پور اجازه بدله شوه",
    },
  },
};

export function WebVaultSettings({
  vault,
  online,
  onClose,
  onRename,
}: {
  vault: WebVaultSettingsBook;
  online: boolean;
  onClose: () => void;
  onRename: (name: string, expectedName: string) => Promise<void>;
}) {
  const { lang } = useI18n();
  const c = copy[lang];
  const title = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [draft, setDraft] = useState<{ base: string; name: string } | null>(null);
  const [notice, setNotice] = useState<"saved" | "stale" | "renameError" | null>(null);
  const [busy, setBusy] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const canRename = canRenameWebVault(vault);
  const canReadAudit = canReadWebVaultAudit(vault.role);
  const stale = notice === "stale" || (draft !== null && draft.base !== vault.name);
  const name = draft?.name.trim() ?? vault.name;
  const canSave = canRename && online && !busy && !stale && !!name && name !== vault.name;
  const members = Array.isArray(vault.members) ? vault.members : [];

  useEffect(() => {
    if (dialog.current) return openWebRouteDialog(dialog.current);
  }, []);

  return (
    <dialog
      ref={dialog}
      className="workspace-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting.current) onClose();
      }}
    >
      <div className="workspace-dialog-heading">
        <h2 id={title}>{c.title}</h2>
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
      {canRename ? (
        <form
          className="grid gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!canSave || !draft || submitting.current) return;
            submitting.current = true;
            setBusy(true);
            setNotice(null);
            try {
              await onRename(name, draft.base);
              setDraft(null);
              setNotice("saved");
            } catch (error) {
              setNotice(
                error instanceof Error && "code" in error && error.code === "vault_name_changed"
                  ? "stale"
                  : "renameError",
              );
            } finally {
              submitting.current = false;
              setBusy(false);
            }
          }}
        >
          <label>
            {c.name}
            <input
              value={draft?.name ?? vault.name}
              disabled={busy || !online}
              dir="auto"
              required
              maxLength={120}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setDraft((current) => ({ base: current?.base ?? vault.name, name: next }));
                if (notice !== "stale") setNotice(null);
              }}
            />
          </label>
          {stale ? (
            <>
              <p role="alert" className="workspace-form-error">
                {c.stale}
              </p>
              <button
                type="button"
                className="workspace-inline-link justify-self-start"
                onClick={() => {
                  setDraft(null);
                  setNotice(null);
                }}
              >
                {c.reload}
              </button>
            </>
          ) : (
            <>
              {notice === "renameError" && (
                <p role="alert" className="workspace-form-error">
                  {c.renameError}
                </p>
              )}
              {notice === "saved" && (
                <p role="status" className="workspace-dialog-description">
                  {c.saved}
                </p>
              )}
              <button
                type="submit"
                className="workspace-button primary justify-self-end"
                disabled={!canSave}
              >
                {busy ? c.saving : c.save}
              </button>
            </>
          )}
        </form>
      ) : (
        <p className="break-words font-medium">
          <bdi>{vault.name}</bdi>
        </p>
      )}
      <section className="mt-5 border-t border-neutral-200 pt-4" aria-label={c.members}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {c.members}{" "}
            <span className="font-normal text-neutral-500">
              {new Intl.NumberFormat(lang).format(vault.members_count)}
            </span>
          </h3>
          <span className="workspace-dialog-description">
            {c.yourRole} · {c.roles[vault.role]}
          </span>
        </div>
        {members.length ? (
          <ul className="mt-2 divide-y divide-neutral-200">
            {members.map((member) => (
              <li
                key={member.account_id}
                className="flex items-start justify-between gap-3 py-2.5 text-sm"
              >
                <div className="min-w-0 break-words">
                  <bdi className="font-medium">{member.name?.trim() || c.unnamed}</bdi>
                  {member.email && (
                    <div className="text-xs text-neutral-500">
                      <bdi dir="ltr">{member.email}</bdi>
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-xs text-neutral-600">{c.roles[member.role]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="workspace-dialog-description mt-2">{c.noMembers}</p>
        )}
      </section>
      {canReadAudit && (
        <section className="mt-4 border-t border-neutral-200 pt-4" aria-label={c.activity}>
          <button
            type="button"
            className="workspace-inline-link"
            aria-expanded={auditOpen}
            onClick={() => setAuditOpen((open) => !open)}
          >
            {auditOpen ? c.hideActivity : c.activity}
          </button>
          {auditOpen && (
            <VaultAudit
              key={`${vault.vault_id}:${vault.role}:${vault.name}`}
              vault={vault}
              online={online}
            />
          )}
        </section>
      )}
    </dialog>
  );
}

function VaultAudit({ vault, online }: { vault: WebVaultSettingsBook; online: boolean }) {
  const { lang } = useI18n();
  const c = copy[lang];
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof getWebVaultAudit>>["entries"]>(
    [],
  );
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [request, setRequest] = useState<{ cursor: number | null } | null>({ cursor: null });
  const [failure, setFailure] = useState<{ cursor: number | null; denied: boolean } | null>(null);

  useEffect(() => {
    if (!online || !request) return;
    const controller = new AbortController();
    void getWebVaultAudit(vault.vault_id, request.cursor, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setEntries((previous) =>
          request.cursor === null ? page.entries : [...previous, ...page.entries],
        );
        setNextCursor(page.has_more ? page.next_since_id : null);
        setFailure(null);
        setRequest(null);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const denied = error instanceof WebApiError && [401, 403, 404, 410].includes(error.status);
        if (denied) {
          setEntries([]);
          setNextCursor(null);
        }
        setFailure({ cursor: request.cursor, denied });
        setRequest(null);
      },
    );
    return () => controller.abort();
  }, [online, request, vault.vault_id]);

  const dates = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="mt-2">
      {vault.role !== "owner" && <p className="workspace-dialog-description">{c.scopedActivity}</p>}
      {!!entries.length && (
        <ol className="divide-y divide-neutral-200">
          {entries.map((entry) => {
            const actor = Array.isArray(vault.members)
              ? vault.members.find((member) => member.account_id === entry.actor_id)?.name
              : undefined;
            const action = Object.hasOwn(c.actions, entry.kind)
              ? c.actions[entry.kind as keyof typeof c.actions]
              : c.otherActivity;
            return (
              <li key={entry.id} className="py-2 text-sm">
                <p>{action}</p>
                <p className="workspace-dialog-description">
                  {actor && (
                    <>
                      <bdi>{actor}</bdi> ·{" "}
                    </>
                  )}
                  <time dateTime={new Date(entry.occurred_at_ms).toISOString()}>
                    {dates.format(entry.occurred_at_ms)}
                  </time>
                </p>
              </li>
            );
          })}
        </ol>
      )}
      {request && (
        <p role="status" className="workspace-dialog-description">
          {online ? c.loading : c.offline}
        </p>
      )}
      {failure && (
        <div className="grid gap-2">
          <p role="alert" className="workspace-dialog-description">
            {failure.denied ? c.activityUnavailable : c.activityError}
          </p>
          {!failure.denied && (
            <button
              type="button"
              className="workspace-inline-link justify-self-start"
              disabled={!online}
              onClick={() => {
                setRequest({ cursor: failure.cursor });
                setFailure(null);
              }}
            >
              {c.retry}
            </button>
          )}
        </div>
      )}
      {!request && !failure && !entries.length && (
        <p className="workspace-dialog-description">{c.emptyActivity}</p>
      )}
      {!request && !failure && nextCursor !== null && (
        <button
          type="button"
          className="workspace-inline-link mt-2"
          disabled={!online}
          onClick={() => setRequest({ cursor: nextCursor })}
        >
          {c.older}
        </button>
      )}
    </div>
  );
}
