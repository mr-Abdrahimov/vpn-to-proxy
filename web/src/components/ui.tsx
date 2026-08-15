import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Checkbox as RxCheckbox, Dialog as RxDialog, Select as RxSelect, Switch as RxSwitch, Tooltip as RxTooltip } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronDown, ChevronUp, Copy, Loader2, X } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Набор примитивов на Radix UI: доступность, клавиатура и фокус-ловушки
 * приходят из библиотеки, здесь остаётся только оформление.
 * Цвета берутся из семантических токенов, поэтому обе темы работают
 * без единого `dark:`-класса в компонентах.
 */

// ───────────────────────────────── Button ─────────────────────────────────

const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap',
    'transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
    'disabled:pointer-events-none disabled:opacity-50',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary: 'border border-border bg-card text-foreground hover:bg-accent',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
        danger: 'border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20',
      },
      size: {
        sm: 'h-8 gap-1.5 px-2.5 text-xs',
        md: 'h-9.5 gap-2 px-3.5 text-sm',
        icon: 'size-8 p-0',
        iconSm: 'size-7 p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

// ───────────────────────────────── Поля ─────────────────────────────────

const fieldClasses = cn(
  'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground',
  'placeholder:text-muted-foreground/70 transition-colors',
  'focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(fieldClasses, 'h-9.5', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(fieldClasses, 'font-mono text-xs', className)} {...rest} />;
  },
);

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <span className="label">{label}</span>
      {children}
      {hint ? <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ───────────────────────────────── Select ─────────────────────────────────

export interface SelectItem {
  value: string;
  label: string;
}

export function Select({
  value,
  onValueChange,
  items,
  placeholder = 'Выбрать…',
  className,
  size = 'md',
  'aria-label': ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  items: SelectItem[];
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'md';
  'aria-label'?: string;
}) {
  return (
    <RxSelect.Root value={value} onValueChange={onValueChange}>
      <RxSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center justify-between gap-2 rounded-md border border-input bg-card text-foreground',
          'transition-colors focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none',
          'data-[placeholder]:text-muted-foreground/70',
          size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9.5 px-3 text-sm',
          className,
        )}
      >
        <RxSelect.Value placeholder={placeholder} />
        <RxSelect.Icon>
          <ChevronDown className="size-4 opacity-60" />
        </RxSelect.Icon>
      </RxSelect.Trigger>

      <RxSelect.Portal>
        <RxSelect.Content
          position="popper"
          sideOffset={6}
          className="vtp-pop z-50 max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <RxSelect.ScrollUpButton className="flex h-6 items-center justify-center">
            <ChevronUp className="size-3.5 opacity-60" />
          </RxSelect.ScrollUpButton>

          <RxSelect.Viewport className="p-1">
            {items.map((item) => (
              <RxSelect.Item
                key={item.value}
                value={item.value}
                className={cn(
                  'relative flex cursor-pointer items-center rounded-md py-1.5 pr-7 pl-2.5 text-sm select-none',
                  'data-[highlighted]:bg-accent data-[highlighted]:outline-none',
                )}
              >
                <RxSelect.ItemText>{item.label}</RxSelect.ItemText>
                <RxSelect.ItemIndicator className="absolute right-2">
                  <Check className="size-3.5" />
                </RxSelect.ItemIndicator>
              </RxSelect.Item>
            ))}
          </RxSelect.Viewport>

          <RxSelect.ScrollDownButton className="flex h-6 items-center justify-center">
            <ChevronDown className="size-3.5 opacity-60" />
          </RxSelect.ScrollDownButton>
        </RxSelect.Content>
      </RxSelect.Portal>
    </RxSelect.Root>
  );
}

// ──────────────────────────── Switch и Checkbox ────────────────────────────

export function Toggle({
  checked,
  onChange,
  disabled,
  title,
  className,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <RxSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent',
        'transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className,
      )}
    >
      <RxSwitch.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0',
          'transition-transform data-[state=checked]:translate-x-4.5 data-[state=unchecked]:translate-x-0.5',
        )}
      />
    </RxSwitch.Root>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const control = (
    <RxCheckbox.Root
      checked={checked}
      onCheckedChange={(state) => onChange(state === true)}
      disabled={disabled}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-card',
        'transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary',
        'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RxCheckbox.Indicator className="text-primary-foreground">
        <Check className="size-3" strokeWidth={3} />
      </RxCheckbox.Indicator>
    </RxCheckbox.Root>
  );

  if (label === undefined) return control;

  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 text-sm text-foreground select-none',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {control}
      {label}
    </label>
  );
}

// ───────────────────────────── Мелкие элементы ─────────────────────────────

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        ok: 'border-success/30 bg-success-surface text-success',
        warn: 'border-warning/30 bg-warning-surface text-warning',
        bad: 'border-danger/30 bg-danger-surface text-danger',
        brand: 'border-primary/30 bg-primary/10 text-primary',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  tone,
  children,
  className,
}: VariantProps<typeof badgeVariants> & { children: ReactNode; className?: string }) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}

export function Card({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-card text-card-foreground', className)}>
      {title !== undefined ? (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-muted-foreground', className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      {icon ? <div className="text-muted-foreground/50">{icon}</div> : null}
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <RxTooltip.Provider delayDuration={400}>
      <RxTooltip.Root>
        <RxTooltip.Trigger asChild>{children}</RxTooltip.Trigger>
        <RxTooltip.Portal>
          <RxTooltip.Content
            sideOffset={6}
            className="vtp-pop z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          >
            {label}
          </RxTooltip.Content>
        </RxTooltip.Portal>
      </RxTooltip.Root>
    </RxTooltip.Provider>
  );
}

// ───────────────────────────────── Диалоги ─────────────────────────────────

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <RxDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <RxDialog.Portal>
        <RxDialog.Overlay className="vtp-overlay fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <RxDialog.Content
          className={cn(
            'vtp-pop fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'overflow-y-auto rounded-xl border border-border bg-card text-card-foreground shadow-2xl',
            wide ? 'max-w-3xl' : 'max-w-lg',
          )}
        >
          <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-card px-5 py-3.5">
            <div>
              <RxDialog.Title className="text-sm font-semibold">{title}</RxDialog.Title>
              {description ? (
                <RxDialog.Description className="mt-0.5 text-xs text-muted-foreground">
                  {description}
                </RxDialog.Description>
              ) : null}
            </div>
            <RxDialog.Close asChild>
              <Button variant="ghost" size="iconSm" aria-label="Закрыть">
                <X className="size-4" />
              </Button>
            </RxDialog.Close>
          </header>

          <div className="px-5 py-4">{children}</div>

          {footer ? (
            <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-card px-5 py-3.5">
              {footer}
            </footer>
          ) : null}
        </RxDialog.Content>
      </RxDialog.Portal>
    </RxDialog.Root>
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
      <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
    </Modal>
  );
}

export function CopyButton({ value, title = 'Скопировать', className }: { value: string; title?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API недоступен вне защищённого контекста — запасной путь.
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
    <Button
      variant="ghost"
      size="iconSm"
      onClick={() => void copy()}
      title={title}
      aria-label={title}
      className={className}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
