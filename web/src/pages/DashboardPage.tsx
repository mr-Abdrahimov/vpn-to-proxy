import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Cable, RefreshCw, RotateCw, Server, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/cn';
import { api } from '../lib/api';
import { formatRelative } from '../lib/format';
import { Badge, Button, Card, Spinner } from '../components/ui';
import { errorText, useToast } from '../components/toast';

export function DashboardPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const status = useQuery({ queryKey: ['system-status'], queryFn: api.system.status, refetchInterval: 5000 });
  const events = useQuery({ queryKey: ['events', 12], queryFn: () => api.events.list(12), refetchInterval: 15000 });

  const sync = useMutation({
    mutationFn: api.system.sync,
    onSuccess: (data) => {
      if (data.result.error) toast.error('Синхронизация не удалась', data.result.error);
      else toast.success(`Конфигурация применена: ${data.result.bindings} прокси`);
      void queryClient.invalidateQueries({ queryKey: ['system-status'] });
    },
    onError: (error) => toast.error('Ошибка', errorText(error)),
  });

  const restart = useMutation({
    mutationFn: api.system.restart,
    onSuccess: () => {
      toast.success('sing-box перезапущен');
      void queryClient.invalidateQueries({ queryKey: ['system-status'] });
    },
    onError: (error) => toast.error('Не удалось перезапустить', errorText(error)),
  });

  const check = useMutation({
    mutationFn: () => api.healthcheck(),
    onSuccess: (data) => {
      if (data.summary) {
        toast.success('Проверка завершена', `Работают ${data.summary.ok} из ${data.summary.checked}`);
      } else {
        // Большой прогон ушёл в фон — итог появится в счётчиках на этой же странице.
        toast.info('Проверка запущена', `Прокси в очереди: ${data.total ?? 0}. Счётчики обновятся по ходу проверки.`);
      }
      void queryClient.invalidateQueries({ queryKey: ['system-status'] });
    },
    onError: (error) => toast.error('Проверка не удалась', errorText(error)),
  });

  if (status.isPending) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (status.isError || !status.data) {
    return <p className="text-sm text-danger">Не удалось получить статус: {errorText(status.error)}</p>;
  }

  const { counts, singbox, syncError, portRange, publicHost } = status.data;
  const totalPorts = portRange.end - portRange.start + 1;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Обзор</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Прокси раздаются на <span className="font-mono text-foreground">{publicHost}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<RefreshCw className="size-4" />} onClick={() => sync.mutate()} loading={sync.isPending}>
            Пересобрать конфиг
          </Button>
          <Button size="sm" icon={<RotateCw className="size-4" />} onClick={() => restart.mutate()} loading={restart.isPending}>
            Перезапустить ядро
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Zap className="size-4" />}
            onClick={() => check.mutate()}
            loading={check.isPending || status.data.healthcheckRunning}
          >
            Проверить все
          </Button>
        </div>
      </header>

      {syncError ? (
        <div className="rounded-lg border border-danger/30 bg-danger-surface p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-danger">Конфигурация не применена</p>
              <p className="mt-1 text-sm">{syncError.message}</p>
              {syncError.output ? (
                <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-background p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {syncError.output}
                </pre>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={<Cable className="size-4" />}
          label="Подписки"
          value={counts.subscriptions}
          hint={
            <Link to="/subscriptions" className="text-primary hover:underline">
              управлять
            </Link>
          }
        />
        <Stat
          icon={<Server className="size-4" />}
          label="Коннекты"
          value={counts.nodes}
          hint={
            <>
              включено {counts.nodesEnabled}
              {counts.nodesMissing > 0 ? <span className="text-warning"> · пропало {counts.nodesMissing}</span> : null}
            </>
          }
        />
        <Stat
          icon={<Activity className="size-4" />}
          label="Прокси"
          value={counts.proxies}
          hint={
            <>
              активно {counts.proxiesEnabled} · портов занято {counts.proxies} из {totalPorts}
            </>
          }
        />
        <Stat
          icon={<Zap className="size-4" />}
          label="Работают"
          value={counts.proxiesOk}
          tone={counts.proxiesFail > 0 ? 'warn' : 'ok'}
          hint={
            <>
              из {counts.proxies}
              {counts.proxiesFail > 0 ? <span className="text-danger"> · не отвечают {counts.proxiesFail}</span> : null}
            </>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Ядро sing-box">
          <dl className="divide-y divide-border text-sm">
            <Row label="Состояние">
              <SingBoxBadge status={singbox.status} />
            </Row>
            <Row label="Версия">{singbox.version ?? '—'}</Row>
            <Row label="Бинарь">
              <span className="font-mono text-xs">{singbox.binary}</span>
            </Row>
            <Row label="Слушает портов">{singbox.inboundCount}</Row>
            <Row label="Запущен">{formatRelative(singbox.startedAt)}</Row>
            <Row label="Конфиг применён">{formatRelative(singbox.configuredAt)}</Row>
            {singbox.restarts > 0 ? <Row label="Аварийных перезапусков">{singbox.restarts}</Row> : null}
            {singbox.lastError ? (
              <Row label="Ошибка">
                <span className="text-danger">{singbox.lastError}</span>
              </Row>
            ) : null}
          </dl>
        </Card>

        <Card
          title="Последние события"
          action={
            <Link to="/logs" className="text-xs text-primary hover:underline">
              весь журнал
            </Link>
          }
        >
          {events.data?.events.length ? (
            <ul className="divide-y divide-border">
              {events.data.events.map((event) => (
                <li key={event.id} className="flex gap-2.5 px-4 py-2.5">
                  <span
                    className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      event.level === 'error' ? 'bg-danger' : event.level === 'warn' ? 'bg-warning' : 'bg-muted-foreground',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug">{event.message}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {event.source} · {formatRelative(event.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Событий пока нет</p>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: number;
  hint?: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn';
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium tracking-wide uppercase">{label}</span>
      </div>
      <p
        className={cn(
          'mt-2 text-2xl font-semibold tabular-nums',
          tone === 'ok' && 'text-success',
          tone === 'warn' && 'text-warning',
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function SingBoxBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <Badge tone="ok">работает</Badge>;
    case 'starting':
      return <Badge tone="warn">запускается</Badge>;
    case 'stopped':
      return <Badge>остановлен</Badge>;
    case 'binary-missing':
      return <Badge tone="bad">бинарь не найден</Badge>;
    default:
      return <Badge tone="bad">ошибка</Badge>;
  }
}
