import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastApi {
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  success: 3500,
  info: 4000,
  warning: 7000,
  // Ошибку не прячем быстро: её обычно нужно прочитать целиком.
  error: 12000,
};

const STYLES: Record<ToastKind, { icon: ReactNode; ring: string }> = {
  success: { icon: <CheckCircle2 className="size-5 text-ok-400" />, ring: 'border-ok-500/40' },
  error: { icon: <XCircle className="size-5 text-bad-400" />, ring: 'border-bad-500/40' },
  warning: { icon: <AlertTriangle className="size-5 text-warn-400" />, ring: 'border-warn-500/40' },
  info: { icon: <Info className="size-5 text-brand-400" />, ring: 'border-brand-500/40' },
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, title: string, description?: string) => {
      const id = nextId++;
      setToasts((current) => [...current, { id, kind, title, description }]);
      window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS[kind]);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, description) => push('success', title, description),
      error: (title, description) => push('error', title, description),
      info: (title, description) => push('info', title, description),
      warning: (title, description) => push('warning', title, description),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed top-4 right-4 z-100 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex gap-3 rounded-xl border bg-ink-850/95 p-3.5 shadow-xl backdrop-blur ${STYLES[toast.kind].ring}`}
            role="status"
          >
            <div className="mt-0.5 shrink-0">{STYLES[toast.kind].icon}</div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink-100">{toast.title}</p>
              {toast.description ? (
                <p className="mt-1 text-xs break-words text-ink-400">{toast.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="shrink-0 rounded p-1 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200"
              aria-label="Закрыть"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast должен использоваться внутри ToastProvider');
  return context;
}

/** Достаёт человекочитаемый текст из чего угодно, что прилетело в catch. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
