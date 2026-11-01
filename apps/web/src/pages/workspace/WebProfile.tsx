import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { useToast } from "../../components/Toast";
import { useI18n } from "../../lib/i18n";
import {
  getWebSession,
  isSameWebSession,
  updateWebSessionProfile,
  WebApiError,
  type WebSession,
} from "../../lib/web-auth";
import { getWebProfile, saveWebProfile, type WebProfile } from "../../lib/web-profile";
import { openWebRouteDialog } from "../../lib/web-route-dialog";
import { webProfileCopy } from "./web-profile-copy";
import "./WebProfile.css";

export function WebProfilePanel({
  session,
  open,
  onClose,
  online,
}: {
  session: WebSession;
  open: boolean;
  onClose: () => void;
  online: boolean;
}) {
  const { lang } = useI18n();
  const c = webProfileCopy[lang];
  const toast = useToast();
  const [profile, setProfile] = useState<WebProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const readVersion = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  useEffect(() => () => saveController.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    readController.current = controller;
    const version = ++readVersion.current;
    setLoading(true);
    setFailed(false);
    void getWebProfile(controller.signal)
      .then((next) => {
        if (
          controller.signal.aborted ||
          version !== readVersion.current ||
          !isSameWebSession(getWebSession(), session)
        )
          return;
        setProfile(next);
        updateWebSessionProfile(session, next);
      })
      .catch(() => {
        if (!controller.signal.aborted && version === readVersion.current) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted && version === readVersion.current) setLoading(false);
      });
    return () => controller.abort();
  }, [session.account_id, session.install_id, open, reload]);

  async function save(values: { name: string; phone: string }) {
    if (!isSameWebSession(getWebSession(), session)) return;
    // An earlier read must never replace this save's returned profile. The
    // editor also waits for a fresh read before it mounts editable fields.
    ++readVersion.current;
    readController.current?.abort();
    setLoading(false);
    setFailed(false);
    const controller = new AbortController();
    saveController.current?.abort();
    saveController.current = controller;
    const next = await saveWebProfile(values, controller.signal);
    if (controller.signal.aborted || !updateWebSessionProfile(session, next)) return;
    setProfile(next);
    toast.push(next.has_onboarded ? c.saved : c.kaataNext, "success");
    onClose();
  }

  if (!open && profile && !profile.needs_setup) return null;
  if (!open && !profile && !failed) return null;
  const content =
    profile && !(open && (loading || failed)) ? (
      <ProfileForm
        key={open ? "edit" : "setup"}
        profile={profile}
        online={online}
        onSave={save}
        onClose={open ? onClose : undefined}
      />
    ) : (
      <div className="web-profile-load" role={failed ? "alert" : "status"}>
        <p>{failed ? c.loadError : c.loading}</p>
        {failed && (
          <Button
            type="button"
            variant="outline"
            disabled={!online}
            onClick={() => setReload((value) => value + 1)}
          >
            {c.retry}
          </Button>
        )}
      </div>
    );
  return open ? (
    <ProfileDialog onClose={onClose} loading={!profile || loading || failed}>
      {content}
    </ProfileDialog>
  ) : (
    <Card className="web-profile-card">{content}</Card>
  );
}

function ProfileDialog({
  children,
  onClose,
  loading,
}: {
  children: React.ReactNode;
  onClose: () => void;
  loading: boolean;
}) {
  const { lang } = useI18n();
  const c = webProfileCopy[lang];
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => (dialog.current ? openWebRouteDialog(dialog.current) : undefined), []);
  return (
    <dialog
      ref={dialog}
      className="workspace-dialog web-profile-dialog"
      aria-label={c.title}
      onCancel={(event) => {
        event.preventDefault();
        if (dialog.current?.querySelector('[aria-busy="true"]')) return;
        onClose();
      }}
    >
      {loading && (
        <Button type="button" variant="ghost" onClick={onClose}>
          {c.close}
        </Button>
      )}
      {children}
    </dialog>
  );
}

function ProfileForm({
  profile,
  online,
  onSave,
  onClose,
}: {
  profile: WebProfile;
  online: boolean;
  onSave: (values: { name: string; phone: string }) => Promise<void>;
  onClose?: () => void;
}) {
  const { lang } = useI18n();
  const c = webProfileCopy[lang];
  const id = useId();
  const [name, setName] = useState(profile.name);
  const [phone, setPhone] = useState(profile.phone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<"name" | "phone" | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !online) return;
    setError("");
    setInvalid(null);
    if (Array.from(name.trim()).length < 2 || Array.from(name.trim()).length > 60) {
      setInvalid("name");
      setError(c.invalidName);
      return;
    }
    if (!phone.trim()) {
      setInvalid("phone");
      setError(c.invalidPhone);
      return;
    }
    setBusy(true);
    try {
      await onSave({ name, phone });
    } catch (cause) {
      const code = cause instanceof WebApiError ? cause.code : "";
      setInvalid(code === "invalid_name" ? "name" : code === "invalid_phone" ? "phone" : null);
      setError(
        code === "invalid_name"
          ? c.invalidName
          : code === "invalid_phone"
            ? c.invalidPhone
            : c.saveError,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="web-profile-form"
      onSubmit={submit}
      aria-busy={busy}
      aria-labelledby={`${id}-heading`}
    >
      <div className="web-profile-heading">
        <h2 id={`${id}-heading`}>{onClose ? c.title : c.setup}</h2>
        {onClose && (
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
        )}
      </div>
      <p className="web-profile-intro">{c.body}</p>
      <div className="web-profile-fields">
        <div>
          <label htmlFor={`${id}-name`}>{c.name}</label>
          <Input
            id={`${id}-name`}
            autoComplete="name"
            dir="auto"
            value={name}
            disabled={busy}
            required
            maxLength={120}
            aria-invalid={invalid === "name"}
            aria-describedby={invalid === "name" ? `${id}-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
              setInvalid(null);
            }}
          />
        </div>
        <div>
          <label htmlFor={`${id}-phone`}>{c.phone}</label>
          <Input
            id={`${id}-phone`}
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            dir="ltr"
            value={phone}
            disabled={busy}
            required
            maxLength={80}
            aria-invalid={invalid === "phone"}
            aria-describedby={`${id}-phone-hint${invalid === "phone" ? ` ${id}-error` : ""}`}
            onChange={(event) => {
              setPhone(event.target.value);
              setError("");
              setInvalid(null);
            }}
          />
          <p className="web-profile-hint" id={`${id}-phone-hint`}>
            {c.phoneHint}
          </p>
        </div>
      </div>
      {error && (
        <p className="web-profile-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      {!online && (
        <p className="web-profile-hint" role="status">
          {c.offline}
        </p>
      )}
      <div className="web-profile-actions">
        <Button type="submit" variant="brand" disabled={busy || !online}>
          {busy ? c.saving : c.save}
        </Button>
        {onClose && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {c.cancel}
          </Button>
        )}
      </div>
    </form>
  );
}
