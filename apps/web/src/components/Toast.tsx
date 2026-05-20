import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// kaata's toast system. Visual language pulled from the rest of the bundle:
// Inter weight ladder, generous padding, monochrome cards with a single colored
// accent for state, refined shadow. Bottom-right on desktop, bottom-edge on
// mobile. Build vs. library trade-off: react-hot-toast was one extra dep for
// very little win, so we ship our own.

type ToastKind = "success" | "error" | "info";

type Toast = {
  id: string;
  message: string;
  kind: ToastKind;
};

type ToastContextValue = {
  push: (message: string, kind?: ToastKind) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);
const TOAST_DURATION_MS = 3000;
const ANIMATION_MS = 220;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, kind: ToastKind = "info") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <ToastViewport toasts={toasts} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

function ToastViewport({ toasts }: { toasts: Toast[] }) {
  return (
    <div
      aria-live="polite"
      className="fixed z-50 bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:bottom-6 sm:w-auto sm:max-w-sm flex flex-col gap-2.5 pointer-events-none"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const [entered, setEntered] = useState(false);
  const enteredRef = useRef(false);

  useEffect(() => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    const t = window.setTimeout(() => setEntered(true), 10);
    return () => window.clearTimeout(t);
  }, []);

  // All variants share the white card so toasts feel like calm UI rather than
  // shouting. The kind shows through the icon + accent, not the whole bg.
  const accent =
    toast.kind === "error"
      ? "text-red-600"
      : toast.kind === "success"
        ? "text-neutral-900"
        : "text-neutral-500";

  return (
    <div
      role="status"
      className={[
        "pointer-events-auto",
        "rounded-xl border border-neutral-200 bg-white",
        "shadow-[0_18px_38px_-14px_rgba(0,0,0,0.22),_0_4px_10px_-6px_rgba(0,0,0,0.08)]",
        "transition-all ease-out",
        entered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
      ].join(" ")}
      style={{ transitionDuration: `${ANIMATION_MS}ms` }}
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className={`shrink-0 ${accent}`}>
          <ToastIcon kind={toast.kind} />
        </div>
        <p className="text-[14px] font-semibold text-neutral-900 leading-snug -tracking-[0.005em]">
          {toast.message}
        </p>
      </div>
    </div>
  );
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === "success") {
    return (
      <svg
        width="22"
        height="22"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
        className="block"
      >
        <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M6.25 10.25 8.75 12.75 13.75 7.25"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "error") {
    return (
      <svg
        width="22"
        height="22"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
        className="block"
      >
        <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M7 7 13 13 M13 7 7 13"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="block"
    >
      <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 9 v5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="10" cy="6.25" r="1" fill="currentColor" />
    </svg>
  );
}
