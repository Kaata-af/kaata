import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import {
  getWebPersonNoteHistory,
  updateWebPersonNote,
  WebLedgerError,
  type WebLedger,
  type WebPerson,
} from "../../lib/web-ledger";

const copies = {
  en: {
    title: "Customer note",
    private: "For your kaata team only",
    empty: "Add details you want to remember about this person.",
    edit: "Edit note",
    add: "Add note",
    history: "Edit history",
    unknown: "Unknown author",
    cleared: "Note cleared",
    save: "Save note",
    saving: "Saving…",
    cancel: "Cancel",
    more: "Load earlier notes",
    loading: "Loading…",
    noHistory: "No earlier edits available.",
    error: "The note could not be saved. Try again.",
    historyError: "Note history could not load.",
    changed: "This note changed on another device. Reload it before saving.",
    reload: "Use latest note",
    tooLong: "Keep the note within 2,000 characters.",
  },
  fa: {
    title: "یادداشت شخص",
    private: "فقط برای اعضای کاتای شما",
    empty: "جزئیاتی را که می‌خواهید دربارۀ این شخص به یاد داشته باشید، بنویسید.",
    edit: "ویرایش یادداشت",
    add: "افزودن یادداشت",
    history: "تاریخچۀ ویرایش",
    unknown: "نویسندۀ نامشخص",
    cleared: "یادداشت پاک شد",
    save: "ثبت یادداشت",
    saving: "در حال ثبت…",
    cancel: "لغو",
    more: "یادداشت‌های قبلی",
    loading: "در حال بارگذاری…",
    noHistory: "ویرایش قبلی در دسترس نیست.",
    error: "یادداشت ثبت نشد. دوباره کوشش کنید.",
    historyError: "تاریخچۀ یادداشت بارگذاری نشد.",
    changed: "این یادداشت در دستگاه دیگری تغییر کرده است. پیش از ثبت، آن را تازه کنید.",
    reload: "استفاده از یادداشت تازه",
    tooLong: "یادداشت باید حداکثر ۲٬۰۰۰ نویسه باشد.",
  },
  ps: {
    title: "د شخص یادښت",
    private: "یوازې ستاسو د کاتا د غړو لپاره",
    empty: "د دې شخص په اړه هغه معلومات ولیکئ چې غواړئ یاد مو وي.",
    edit: "یادښت سمول",
    add: "یادښت زیاتول",
    history: "د سمون تاریخچه",
    unknown: "نامعلوم لیکوال",
    cleared: "یادښت پاک شو",
    save: "یادښت ساتل",
    saving: "ساتل کېږي…",
    cancel: "لغوه",
    more: "پخواني یادښتونه",
    loading: "بارېږي…",
    noHistory: "پخوانی سمون نشته.",
    error: "یادښت خوندي نه شو. بیا هڅه وکړئ.",
    historyError: "د یادښت تاریخچه بار نه شوه.",
    changed: "دا یادښت په بله وسیله بدل شوی. له ساتلو مخکې یې تازه کړئ.",
    reload: "تازه یادښت وکاروئ",
    tooLong: "یادښت باید تر ۲٬۰۰۰ تورو پورې وي.",
  },
};
type History = Awaited<ReturnType<typeof getWebPersonNoteHistory>>;

export function PersonNotePanel({
  ledger,
  person,
  canEdit,
  onSaved,
  onWriteSettled,
}: {
  ledger: WebLedger;
  person: WebPerson;
  canEdit: boolean;
  onSaved: () => Promise<void>;
  onWriteSettled: () => void;
}) {
  const { lang } = useI18n();
  const c = copies[lang];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [original, setOriginal] = useState(person);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<History | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const generation = useRef(0);
  const loadingRef = useRef(false);
  const revision = JSON.stringify([
    person.note ?? null,
    person.note_hlc ?? null,
    person.note_event_id ?? null,
  ]);
  const originalRevision = JSON.stringify([
    original.note ?? null,
    original.note_hlc ?? null,
    original.note_event_id ?? null,
  ]);
  const changed = revision !== originalRevision;
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    generation.current++;
    loadingRef.current = false;
    setLoading(false);
    setHistory(null);
    setHistoryError(false);
  }, [revision]);
  useEffect(() => {
    if (!canEdit) {
      setEditing(false);
      setDraft("");
      setError("");
    }
  }, [canEdit]);

  async function loadHistory(next = false) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setHistoryError(false);
    const attempt = ++generation.current;
    try {
      const page = await getWebPersonNoteHistory(
        ledger,
        person,
        next ? history?.next_cursor : undefined,
      );
      if (attempt !== generation.current) return;
      setHistory((current) =>
        next && current
          ? {
              ...page,
              entries: [
                ...current.entries,
                ...page.entries.filter(
                  (row) => !current.entries.some((previous) => previous.event_id === row.event_id),
                ),
              ],
            }
          : page,
      );
    } catch {
      if (attempt === generation.current) setHistoryError(true);
    } finally {
      if (attempt === generation.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }

  return (
    <section className="workspace-person-note" aria-label={c.title}>
      <div className="workspace-note-heading">
        <div>
          <h3>{c.title}</h3>
          <p>{c.private}</p>
        </div>
        {!editing && canEdit && (
          <button
            type="button"
            className="workspace-button"
            onClick={() => {
              setDraft(person.note ?? "");
              setOriginal(person);
              setError("");
              setEditing(true);
            }}
          >
            {person.note ? c.edit : c.add}
          </button>
        )}
      </div>
      {editing ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving || !canEdit) return;
            if (Array.from(draft.trim()).length > 2000) {
              setError(c.tooLong);
              return;
            }
            if (changed) {
              setError(c.changed);
              return;
            }
            setSaving(true);
            setError("");
            try {
              await updateWebPersonNote(ledger, original, draft.trim() || null);
              setEditing(false);
              setDraft("");
              await onSaved();
            } catch (reason) {
              setError(
                reason instanceof WebLedgerError && /stale|changed/.test(reason.code)
                  ? c.changed
                  : c.error,
              );
            } finally {
              onWriteSettled();
              setSaving(false);
            }
          }}
        >
          <label className="workspace-note-editor">
            {c.title}
            <textarea
              autoFocus
              rows={4}
              value={draft}
              maxLength={4000}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <small>{Array.from(draft.trim()).length}/2,000</small>
          {changed && (
            <p role="status">
              {c.changed}{" "}
              <button
                type="button"
                className="workspace-inline-link"
                disabled={saving}
                onClick={() => {
                  setOriginal(person);
                  setDraft(person.note ?? "");
                  setError("");
                }}
              >
                {c.reload}
              </button>
            </p>
          )}
          {error && (
            <p role="alert" className="workspace-form-error">
              {error}
            </p>
          )}
          <div className="workspace-note-actions">
            <button
              type="button"
              className="workspace-button"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setDraft("");
                setError("");
              }}
            >
              {c.cancel}
            </button>
            <button
              type="submit"
              className="workspace-button primary"
              disabled={saving || changed || Array.from(draft.trim()).length > 2000}
            >
              {saving ? c.saving : c.save}
            </button>
          </div>
        </form>
      ) : (
        <p className={`workspace-note-text ${person.note ? "" : "empty"}`}>
          {person.note || c.empty}
        </p>
      )}
      <button
        type="button"
        className="workspace-inline-link"
        aria-expanded={historyOpen}
        onClick={() => {
          setHistoryOpen((current) => !current);
          if (!historyOpen && !history && !loading) void loadHistory();
        }}
      >
        {c.history}
      </button>
      {historyOpen && (
        <div className="workspace-note-history">
          {history?.entries.map((row) => (
            <article key={row.event_id}>
              <p>{row.note ?? c.cleared}</p>
              <small>
                {c.unknown} ·{" "}
                <time dateTime={new Date(row.at).toISOString()}>
                  {new Intl.DateTimeFormat(lang, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(row.at)}
                </time>
              </small>
            </article>
          ))}
          {history && !history.entries.length && <p>{c.noHistory}</p>}
          {historyError && (
            <p role="status">
              {c.historyError}{" "}
              <button
                type="button"
                className="workspace-inline-link"
                onClick={() => void loadHistory(!!history)}
              >
                {c.reload}
              </button>
            </p>
          )}
          {loading && <p role="status">{c.loading}</p>}
          {!loading && history?.has_more && (
            <button
              type="button"
              className="workspace-button"
              onClick={() => void loadHistory(true)}
            >
              {c.more}
            </button>
          )}
          {!loading && !history && !historyError && (
            <button type="button" className="workspace-button" onClick={() => void loadHistory()}>
              {c.history}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
