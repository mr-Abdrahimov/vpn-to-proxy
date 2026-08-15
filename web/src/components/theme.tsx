import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '../lib/cn';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'vtp-theme';

interface ThemeContextValue {
  mode: ThemeMode;
  /** Тема, которая реально применена сейчас (system уже разрешён). */
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());

  // В режиме «системная» тема должна меняться на лету вместе с настройкой ОС.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme должен использоваться внутри ThemeProvider');
  return context;
}

const OPTIONS: { mode: ThemeMode; icon: typeof Sun; title: string }[] = [
  { mode: 'light', icon: Sun, title: 'Светлая тема' },
  { mode: 'dark', icon: Moon, title: 'Тёмная тема' },
  { mode: 'system', icon: Monitor, title: 'Как в системе' },
];

/** Сегментированный переключатель: три состояния видны сразу, без меню. */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useTheme();

  return (
    <div className={cn('inline-flex rounded-lg border border-border bg-muted/60 p-0.5', className)} role="group">
      {OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          title={option.title}
          aria-label={option.title}
          aria-pressed={mode === option.mode}
          onClick={() => setMode(option.mode)}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md transition-colors',
            mode === option.mode
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <option.icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
