import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, Pencil, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { api, type RefreshReport, type Subscription } from '../lib/api';
import { formatDuration, formatRelative, plural } from '../lib/format';
import { cn } from '../lib/cn';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  Modal,
  Spinner,
  Textarea,
  Toggle,
} from '../components/ui';
import { errorText, useToast } from '../components/toast';

export function SubscriptionsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [deleting, setDeleting] = useState<Subscription | null>(null);
  const [lastReport, setLastReport] = useState<RefreshReport | null>(null);

  const subscriptions = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions.list });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    void queryClient.invalidateQueries({ queryKey: ['nodes'] });
    void queryClient.invalidateQueries({ queryKey: ['system-status'] });
  };

  const refresh = useMutation({
    mutationFn: (id: string) => api.subscriptions.refresh(id),
    onSuccess: ({ report }) => {
      setLastReport(report);
      toast.success(
        `«${report.name}» обновлена`,
        `${report.total} ${plural(report.total, 'коннект', 'коннекта', 'коннектов')}, новых ${report.added}, создано прокси ${report.proxiesCreated}`,
      );
      invalidate();
    },
    onError: (error) => toast.error('Не удалось обновить', errorText(error)),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.subscriptions.update(id, { enabled }),
    onSuccess: invalidate,
    onError: (error) => toast.error('Ошибка', errorText(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.subscriptions.remove(id),
    onSuccess: () => {
      toast.success('Подписка удалена');
      setDeleting(null);
      invalidate();
    },
    onError: (error) => toast.error('Не удалось удалить', errorText(error)),
  });

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Подписки</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Источники VPN-коннектов, из которых собираются прокси
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
          Добавить подписку
        </Button>
      </header>

      {lastReport ? <ReportCard report={lastReport} onClose={() => setLastReport(null)} /> : null}

      {subscriptions.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-6" />
        </div>
      ) : subscriptions.data?.subscriptions.length ? (
        <div className="grid gap-3">
          {subscriptions.data.subscriptions.map((subscription) => (
            <SubscriptionCard
              key={subscription.id}
              subscription={subscription}
              refreshing={refresh.isPending && refresh.variables === subscription.id}
              onRefresh={() => refresh.mutate(subscription.id)}
              onToggle={(enabled) => toggle.mutate({ id: subscription.id, enabled })}
              onEdit={() => {
                setEditing(subscription);
                setEditorOpen(true);
              }}
              onDelete={() => setDeleting(subscription)}
            />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<Cable className="size-8" />}
            title="Пока нет ни одной подписки"
            description="Добавь ссылку на VPN-подписку — панель разберёт её и выдаст по набору прокси на каждый коннект."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={openCreate}>
                Добавить подписку
              </Button>
            }
          />
        </Card>
      )}

      <SubscriptionEditor
        open={editorOpen}
        subscription={editing}
        onClose={() => setEditorOpen(false)}
        onSaved={(report) => {
          setEditorOpen(false);
          if (report) setLastReport(report);
          invalidate();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="Удалить подписку?"
        message={
          <>
            Будут удалены подписка «{deleting?.name}», все её коннекты и выданные прокси. Уже розданные адреса
            перестанут работать. Действие необратимо.
          </>
        }
        loading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function SubscriptionCard({
  subscription,
  refreshing,
  onRefresh,
  onToggle,
  onEdit,
  onDelete,
}: {
  subscription: Subscription;
  refreshing: boolean;
  onRefresh: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className={cn('p-4', !subscription.enabled && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{subscription.name}</h3>
            <Badge tone={subscription.sourceType === 'url' ? 'brand' : 'neutral'}>
              {subscription.sourceType === 'url' ? 'по ссылке' : 'текст'}
            </Badge>
            {subscription.detectedFormat ? <Badge>{subscription.detectedFormat}</Badge> : null}
            {subscription.hwid ? <Badge tone="brand">HWID</Badge> : null}
            {!subscription.enabled ? <Badge tone="warn">выключена</Badge> : null}
          </div>

          {subscription.source ? (
            <p className="mt-1 text-xs text-muted-foreground">
              источник: <span className="text-foreground">{subscription.source}</span>
            </p>
          ) : null}

          {subscription.url ? (
            <p className="mt-1.5 truncate font-mono text-xs text-muted-foreground" title={subscription.url}>
              {subscription.url}
            </p>
          ) : null}

          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              коннектов: <span className="text-foreground">{subscription.nodeCount}</span>
            </span>
            <span>обновлено {formatRelative(subscription.lastFetchedAt)}</span>
            <span>
              автообновление:{' '}
              {subscription.autoRefresh ? formatDuration(subscription.refreshIntervalMinutes) : 'выключено'}
            </span>
          </div>

          {subscription.lastError ? (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-danger">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              {subscription.lastError}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          <Toggle checked={subscription.enabled} onChange={onToggle} title="Включить или выключить" />
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={onRefresh} loading={refreshing}>
            Обновить
          </Button>
          <Button variant="ghost" size="icon" onClick={onEdit} title="Изменить" aria-label="Изменить">
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            title="Удалить"
            aria-label="Удалить"
            className="hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ReportCard({ report, onClose }: { report: RefreshReport; onClose: () => void }) {
  return (
    <Card
      title={`Результат обновления «${report.name}»`}
      action={
        <Button size="sm" variant="ghost" onClick={onClose}>
          скрыть
        </Button>
      }
    >
      <div className="grid gap-3 p-4 sm:grid-cols-4">
        <Metric label="Найдено коннектов" value={report.total} />
        <Metric label="Новых" value={report.added} tone="ok" />
        <Metric label="Пропало из подписки" value={report.missing} tone={report.missing > 0 ? 'warn' : 'neutral'} />
        <Metric label="Создано прокси" value={report.proxiesCreated} tone="brand" />
      </div>

      {report.warnings.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-xs font-medium text-warning">
            Пропущено строк: {report.warnings.length} — ядро sing-box их не поддерживает
          </p>
          <ul className="max-h-44 space-y-1 overflow-auto">
            {report.warnings.slice(0, 30).map((warning, index) => (
              <li key={index} className="text-xs text-muted-foreground">
                <span className="text-foreground">{warning.reason}</span>
                <span className="ml-1 font-mono opacity-70">{warning.input.slice(0, 60)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'ok' | 'warn' | 'brand';
}) {
  return (
    <div>
      <p
        className={cn(
          'text-xl font-semibold tabular-nums',
          tone === 'ok' && 'text-success',
          tone === 'warn' && 'text-warning',
          tone === 'brand' && 'text-primary',
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

// ─────────────────────────── Форма добавления ───────────────────────────

function SubscriptionEditor({
  open,
  subscription,
  onClose,
  onSaved,
}: {
  open: boolean;
  subscription: Subscription | null;
  onClose: () => void;
  onSaved: (report: RefreshReport | null) => void;
}) {
  const toast = useToast();
  const isEdit = subscription !== null;

  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [sourceType, setSourceType] = useState<'url' | 'raw'>('url');
  const [url, setUrl] = useState('');
  const [rawContent, setRawContent] = useState('');
  const [userAgent, setUserAgent] = useState('');
  const [hwid, setHwid] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [interval, setIntervalMinutes] = useState(360);
  const [initialised, setInitialised] = useState(false);

  // Форма переиспользуется для создания и правки: заполняем один раз на открытие.
  if (open && !initialised) {
    setName(subscription?.name ?? '');
    setSource(subscription?.source ?? '');
    setSourceType(subscription?.sourceType ?? 'url');
    setUrl(subscription?.url ?? '');
    setRawContent('');
    setUserAgent(subscription?.userAgent ?? '');
    setHwid(subscription?.hwid ?? '');
    setAutoRefresh(subscription?.autoRefresh ?? true);
    setIntervalMinutes(subscription?.refreshIntervalMinutes ?? 360);
    setInitialised(true);
  }
  if (!open && initialised) setInitialised(false);

  const save = useMutation({
    mutationFn: async () => {
      if (isEdit) {
        await api.subscriptions.update(subscription.id, {
          name,
          source,
          userAgent,
          hwid,
          autoRefresh,
          refreshIntervalMinutes: interval,
          ...(sourceType === 'url' ? { url } : { rawContent }),
        });
        const { report } = await api.subscriptions.refresh(subscription.id);
        return report;
      }

      const { report } = await api.subscriptions.create({
        name,
        source,
        sourceType,
        userAgent,
        hwid,
        autoRefresh,
        refreshIntervalMinutes: interval,
        ...(sourceType === 'url' ? { url } : { rawContent }),
      });
      return report;
    },
    onSuccess: (report) => {
      toast.success(
        isEdit ? 'Подписка обновлена' : 'Подписка добавлена',
        `${report.total} ${plural(report.total, 'коннект', 'коннекта', 'коннектов')}, создано прокси: ${report.proxiesCreated}`,
      );
      onSaved(report);
    },
    onError: (error) => toast.error('Не удалось сохранить', errorText(error)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={isEdit ? 'Изменить подписку' : 'Новая подписка'}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Отмена
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
            {isEdit ? 'Сохранить и обновить' : 'Добавить и загрузить'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Название">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Например: основная" />
          </Field>

          <Field label="Источник" hint="Просто заметка для себя — где куплено. В запросах не используется.">
            <Input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="Например: avtlk.ru, оплачено до 03.2027"
            />
          </Field>
        </div>

        {!isEdit ? (
          <div className="flex gap-2">
            {(['url', 'raw'] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setSourceType(type)}
                className={cn(
                  'flex-1 rounded-md border px-3 py-2 text-sm transition-colors',
                  sourceType === type
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-input hover:text-foreground',
                )}
              >
                {type === 'url' ? 'Ссылка на подписку' : 'Вставить содержимое'}
              </button>
            ))}
          </div>
        ) : null}

        {sourceType === 'url' ? (
          <Field
            label="Ссылка"
            hint="Панель сама определит формат: base64, список ссылок, JSON sing-box/Xray или YAML Clash."
          >
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/sub/xxxxx"
              className="font-mono text-xs"
            />
          </Field>
        ) : (
          <Field label="Содержимое подписки">
            <Textarea
              rows={7}
              value={rawContent}
              onChange={(event) => setRawContent(event.target.value)}
              placeholder="vless://...&#10;trojan://..."
            />
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="User-Agent"
            hint="Провайдеры отдают разный формат разным клиентам. Пусто — берётся значение из настроек."
          >
            <Input
              value={userAgent}
              onChange={(event) => setUserAgent(event.target.value)}
              placeholder="v2rayNG/1.8.23"
              className="font-mono text-xs"
            />
          </Field>

          <Field
            label="HWID"
            hint="Идентификатор устройства. Панели с привязкой к устройству без него отдают одну ноду-заглушку."
          >
            <div className="flex gap-2">
              <Input
                value={hwid}
                onChange={(event) => setHwid(event.target.value)}
                placeholder="11112222-3333-4444-5555-666677778888"
                className="font-mono text-xs"
              />
              <Button
                type="button"
                onClick={() => setHwid(crypto.randomUUID())}
                title="Сгенерировать идентификатор"
              >
                Создать
              </Button>
            </div>
          </Field>
        </div>

        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Эти значения уходят в запрос как заголовки{' '}
          <span className="font-mono text-foreground">User-Agent</span> и{' '}
          <span className="font-mono text-foreground">x-hwid</span> — формировать их вручную не нужно.
        </p>

        <div className="flex flex-wrap items-center gap-4">
          <Checkbox checked={autoRefresh} onChange={setAutoRefresh} label="Обновлять автоматически" />
          {autoRefresh ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              каждые
              <Input
                type="number"
                min={5}
                max={43200}
                value={interval}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                className="w-24"
              />
              минут
            </label>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

