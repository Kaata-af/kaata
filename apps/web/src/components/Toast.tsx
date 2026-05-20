import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// Minimal toast system. One viewport (bottom-right on desktop, bottom-center
// on mobile), short auto-dismiss, calm monochrome styling that matches the
// rest of the kaata web bundle. Build vs. library trade-off: react-hot-toast
// is one extra dep for very little win, so we ship our own.

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
const ANIMATION_MS = 200;

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
      className="fixed z-50 bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:bottom-6 sm:max-w-sm flex flex-col gap-2 pointer-events-none"
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

  const tone =
    toast.kind === "error"
      ? "bg-red-50 border-red-200 text-red-900"
      : toast.kind === "success"
        ? "bg-neutral-900 text-white border-neutral-900"
        : "bg-white border-neutral-200 text-neutral-800";

  return (
    <div
      role="status"
      className={[
        "pointer-events-auto rounded-xl border px-4 py-3",
        "shadow-[0_12px_30px_-12px_rgba(0,0,0,0.18)]",
        "text-sm font-medium leading-relaxed",
        "transition-all duration-200 ease-out",
        entered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2",
        tone,
      ].join(" ")}
      style={{ transitionDuration: `${ANIMATION_MS}ms` }}
    >
      {toast.message}
    </div>
  );
}
