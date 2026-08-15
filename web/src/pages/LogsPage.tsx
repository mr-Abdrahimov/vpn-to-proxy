import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eraser, FileJson, RefreshCw } from 'lucide-react';
import { api, type EventLevel } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Badge, Button, Card, Modal, Select, Spinner } from '../components/ui';
import { errorText, useToast } from '../components/toast';

export function LogsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [tab, setTab] = useState<'singbox' | 'events'>('singbox');
  const [level, setLevel] = useState<EventLevel | ''>('');
  const [live, setLive] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);

  const logs = useQuery({
    queryKey: ['singbox-logs'],
    queryFn: () => api.system.logs(500),
    refetchInterval: live && tab === 'singbox' ? 3000 : false,
  });

  const events = useQuery({
    queryKey: ['events', 200, level],
    queryFn: () => api.events.list(200, level || undefined),
    refetchInterval: live && tab === 'events' ? 8000 : false,
  });

  const config = useQuery({ queryKey: ['singbox-config'], queryFn: api.system.config, enabled: configOpen });

  const clear = useMutation({
    mutationFn: api.events.clear,
    onSuccess: (data) => {
      toast.success(`Журнал очищен: ${data.deleted}`);
      void queryClient.invalidateQueries({ queryKey: ['events'] });
    },
    onError: (error) => toast.error('Ошибка', errorText(error)),
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Журнал</h1>
          <p className="mt-0.5 text-sm text-ink-500">Вывод ядра sing-box и события панели</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<FileJson className="size-4" />} onClick={() => setConfigOpen(true)}>
            Показать конфиг
          </Button>
          <Button
            size="sm"
            icon={<RefreshCw className={`size-4 ${live ? 'animate-spin [animation-duration:3s]' : ''}`} />}
            onClick={() => setLive(!live)}
          >
            {live ? 'Живое обновление' : 'Обновление выключено'}
          </Button>
        </div>
      </header>

      <div className="flex gap-2">
        {(
          [
            ['singbox', 'sing-box'],
            ['events', 'События панели'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              tab === key ? 'bg-ink-800 font-medium text-ink-100' : 'text-ink-400 hover:bg-ink-850'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'singbox' ? (
        <Card>
          {logs.isPending ? (
            <div className="flex justify-center py-14">
              <Spinner className="size-5" />
            </div>
          ) : logs.data?.lines.length ? (
            <pre className="max-h-[65vh] overflow-auto p-3.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-ink-400">
              {logs.data.lines.join('\n')}
            </pre>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-ink-600">
              Ядро ещё ничего не написало. Если прокси не создано, sing-box намеренно не запускается.
            </p>
          )}
        </Card>
      ) : (
        <Card
          action={
            <div className="flex items-center gap-2">
              <Select value={level} onChange={(event) => setLevel(event.target.value as EventLevel | '')} className="h-8 py-1 text-xs">
                <option value="">Все уровни</option>
                <option value="info">Информация</option>
                <option value="warn">Предупреждения</option>
                <option value="error">Ошибки</option>
              </Select>
              <Button size="sm" variant="ghost" icon={<Eraser className="size-3.5" />} onClick={() => clear.mutate()} loading={clear.isPending}>
                Очистить
              </Button>
            </div>
          }
          title="События"
        >
          {events.isPending ? (
            <div className="flex justify-center py-14">
              <Spinner className="size-5" />
            </div>
          ) : events.data?.events.length ? (
            <ul className="max-h-[65vh] divide-y divide-ink-850 overflow-auto">
              {events.data.events.map((event) => (
                <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
                  <span className="w-32 shrink-0 font-mono text-xs text-ink-600">{formatDateTime(event.createdAt)}</span>
                  <Badge tone={event.level === 'error' ? 'bad' : event.level === 'warn' ? 'warn' : 'neutral'}>
                    {event.source}
                  </Badge>
                  <span className="min-w-0 flex-1 text-sm text-ink-300">{event.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-ink-600">Событий пока нет</p>
          )}
        </Card>
      )}

      <Modal open={configOpen} onClose={() => setConfigOpen(false)} wide title="Текущий конфиг sing-box">
        {config.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-400">
            {config.data?.config ?? 'Конфиг ещё не сгенерирован'}
          </pre>
        )}
      </Modal>
    </div>
  );
}
