import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Search,
  Trash2,
  Zap,
} from 'lucide-react';
import { api, type Proxy, type ProxyStatus, type VpnNode } from '../lib/api';
import { PROXY_KIND_LABELS, formatLatency, formatRelative, plural } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Toggle,
} from '../components/ui';
import { errorText, useToast } from '../components/toast';

const PAGE_SIZE = 40;

export function ProxiesPage() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [subscriptionId, setSubscriptionId] = useState('');
  const [status, setStatus] = useState<ProxyStatus | ''>('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Proxy | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const subscriptions = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions.list });

  const nodes = useQuery({
    queryKey: ['nodes', subscriptionId, search, status],
    queryFn: () =>
      api.nodes.list({
        ...(subscriptionId ? { subscriptionId } : {}),
        ...(search ? { search } : {}),
        ...(status ? { status } : {}),
      }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['nodes'] });
    void queryClient.invalidateQueries({ queryKey: ['system-status'] });
  };

  const allNodes = nodes.data?.nodes ?? [];
  const pageCount = Math.max(1, Math.ceil(allNodes.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleNodes = useMemo(
    () => allNodes.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE),
    [allNodes, currentPage],
  );

  const visibleProxyIds = useMemo(() => visibleNodes.flatMap((node) => node.proxies.map((proxy) => proxy.id)), [visibleNodes]);
  const allVisibleSelected = visibleProxyIds.length > 0 && visibleProxyIds.every((id) => selected.has(id));

  const toggleSelection = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleProxyIds.forEach((id) => next.delete(id));
      else visibleProxyIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const bulk = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: 'enable' | 'disable' | 'delete' | 'regenerate' | 'check' }) =>
      api.proxies.bulk(ids, action),
    onSuccess: (data, variables) => {
      if (variables.action === 'check' && data.summary) {
        toast.success('Проверка завершена', `Работают ${data.summary.ok} из ${data.summary.checked}`);
      } else if (variables.action === 'delete') {
        toast.success(`Удалено: ${data.deleted ?? 0}`);
        setSelected(new Set());
      } else {
        toast.success('Готово');
        if (variables.action === 'regenerate') setSelected(new Set());
      }
      setConfirmDelete(false);
      invalidate();
    },
    onError: (error) => toast.error('Ошибка', errorText(error)),
  });

  const toggleNode = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.nodes.update(id, { enabled }),
    onSuccess: invalidate,
    onError: (error) => toast.error('Ошибка', errorText(error)),
  });

  const toggleProxy = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.proxies.update(id, { enabled }),
    onSuccess: invalidate,
    onError: (error) => toast.error('Ошибка', errorText(error)),
  });

  const regenerate = useMutation({
    mutationFn: (id: string) => api.proxies.regenerate(id),
    onSuccess: () => {
      toast.success('Логин и пароль перевыпущены');
      invalidate();
    },
    onError: (error) => toast.error('Ошибка', errorText(error)),
  });

  const selectedIds = [...selected];

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-100">Прокси</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {nodes.data
              ? `${allNodes.length} ${plural(allNodes.length, 'коннект', 'коннекта', 'коннектов')}, ${allNodes.reduce((sum, node) => sum + node.proxies.length, 0)} прокси · хост ${nodes.data.host}`
              : 'загрузка…'}
          </p>
        </div>
        <ExportMenu subscriptionId={subscriptionId} />
      </header>

      <Card>
        <div className="flex flex-wrap gap-2 p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-600" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
              placeholder="Имя, сервер, логин или порт"
              className="pl-9"
            />
          </div>

          <Select
            value={subscriptionId}
            onChange={(event) => {
              setSubscriptionId(event.target.value);
              setPage(0);
            }}
            className="w-auto min-w-44"
          >
            <option value="">Все подписки</option>
            {subscriptions.data?.subscriptions.map((subscription) => (
              <option key={subscription.id} value={subscription.id}>
                {subscription.name}
              </option>
            ))}
          </Select>

          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as ProxyStatus | '');
              setPage(0);
            }}
            className="w-auto min-w-40"
          >
            <option value="">Любой статус</option>
            <option value="ok">Работают</option>
            <option value="fail">Не отвечают</option>
            <option value="unknown">Не проверены</option>
          </Select>
        </div>

        {selectedIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-ink-850 bg-ink-850/60 px-3 py-2.5">
            <span className="text-sm text-ink-300">
              Выбрано: <span className="font-medium text-ink-100">{selectedIds.length}</span>
            </span>
            <div className="flex-1" />
            <Button size="sm" icon={<Zap className="size-3.5" />} onClick={() => bulk.mutate({ ids: selectedIds, action: 'check' })} loading={bulk.isPending}>
              Проверить
            </Button>
            <Button size="sm" icon={<KeyRound className="size-3.5" />} onClick={() => bulk.mutate({ ids: selectedIds, action: 'regenerate' })}>
              Новые пароли
            </Button>
            <Button size="sm" onClick={() => bulk.mutate({ ids: selectedIds, action: 'enable' })}>
              Включить
            </Button>
            <Button size="sm" onClick={() => bulk.mutate({ ids: selectedIds, action: 'disable' })}>
              Выключить
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)}>
              Удалить
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Снять выбор
            </Button>
          </div>
        ) : null}
      </Card>

      {nodes.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-6" />
        </div>
      ) : allNodes.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Activity className="size-8" />}
            title="Прокси не найдены"
            description="Добавь подписку — из каждого VPN-коннекта будет создан набор прокси."
          />
        </Card>
      ) : (
        <>
          <div className="flex items-center gap-2 px-1">
            <Checkbox checked={allVisibleSelected} onChange={toggleAllVisible} label="Выбрать всё на странице" />
          </div>

          <div className="space-y-2.5">
            {visibleNodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selected={selected}
                revealed={revealed}
                onToggleSelect={toggleSelection}
                onToggleReveal={(id) =>
                  setRevealed((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onToggleNode={(enabled) => toggleNode.mutate({ id: node.id, enabled })}
                onToggleProxy={(id, enabled) => toggleProxy.mutate({ id, enabled })}
                onEdit={setEditing}
                onRegenerate={(id) => regenerate.mutate(id)}
              />
            ))}
          </div>

          {pageCount > 1 ? (
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} icon={<ChevronLeft className="size-4" />}>
                Назад
              </Button>
              <span className="text-sm text-ink-500">
                {currentPage + 1} из {pageCount}
              </span>
              <Button size="sm" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>
                Вперёд
                <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : null}
        </>
      )}

      <CredentialsEditor proxy={editing} onClose={() => setEditing(null)} onSaved={invalidate} />

      <ConfirmDialog
        open={confirmDelete}
        title="Удалить выбранные прокси?"
        message={`Будет удалено ${selectedIds.length} ${plural(selectedIds.length, 'прокси', 'прокси', 'прокси')}. Розданные адреса перестанут работать.`}
        loading={bulk.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => bulk.mutate({ ids: selectedIds, action: 'delete' })}
      />
    </div>
  );
}

function NodeCard({
  node,
  selected,
  revealed,
  onToggleSelect,
  onToggleReveal,
  onToggleNode,
  onToggleProxy,
  onEdit,
  onRegenerate,
}: {
  node: VpnNode;
  selected: Set<string>;
  revealed: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleReveal: (id: string) => void;
  onToggleNode: (enabled: boolean) => void;
  onToggleProxy: (id: string, enabled: boolean) => void;
  onEdit: (proxy: Proxy) => void;
  onRegenerate: (id: string) => void;
}) {
  return (
    <div className={`card overflow-hidden ${node.enabled ? '' : 'opacity-60'}`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-850 px-3 py-2.5">
        <Toggle checked={node.enabled} onChange={onToggleNode} title="Включить или выключить коннект" />
        <span className="min-w-0 truncate font-medium text-ink-100" title={node.name}>
          {node.name}
        </span>
        <Badge tone="brand">{node.protocol}</Badge>
        {!node.present ? <Badge tone="warn">нет в подписке</Badge> : null}
        <span className="truncate font-mono text-xs text-ink-500">
          {node.server}:{node.serverPort}
        </span>
        <div className="flex-1" />
        <span className="text-xs text-ink-600">{node.subscriptionName}</span>
      </header>

      <div className="divide-y divide-ink-850">
        {node.proxies.length === 0 ? (
          <p className="px-3 py-3 text-xs text-ink-600">Для этого коннекта ещё не создано ни одного прокси</p>
        ) : (
          node.proxies.map((proxy) => (
            <ProxyRow
              key={proxy.id}
              proxy={proxy}
              checked={selected.has(proxy.id)}
              revealed={revealed.has(proxy.id)}
              onToggleSelect={() => onToggleSelect(proxy.id)}
              onToggleReveal={() => onToggleReveal(proxy.id)}
              onToggleEnabled={(enabled) => onToggleProxy(proxy.id, enabled)}
              onEdit={() => onEdit(proxy)}
              onRegenerate={() => onRegenerate(proxy.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ProxyRow({
  proxy,
  checked,
  revealed,
  onToggleSelect,
  onToggleReveal,
  onToggleEnabled,
  onEdit,
  onRegenerate,
}: {
  proxy: Proxy;
  checked: boolean;
  revealed: boolean;
  onToggleSelect: () => void;
  onToggleReveal: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onRegenerate: () => void;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 ${proxy.enabled ? '' : 'opacity-55'}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggleSelect}
        className="size-4 shrink-0 cursor-pointer rounded border-ink-600 bg-ink-850 accent-brand-500"
      />

      <Badge className="w-16 justify-center">{PROXY_KIND_LABELS[proxy.kind] ?? proxy.kind}</Badge>

      <span className="w-40 shrink-0 font-mono text-xs text-ink-200">
        {proxy.host}:{proxy.port}
      </span>

      <span className="w-32 shrink-0 truncate font-mono text-xs text-ink-400" title={proxy.username}>
        {proxy.username}
      </span>

      <span className="flex w-40 shrink-0 items-center gap-1">
        <span className="truncate font-mono text-xs text-ink-400">
          {revealed ? proxy.password : '•'.repeat(12)}
        </span>
        <button
          type="button"
          onClick={onToggleReveal}
          className="shrink-0 text-ink-600 transition-colors hover:text-ink-300"
          title={revealed ? 'Скрыть пароль' : 'Показать пароль'}
        >
          {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </span>

      <StatusCell proxy={proxy} />

      <div className="flex-1" />

      <div className="flex shrink-0 items-center gap-0.5">
        <CopyButton value={proxy.url} title="Скопировать строку подключения" />
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex size-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-100"
          title="Изменить логин, пароль или порт"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onRegenerate}
          className="inline-flex size-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-100"
          title="Перевыпустить логин и пароль"
        >
          <KeyRound className="size-3.5" />
        </button>
        <Toggle checked={proxy.enabled} onChange={onToggleEnabled} title="Включить или выключить прокси" />
      </div>
    </div>
  );
}

function StatusCell({ proxy }: { proxy: Proxy }) {
  if (proxy.status === 'ok') {
    return (
      <span className="flex items-center gap-2 text-xs">
        <Badge tone="ok">{formatLatency(proxy.latencyMs)}</Badge>
        {proxy.exitIp ? <span className="font-mono text-ink-500">{proxy.exitIp}</span> : null}
      </span>
    );
  }

  if (proxy.status === 'fail') {
    return (
      <span className="flex items-center gap-2 text-xs" title={proxy.lastError ?? undefined}>
        <Badge tone="bad">не отвечает</Badge>
        <span className="max-w-56 truncate text-ink-600">{proxy.lastError}</span>
      </span>
    );
  }

  return (
    <span className="text-xs text-ink-600" title={`Последняя проверка: ${formatRelative(proxy.lastCheckedAt)}`}>
      не проверен
    </span>
  );
}

function ExportMenu({ subscriptionId }: { subscriptionId: string }) {
  const [open, setOpen] = useState(false);
  const [onlyOk, setOnlyOk] = useState(false);
  const [onlyEnabled, setOnlyEnabled] = useState(true);

  const download = (format: 'uri' | 'hostport' | 'json' | 'csv') => {
    const url = api.proxies.exportUrl({
      format,
      ...(subscriptionId ? { subscriptionId } : {}),
      onlyEnabled,
      onlyOk,
    });
    window.location.href = url;
    setOpen(false);
  };

  return (
    <>
      <Button icon={<Download className="size-4" />} onClick={() => setOpen(true)}>
        Экспорт
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Экспорт списка прокси">
        <div className="space-y-4">
          <div className="space-y-2">
            <Checkbox checked={onlyEnabled} onChange={setOnlyEnabled} label="Только включённые" />
            <Checkbox checked={onlyOk} onChange={setOnlyOk} label="Только прошедшие проверку" />
          </div>

          <div className="grid gap-2">
            <ExportOption
              title="Строки подключения"
              example="socks5://user:pass@1.2.3.4:20001"
              onClick={() => download('uri')}
            />
            <ExportOption title="host:port:логин:пароль" example="1.2.3.4:20001:user:pass" onClick={() => download('hostport')} />
            <ExportOption title="JSON" example="со статусом, задержкой и внешним IP" onClick={() => download('json')} />
            <ExportOption title="CSV" example="для таблиц" onClick={() => download('csv')} />
          </div>
        </div>
      </Modal>
    </>
  );
}

function ExportOption({ title, example, onClick }: { title: string; example: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-ink-700 px-3 py-2.5 text-left transition-colors hover:border-brand-500 hover:bg-brand-500/5"
    >
      <p className="text-sm font-medium text-ink-100">{title}</p>
      <p className="mt-0.5 font-mono text-xs text-ink-500">{example}</p>
    </button>
  );
}

function CredentialsEditor({ proxy, onClose, onSaved }: { proxy: Proxy | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState(0);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (proxy && loadedFor !== proxy.id) {
    setUsername(proxy.username);
    setPassword(proxy.password);
    setPort(proxy.port);
    setLoadedFor(proxy.id);
  }
  if (!proxy && loadedFor !== null) setLoadedFor(null);

  const save = useMutation({
    mutationFn: () => {
      if (!proxy) throw new Error('Прокси не выбран');
      return api.proxies.update(proxy.id, { username, password, port });
    },
    onSuccess: () => {
      toast.success('Сохранено');
      onSaved();
      onClose();
    },
    onError: (error) => toast.error('Не удалось сохранить', errorText(error)),
  });

  return (
    <Modal
      open={proxy !== null}
      onClose={onClose}
      title={proxy ? `${PROXY_KIND_LABELS[proxy.kind] ?? proxy.kind} · порт ${proxy.port}` : ''}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Отмена
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Логин">
          <Input value={username} onChange={(event) => setUsername(event.target.value)} className="font-mono text-xs" />
        </Field>
        <Field label="Пароль">
          <Input value={password} onChange={(event) => setPassword(event.target.value)} className="font-mono text-xs" />
        </Field>
        <Field label="Порт" hint="Должен входить в диапазон из настроек и быть свободен.">
          <Input type="number" value={port} onChange={(event) => setPort(Number(event.target.value))} className="font-mono text-xs" />
        </Field>
      </div>
    </Modal>
  );
}
