import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { BrandLogo } from "../../components/BrandLogo";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { SelectField } from "../../components/ui/select-field";
import { useToast } from "../../components/Toast";
import { useI18n, type Lang } from "../../lib/i18n";
import { isSameWebSession, signOut, WebApiError, type WebSession } from "../../lib/web-auth";
import { createWebActivity } from "../../lib/web-activity";
import type { WebProfile } from "../../lib/web-profile";
import { createWebProfileFlow, type WebProfileFlow } from "../../lib/web-profile-flow";
import { openWebRouteDialog } from "../../lib/web-route-dialog";
import { webProfileCopy } from "./web-profile-copy";
import "./WebProfile.css";

const ProfileContext = createContext<WebProfileFlow | null>(null);

function useProfileFlow() {
  const flow = useContext(ProfileContext);
  if (!flow) throw new Error("WebProfilePanel requires WebProfileGate");
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return { flow, ...state };
}

export function WebProfileGate({
  session,
  children,
}: {
  session: WebSession;
  children: ReactNode;
}) {
  const { lang } = useI18n();
  const activityLocale = useRef(lang);
  activityLocale.current = lang;
  useEffect(() => {
    const activity = createWebActivity({ session, locale: () => activityLocale.current });
    return () => activity.stop();
  }, [session]);
  // Profile edits and rolling JWT renewal preserve admission. An actual
  // credential/account change creates a fresh request owner, even if a browser
  // install ID happens to be reused.
  const owner = useRef<{ session: WebSession; flow: WebProfileFlow } | null>(null);
  if (!owner.current || !isSameWebSession(owner.current.session, session)) {
    owner.current = { session, flow: createWebProfileFlow(session) };
  }
  const flow = owner.current.flow;
  useEffect(() => {
    flow.start();
    const recover = () => flow.recover();
    window.addEventListener("online", recover);
    return () => {
      window.removeEventListener("online", recover);
      flow.stop();
    };
  }, [flow]);
  return (
    <ProfileContext.Provider value={flow}>
      <ProfileAdmission>{children}</ProfileAdmission>
    </ProfileContext.Provider>
  );
}

function ProfileAdmission({ children }: { children: ReactNode }) {
  const { admitted, profile, loading, failed, flow } = useProfileFlow();
  const { lang, setLang } = useI18n();
  const c = webProfileCopy[lang];
  const toast = useToast();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [signingOut, setSigningOut] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
    };
  }, []);
  if (admitted) return children;
  async function save(values: { name: string; phone: string }) {
    setSaving(true);
    try {
      const next = await flow.save(values);
      if (next) toast.push(next.has_onboarded ? c.saved : c.kaataNext, "success");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="web-profile-setup" dir={lang === "en" ? "ltr" : "rtl"}>
      <header className="web-profile-setup-header">
        <div className="web-profile-setup-brand">
          <BrandLogo className="h-9 w-9" />
          <span>{lang === "en" ? "kaata." : "کاتا."}</span>
        </div>
        <div className="web-profile-setup-tools">
          <SelectField
            aria-label={c.language}
            dir={lang === "en" ? "ltr" : "rtl"}
            value={lang}
            onValueChange={(value) => setLang(value as Lang)}
            options={[
              { value: "en", label: "English" },
              { value: "fa", label: "دری" },
              { value: "ps", label: "پښتو" },
            ]}
          />
          <Button
            type="button"
            variant="ghost"
            disabled={saving || signingOut}
            onClick={async () => {
              setSigningOut(true);
              try {
                await signOut();
              } catch {
                toast.push(c.signOutError, "error");
              } finally {
                setSigningOut(false);
              }
            }}
          >
            {c.signOut}
          </Button>
        </div>
      </header>
      <main className="web-profile-setup-main">
        <div className="web-profile-setup-intro">
          <p className="web-profile-setup-eyebrow">{c.web}</p>
          <h1>{c.welcome}</h1>
          <p>{c.setupBody}</p>
        </div>
        <Card className="web-profile-card web-profile-setup-card">
          {profile ? (
            <ProfileForm profile={profile} online={online} onSave={save} setup />
          ) : (
            <ProfileLoad loading={loading} failed={failed} online={online} onRetry={flow.load} />
          )}
        </Card>
        <p className="web-profile-setup-note">{c.existingDetails}</p>
      </main>
    </div>
  );
}

export function WebProfilePanel({
  open,
  onClose,
  online,
}: {
  open: boolean;
  onClose: () => void;
  online: boolean;
}) {
  const { lang } = useI18n();
  const c = webProfileCopy[lang];
  const toast = useToast();
  const { flow, profile, loading, failed } = useProfileFlow();
  const [prepared, setPrepared] = useState(false);
  useEffect(() => {
    if (!open) {
      setPrepared(false);
      return;
    }
    let active = true;
    void flow.load().then(() => {
      if (active) setPrepared(true);
    });
    return () => {
      active = false;
    };
  }, [flow, open]);

  async function save(values: { name: string; phone: string }) {
    const next = await flow.save(values);
    if (!next) return;
    toast.push(next.has_onboarded ? c.saved : c.kaataNext, "success");
    onClose();
  }

  if (!open) return null;
  const content =
    prepared && profile && !loading && !failed ? (
      <ProfileForm
        key={open ? "edit" : "setup"}
        profile={profile}
        online={online}
        onSave={save}
        onClose={open ? onClose : undefined}
      />
    ) : (
      <ProfileLoad
        loading={!prepared || loading}
        failed={failed}
        online={online}
        onRetry={flow.load}
      />
    );
  return (
    <ProfileDialog onClose={onClose} loading={!prepared || !profile || loading || failed}>
      {content}
    </ProfileDialog>
  );
}

function ProfileLoad({
  loading,
  failed,
  online,
  onRetry,
}: {
  loading: boolean;
  failed: boolean;
  online: boolean;
  onRetry: () => Promise<void>;
}) {
  const { lang } = useI18n();
  const c = webProfileCopy[lang];
  return (
    <div className="web-profile-load" role={failed || !online ? "alert" : "status"}>
      <p>{!online ? c.offline : failed ? c.loadError : c.loading}</p>
      {failed && (
        <Button
          type="button"
          variant="outline"
          disabled={!online || loading}
          onClick={() => void onRetry()}
        >
          {c.retry}
        </Button>
      )}
    </div>
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
  setup = false,
}: {
  profile: WebProfile;
  online: boolean;
  onSave: (values: { name: string; phone: string }) => Promise<void>;
  onClose?: () => void;
  setup?: boolean;
}) {
  const { lang } = useI18n();
  const c = webProfileCopy[lang];
  const id = useId();
  const [name, setName] = useState(profile.name);
  const [phone, setPhone] = useState(profile.phone);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<"name" | "phone" | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !online) return;
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
    saving.current = true;
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
      saving.current = false;
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
          {busy ? c.saving : setup ? c.continue : c.save}
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
