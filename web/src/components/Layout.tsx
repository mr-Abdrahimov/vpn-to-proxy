import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Cable, LayoutDashboard, LogOut, Menu, ScrollText, Settings2, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { api, type SingBoxStatus, type User } from '../lib/api';
import { Badge, Button } from './ui';
import { ThemeToggle } from './theme';
import { errorText, useToast } from './toast';

const NAV = [
  { to: '/', label: 'Обзор', icon: LayoutDashboard, end: true },
  { to: '/subscriptions', label: 'Подписки', icon: Cable, end: false },
  { to: '/proxies', label: 'Прокси', icon: Activity, end: false },
  { to: '/logs', label: 'Журнал', icon: ScrollText, end: false },
  { to: '/settings', label: 'Настройки', icon: Settings2, end: false },
];

const STATUS_LABELS: Record<SingBoxStatus, { text: string; tone: 'ok' | 'warn' | 'bad' | 'neutral'; dot: string }> = {
  running: { text: 'sing-box работает', tone: 'ok', dot: 'bg-success' },
  starting: { text: 'sing-box запускается', tone: 'warn', dot: 'bg-warning animate-pulse' },
  stopped: { text: 'sing-box остановлен', tone: 'neutral', dot: 'bg-muted-foreground' },
  failed: { text: 'sing-box упал', tone: 'bad', dot: 'bg-danger' },
  'binary-missing': { text: 'sing-box не найден', tone: 'bad', dot: 'bg-danger' },
};

export function Layout({ user, children }: { user: User; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  // Статус ядра нужен на каждой странице, поэтому опрашиваем его в шапке
  // и складываем в общий кэш — страницы читают его без своих запросов.
  const status = useQuery({ queryKey: ['system-status'], queryFn: api.system.status, refetchInterval: 5000 });

  const logout = useMutation({
    mutationFn: api.auth.logout,
    onSuccess: () => {
      queryClient.clear();
      navigate('/');
      window.location.reload();
    },
    onError: (error) => toast.error('Не удалось выйти', errorText(error)),
  });

  const singboxStatus = status.data?.singbox.status;
  const statusInfo = singboxStatus ? STATUS_LABELS[singboxStatus] : null;

  return (
    <div className="flex min-h-screen">
      {menuOpen ? (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setMenuOpen(false)} aria-hidden />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-card transition-transform lg:static lg:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
              VP
            </div>
            <span className="text-sm font-semibold">vpn-to-proxy</span>
          </div>
          <Button variant="ghost" size="iconSm" className="lg:hidden" onClick={() => setMenuOpen(false)} aria-label="Закрыть меню">
            <X className="size-4" />
          </Button>
        </div>

        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-3 border-t border-border p-3">
          {statusInfo ? (
            <div className="px-1">
              <Badge tone={statusInfo.tone}>
                <span className={cn('size-1.5 rounded-full', statusInfo.dot)} />
                {statusInfo.text}
              </Badge>
              {status.data?.singbox.version ? (
                <p className="mt-1.5 px-0.5 font-mono text-[11px] text-muted-foreground/70">
                  {status.data.singbox.version}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Тема</span>
            <ThemeToggle />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-2.5 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{user.username}</p>
              <p className="text-[11px] text-muted-foreground">администратор</p>
            </div>
            <Button
              variant="ghost"
              size="iconSm"
              onClick={() => logout.mutate()}
              loading={logout.isPending}
              title="Выйти"
              aria-label="Выйти"
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-card px-4 lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMenuOpen(true)} aria-label="Открыть меню">
            <Menu className="size-5" />
          </Button>
          <span className="text-sm font-semibold">vpn-to-proxy</span>
          <div className="flex-1" />
          <ThemeToggle />
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
