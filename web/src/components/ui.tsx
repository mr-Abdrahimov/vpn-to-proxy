import {
  forwardRef,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';
import clsx from 'clsx';

/** Небольшой набор примитивов — ровно то, что нужно этой панели. */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-500 disabled:hover:bg-brand-600',
  secondary: 'bg-ink-750 text-ink-100 hover:bg-ink-700 border border-ink-700',
  ghost: 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
  danger: 'bg-bad-500/15 text-bad-400 border border-bad-500/30 hover:bg-bad-500/25',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5',
  md: 'h-9.5 px-3.5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx('field', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={clsx('field font-mono text-xs', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={clsx('field cursor-pointer appearance-none pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <span className="label">{label}</span>
      {children}
      {hint ? <p className="mt-1.5 text-xs leading-relaxed text-ink-500">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={clsx(
        'inline-flex cursor-pointer items-center gap-2 text-sm text-ink-200 select-none',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 cursor-pointer rounded border-ink-600 bg-ink-850 accent-brand-500"
      />
      {label}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-600' : 'bg-ink-700',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 size-4 rounded-full bg-white transition-transform',
          checked ? 'translate-x-4.5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

type BadgeTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'brand';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-ink-800 text-ink-300 border-ink-700',
  ok: 'bg-ok-500/12 text-ok-400 border-ok-500/25',
  warn: 'bg-warn-500/12 text-warn-400 border-warn-500/25',
  bad: 'bg-bad-500/12 text-bad-400 border-bad-500/25',
  brand: 'bg-brand-500/12 text-brand-400 border-brand-500/25',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('card', className)}>
      {title !== undefined ? (
        <header className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-ink-400', className)} />;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      {icon ? <div className="text-ink-600">{icon}</div> : null}
      <div>
        <p className="text-sm font-medium text-ink-200">{title}</p>
        {description ? <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-500">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/80 p-4 backdrop-blur-sm sm:p-8">
      {/* Клик по подложке закрывает окно, клик внутри — нет. */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div
        className={clsx(
          'relative my-auto w-full rounded-xl border border-ink-750 bg-ink-900 shadow-2xl',
          wide ? 'max-w-3xl' : 'max-w-lg',
        )}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-center justify-between gap-3 border-b border-ink-800 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200"
            aria-label="Закрыть"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer ? <footer className="flex justify-end gap-2 border-t border-ink-800 px-5 py-3.5">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function CopyButton({ value, title = 'Скопировать', className }: { value: string; title?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API недоступен без HTTPS — запасной путь через скрытое поле.
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={title}
      className={clsx(
        'inline-flex size-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-100',
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-ok-400" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Удалить',
  onConfirm,
  onCancel,
  loading,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel} disabled={loading}>
            Отмена
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-300">{message}</p>
    </Modal>
  );
}
