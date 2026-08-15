import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Cable, RefreshCw, RotateCw, Server, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatRelative, plural } from '../lib/format';
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
      else toast.success(`Конфигурация применена: ${data.result.bindings} ${plural(data.result.bindings, 'прокси', 'прокси', 'прокси')}`);
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
    onSuccess: (data) =>
      toast.success('Проверка завершена', `Работают ${data.summary.ok} из ${data.summary.checked}`),
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
    return <p className="text-sm text-bad-400">Не удалось получить статус: {errorText(status.error)}</p>;
  }

  const { counts, singbox, syncError, portRange, publicHost } = status.data;
  const usedPorts = counts.proxies;
  const totalPorts = portRange.end - portRange.start + 1;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Обзор</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Прокси раздаются на <span className="font-mono text-ink-300">{publicHost}</span>
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
        <div className="rounded-xl border border-bad-500/30 bg-bad-500/8 p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-bad-400" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-bad-400">Конфигурация не применена</p>
              <p className="mt-1 text-sm text-ink-300">{syncError.message}</p>
              {syncError.output ? (
                <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-ink-950 p-2.5 font-mono text-[11px] leading-relaxed text-ink-400">
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
          hint={<Link to="/subscriptions" className="text-brand-400 hover:underline">управлять</Link>}
        />
        <Stat
          icon={<Server className="size-4" />}
          label="Коннекты"
          value={counts.nodes}
          hint={
            <>
              включено {counts.nodesEnabled}
              {counts.nodesMissing > 0 ? <span className="text-warn-400"> · пропало {counts.nodesMissing}</span> : null}
            </>
          }
        />
        <Stat
          icon={<Activity className="size-4" />}
          label="Прокси"
          value={counts.proxies}
          hint={
            <>
              активно {counts.proxiesEnabled} · портов занято {usedPorts} из {totalPorts}
            </>
          }
        />
        <Stat
          icon={<Zap className="size-4" />}
          label="Проверка"
          value={counts.proxiesOk}
          tone={counts.proxiesFail > 0 ? 'warn' : 'ok'}
          hint={
            <>
              работают
              {counts.proxiesFail > 0 ? <span className="text-bad-400"> · не отвечают {counts.proxiesFail}</span> : null}
            </>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Ядро sing-box">
          <dl className="divide-y divide-ink-850 text-sm">
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
                <span className="text-bad-400">{singbox.lastError}</span>
              </Row>
            ) : null}
          </dl>
        </Card>

        <Card
          title="Последние события"
          action={
            <Link to="/logs" className="text-xs text-brand-400 hover:underline">
              весь журнал
            </Link>
          }
        >
          {events.data?.events.length ? (
            <ul className="divide-y divide-ink-850">
              {events.data.events.map((event) => (
                <li key={event.id} className="flex gap-2.5 px-4 py-2.5">
                  <span
                    className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                      event.level === 'error' ? 'bg-bad-400' : event.level === 'warn' ? 'bg-warn-400' : 'bg-ink-600'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug text-ink-200">{event.message}</p>
                    <p className="mt-0.5 text-xs text-ink-600">
                      {event.source} · {formatRelative(event.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-ink-600">Событий пока нет</p>
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
  icon: React.ReactNode;
  label: string;
  value: number;
  hint?: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn';
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-ink-500">
        {icon}
        <span className="text-xs font-medium tracking-wide uppercase">{label}</span>
      </div>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums ${
          tone === 'ok' ? 'text-ok-400' : tone === 'warn' ? 'text-warn-400' : 'text-ink-100'
        }`}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right text-ink-200">{children}</dd>
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
