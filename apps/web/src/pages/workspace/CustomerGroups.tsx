import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SelectField } from "../../components/ui/select-field";
import { useI18n } from "../../lib/i18n";
import {
  archiveWebCustomerGroup,
  saveWebCustomerGroup,
  updateWebPersonGroups,
  WebLedgerError,
  type WebCustomerGroup,
  type WebLedger,
  type WebPerson,
} from "../../lib/web-ledger";
import { openWebRouteDialog } from "../../lib/web-route-dialog";

export const customerGroupCopy = {
  en: {
    title: "Customer groups",
    manage: "Manage groups",
    all: "All groups",
    ungrouped: "Ungrouped",
    add: "New group",
    name: "Group name",
    assign: "Edit groups",
    choose: "Choose a group",
    remove: "Remove group",
    removeHelp:
      "The group will be removed from customer lists. The customers and their tallies will stay in this kaata.",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    close: "Close",
    empty: "Create a group before assigning customers.",
    changed: "Groups changed while you were editing. Reopen this window and try again.",
    duplicate: "There is already a group with this name.",
    invalid: "Enter a group name of up to 40 characters.",
    failed: "Couldn’t save the groups. Try again.",
    sort: "Sort people",
    recent: "Recent activity",
    name_asc: "Name (A to Z)",
    name_desc: "Name (Z to A)",
    oldest: "Oldest activity",
    archived: "Removed people",
    active: "Active people",
    emptyArchived: "No removed people.",
  },
  fa: {
    title: "گروه‌های مشتریان",
    manage: "مدیریت گروه‌ها",
    all: "همۀ گروه‌ها",
    ungrouped: "بدون گروه",
    add: "گروه جدید",
    name: "نام گروه",
    assign: "ویرایش گروه‌ها",
    choose: "انتخاب گروه",
    remove: "حذف گروه",
    removeHelp: "گروه از فهرست مشتریان حذف می‌شود. مشتریان و ثبت‌های آن‌ها در این کاتا می‌مانند.",
    save: "ذخیره",
    saving: "در حال ذخیره…",
    cancel: "انصراف",
    close: "بستن",
    empty: "پیش از تعیین گروه مشتریان، یک گروه بسازید.",
    changed: "گروه‌ها هنگام ویرایش تغییر کردند. این پنجره را دوباره باز کنید و کوشش کنید.",
    duplicate: "گروهی با این نام وجود دارد.",
    invalid: "نام گروه را تا ۴۰ نویسه بنویسید.",
    failed: "گروه‌ها ذخیره نشدند. دوباره کوشش کنید.",
    sort: "مرتب‌سازی اشخاص",
    recent: "فعالیت اخیر",
    name_asc: "نام (الف تا ی)",
    name_desc: "نام (ی تا الف)",
    oldest: "قدیمی‌ترین فعالیت",
    archived: "اشخاص حذف‌شده",
    active: "اشخاص فعال",
    emptyArchived: "شخص حذف‌شده‌ای وجود ندارد.",
  },
  ps: {
    title: "د پېرودونکو ډلې",
    manage: "ډلې سمبال کړئ",
    all: "ټولې ډلې",
    ungrouped: "بې ډلې",
    add: "نوې ډله",
    name: "د ډلې نوم",
    assign: "ډلې سمې کړئ",
    choose: "ډله وټاکئ",
    remove: "ډله لرې کړئ",
    removeHelp:
      "ډله د پېرودونکو له لېستونو لرې کېږي. پېرودونکي او د هغوی ثبتونه په دې کاتا کې پاتې کېږي.",
    save: "خوندي کړئ",
    saving: "خوندي کېږي…",
    cancel: "لغوه",
    close: "بند کړئ",
    empty: "پېرودونکو ته له ډلې ټاکلو مخکې یوه ډله جوړه کړئ.",
    changed: "ډلې د سمون پر مهال بدلې شوې. دا کړکۍ بیا پرانیزئ او بیا هڅه وکړئ.",
    duplicate: "په دې نوم یوه ډله شته.",
    invalid: "د ډلې تر ۴۰ تورو پورې نوم ولیکئ.",
    failed: "ډلې خوندي نه شوې. بیا هڅه وکړئ.",
    sort: "کسان په ترتیب کړئ",
    recent: "وروستی فعالیت",
    name_asc: "نوم (الف تر ی)",
    name_desc: "نوم (ی تر الف)",
    oldest: "تر ټولو پخوانی فعالیت",
    archived: "لرې شوي کسان",
    active: "فعال کسان",
    emptyArchived: "لرې شوي کسان نشته.",
  },
};

export function CustomerGroupsDialog({
  ledger,
  person,
  canChange,
  onClose,
  onChanged,
  onWriteSettled,
}: {
  ledger: WebLedger;
  person?: WebPerson;
  canChange: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onWriteSettled: () => void;
}) {
  const { lang } = useI18n();
  const c = customerGroupCopy[lang];
  const titleID = useId();
  const groupID = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const initialPerson = useRef(person);
  const working = useRef(false);
  const [original, setOriginal] = useState<WebCustomerGroup | null>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState(person?.group_ids ?? []);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const groups = ledger.customer_groups ?? [];

  useEffect(() => {
    if (dialog.current) return openWebRouteDialog(dialog.current);
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (working.current || !canChange) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      if (initialPerson.current)
        await updateWebPersonGroups(ledger, initialPerson.current, selected);
      else if (confirmRemove && original) await archiveWebCustomerGroup(ledger, original);
      else await saveWebCustomerGroup(ledger, original, name);
      await onChanged();
    } catch (cause) {
      const code = cause instanceof WebLedgerError ? cause.code : "";
      setError(
        code === "group_changed"
          ? c.changed
          : code === "duplicate_group_name"
            ? c.duplicate
            : code === "invalid_group_name"
              ? c.invalid
              : c.failed,
      );
      return;
    } finally {
      working.current = false;
      setBusy(false);
      onWriteSettled();
    }
    onClose();
  }

  return (
    <dialog
      ref={dialog}
      className="workspace-dialog"
      aria-labelledby={titleID}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="workspace-dialog-heading">
        <h2 id={titleID}>{person ? c.assign : c.title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={c.close}
          disabled={busy}
          onClick={onClose}
        >
          ×
        </Button>
      </div>
      <form onSubmit={save} aria-busy={busy}>
        {person ? (
          <fieldset disabled={busy || !canChange} className="workspace-group-membership">
            <legend dir="auto">{person.name}</legend>
            {groups.length ? (
              groups.map((group) => (
                <label className="workspace-group-check" key={group.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(group.id)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, group.id]
                          : selected.filter((id) => id !== group.id),
                      )
                    }
                  />
                  <span dir="auto">{group.name}</span>
                </label>
              ))
            ) : (
              <p className="workspace-dialog-description">{c.empty}</p>
            )}
          </fieldset>
        ) : (
          <fieldset disabled={busy || !canChange}>
            <label htmlFor={groupID}>{c.choose}</label>
            <SelectField
              id={groupID}
              dir={lang === "en" ? "ltr" : "rtl"}
              value={original?.id ?? ""}
              disabled={busy || !canChange}
              options={[
                { value: "", label: c.add },
                ...groups.map((group) => ({ value: group.id, label: group.name })),
              ]}
              onValueChange={(id) => {
                const group = groups.find((row) => row.id === id) ?? null;
                setOriginal(group);
                setName(group?.name ?? "");
                setConfirmRemove(false);
                setError("");
              }}
            />
            {confirmRemove ? (
              <p className="workspace-dialog-description">{c.removeHelp}</p>
            ) : (
              <label>
                {c.name}
                <Input
                  dir="auto"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </label>
            )}
            {original && !confirmRemove && (
              <Button type="button" variant="outline" onClick={() => setConfirmRemove(true)}>
                {c.remove}
              </Button>
            )}
          </fieldset>
        )}
        {error && (
          <p role="alert" className="workspace-form-error">
            {error}
          </p>
        )}
        <div className="workspace-dialog-footer">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => (confirmRemove ? setConfirmRemove(false) : onClose())}
          >
            {c.cancel}
          </Button>
          <Button
            type="submit"
            variant={confirmRemove ? "destructive" : "brand"}
            disabled={
              busy || !canChange || (person ? !groups.length : !confirmRemove && !name.trim())
            }
          >
            {busy ? c.saving : confirmRemove ? c.remove : c.save}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
