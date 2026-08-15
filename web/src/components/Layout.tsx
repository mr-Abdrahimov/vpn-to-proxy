import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Cable, LayoutDashboard, LogOut, Menu, ScrollText, Settings2, X } from 'lucide-react';
import clsx from 'clsx';
import { api, type SingBoxStatus, type User } from '../lib/api';
import { Badge, Button } from './ui';
import { errorText, useToast } from './toast';

const NAV = [
  { to: '/', label: 'Обзор', icon: LayoutDashboard, end: true },
  { to: '/subscriptions', label: 'Подписки', icon: Cable, end: false },
  { to: '/proxies', label: 'Прокси', icon: Activity, end: false },
  { to: '/logs', label: 'Журнал', icon: ScrollText, end: false },
  { to: '/settings', label: 'Настройки', icon: Settings2, end: false },
];

const STATUS_LABELS: Record<SingBoxStatus, { text: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  running: { text: 'sing-box работает', tone: 'ok' },
  starting: { text: 'sing-box запускается', tone: 'warn' },
  stopped: { text: 'sing-box остановлен', tone: 'neutral' },
  failed: { text: 'sing-box упал', tone: 'bad' },
  'binary-missing': { text: 'sing-box не найден', tone: 'bad' },
};

export function Layout({ user, children }: { user: User; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  // Статус ядра нужен на каждой странице, поэтому опрашиваем его в шапке
  // и складываем в общий кэш — страницы читают его без своих запросов.
  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: api.system.status,
    refetchInterval: 5000,
  });

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
      {/* Затемнение под выдвижным меню на узких экранах */}
      {menuOpen ? (
        <div className="fixed inset-0 z-30 bg-ink-950/70 lg:hidden" onClick={() => setMenuOpen(false)} aria-hidden />
      ) : null}

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-ink-850 bg-ink-900 transition-transform lg:static lg:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-ink-850 px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white">
              VP
            </div>
            <span className="text-sm font-semibold text-ink-100">vpn-to-proxy</span>
          </div>
          <button
            type="button"
            className="rounded p-1 text-ink-500 hover:text-ink-200 lg:hidden"
            onClick={() => setMenuOpen(false)}
            aria-label="Закрыть меню"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-ink-800 font-medium text-ink-100' : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200',
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-ink-850 p-3">
          {statusInfo ? (
            <div className="mb-3 px-1">
              <Badge tone={statusInfo.tone}>
                <span
                  className={clsx(
                    'size-1.5 rounded-full',
                    statusInfo.tone === 'ok' && 'bg-ok-400',
                    statusInfo.tone === 'warn' && 'animate-pulse bg-warn-400',
                    statusInfo.tone === 'bad' && 'bg-bad-400',
                    statusInfo.tone === 'neutral' && 'bg-ink-500',
                  )}
                />
                {statusInfo.text}
              </Badge>
              {status.data?.singbox.version ? (
                <p className="mt-1.5 px-0.5 font-mono text-[11px] text-ink-600">{status.data.singbox.version}</p>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2 rounded-lg bg-ink-850 px-2.5 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-ink-200">{user.username}</p>
              <p className="text-[11px] text-ink-500">администратор</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => logout.mutate()}
              loading={logout.isPending}
              title="Выйти"
              className="px-1.5"
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-ink-850 bg-ink-900/60 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="rounded-lg p-1.5 text-ink-300 hover:bg-ink-800"
            aria-label="Открыть меню"
          >
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold text-ink-100">vpn-to-proxy</span>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
