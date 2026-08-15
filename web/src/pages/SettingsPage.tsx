import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Save, ShieldCheck } from 'lucide-react';
import { api, type ProxyKind, type Settings, type User } from '../lib/api';
import { PROXY_KIND_LABELS } from '../lib/format';
import { Button, Card, Checkbox, Field, Input, Select, Spinner, Textarea } from '../components/ui';
import { errorText, useToast } from '../components/toast';

const KINDS: ProxyKind[] = ['socks5', 'http', 'https'];

export function SettingsPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const query = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  const [draft, setDraft] = useState<Settings | null>(null);
  const [tlsKeyInput, setTlsKeyInput] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Черновик инициализируем один раз, иначе ввод «прыгал» бы при каждом
  // фоновом обновлении запроса.
  if (query.data && !loaded) {
    setDraft(query.data.settings);
    setLoaded(true);
  }

  const save = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('Настройки ещё не загружены');
      const { tlsKeyConfigured, ...rest } = draft;
      void tlsKeyConfigured;
      return api.settings.update({ ...rest, ...(tlsKeyInput.trim() ? { tlsKeyPem: tlsKeyInput } : {}) });
    },
    onSuccess: (data) => {
      setDraft(data.settings);
      setTlsKeyInput('');
      toast.success('Настройки сохранены');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['system-status'] });
      void queryClient.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (error) => toast.error('Не удалось сохранить', errorText(error)),
  });

  if (query.isPending || !draft) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-6" />
      </div>
    );
  }

  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const toggleKind = (kind: ProxyKind) => {
    const next = draft.defaultProxyKinds.includes(kind)
      ? draft.defaultProxyKinds.filter((item) => item !== kind)
      : [...draft.defaultProxyKinds, kind];
    if (next.length > 0) patch('defaultProxyKinds', next);
  };

  return (
    <div className="max-w-3xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Настройки</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Внешний адрес определён как <span className="font-mono text-foreground">{query.data?.resolvedPublicHost}</span>
          </p>
        </div>
        <Button variant="primary" icon={<Save className="size-4" />} onClick={() => save.mutate()} loading={save.isPending}>
          Сохранить
        </Button>
      </header>

      <Card title="Раздача прокси">
        <div className="space-y-4 p-4">
          <Field
            label="Публичный хост"
            hint="Подставляется в выдаваемые строки подключения. Пусто — панель определит внешний IP сама."
          >
            <Input
              value={draft.publicHost}
              onChange={(event) => patch('publicHost', event.target.value)}
              placeholder="например, vtp.avtlk.ru"
            />
          </Field>

          <Field
            label="Интерфейс прослушивания"
            hint="0.0.0.0 — прокси доступны снаружи; 127.0.0.1 — только с самого сервера."
          >
            <Input
              value={draft.proxyListen}
              onChange={(event) => patch('proxyListen', event.target.value)}
              className="font-mono text-xs"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Порты: начало">
              <Input
                type="number"
                value={draft.portRangeStart}
                onChange={(event) => patch('portRangeStart', Number(event.target.value))}
              />
            </Field>
            <Field label="Порты: конец" hint="Диапазон должен быть открыт в фаерволе.">
              <Input
                type="number"
                value={draft.portRangeEnd}
                onChange={(event) => patch('portRangeEnd', Number(event.target.value))}
              />
            </Field>
          </div>

          <div>
            <span className="label">Виды прокси для новых коннектов</span>
            <div className="flex flex-wrap gap-4">
              {KINDS.map((kind) => (
                <Checkbox
                  key={kind}
                  checked={draft.defaultProxyKinds.includes(kind)}
                  onChange={() => toggleKind(kind)}
                  label={PROXY_KIND_LABELS[kind] ?? kind}
                />
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Каждый вид занимает отдельный порт. Три вида на 300 коннектов — это 900 портов.
            </p>
          </div>
        </div>
      </Card>

      <Card title="Загрузка подписок">
        <div className="space-y-4 p-4">
          <Field
            label="User-Agent"
            hint="Провайдеры отдают разный формат в зависимости от него: под клиентский UA приходит список ссылок, под браузерный — HTML."
          >
            <Input
              value={draft.subscriptionUserAgent}
              onChange={(event) => patch('subscriptionUserAgent', event.target.value)}
              className="font-mono text-xs"
            />
          </Field>

          <Field
            label="HWID (заголовок x-hwid)"
            hint="Панели с привязкой к устройству без него отдают одну ноду-заглушку вместо полного списка. Отдельная подписка может переопределить значение своими заголовками."
          >
            <Input
              value={draft.subscriptionHwid}
              onChange={(event) => patch('subscriptionHwid', event.target.value)}
              className="font-mono text-xs"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Автообновление, минут" hint="0 — выключить автообновление.">
              <Input
                type="number"
                value={draft.subscriptionRefreshMinutes}
                onChange={(event) => patch('subscriptionRefreshMinutes', Number(event.target.value))}
              />
            </Field>

            <Field
              label="Таймаут подключения, мс"
              hint="Сколько ждать ответа от сервера подписки. Большие списки отдаются медленно — 30 000 обычно достаточно."
            >
              <Input
                type="number"
                min={2000}
                max={300000}
                step={1000}
                value={draft.subscriptionTimeoutMs}
                onChange={(event) => patch('subscriptionTimeoutMs', Number(event.target.value))}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Проверка работоспособности">
        <div className="space-y-4 p-4">
          <Field label="Интервал проверки, минут" hint="0 — только вручную.">
            <Input
              type="number"
              value={draft.healthcheckMinutes}
              onChange={(event) => patch('healthcheckMinutes', Number(event.target.value))}
            />
          </Field>

          <Field label="URL для проверки" hint="Только https. Ответ используется для определения внешнего IP.">
            <Input
              value={draft.healthcheckUrl}
              onChange={(event) => patch('healthcheckUrl', event.target.value)}
              className="font-mono text-xs"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Одновременных проверок">
              <Input
                type="number"
                value={draft.healthcheckConcurrency}
                onChange={(event) => patch('healthcheckConcurrency', Number(event.target.value))}
              />
            </Field>
            <Field label="Таймаут проверки, мс">
              <Input
                type="number"
                value={draft.healthcheckTimeoutMs}
                onChange={(event) => patch('healthcheckTimeoutMs', Number(event.target.value))}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Сертификат для HTTPS-прокси">
        <div className="space-y-4 p-4">
          <Field
            label="Режим"
            hint={
              draft.tlsMode === 'self-signed'
                ? 'Панель выпускает собственный CA. Скачай его и добавь в доверенные — тогда HTTPS-прокси работает без отключения проверки сертификата.'
                : draft.tlsMode === 'files'
                  ? 'Сертификат читается с диска и обновляется снаружи, например certbot’ом. После продления ядро перезапускается автоматически.'
                  : 'Сертификат и ключ вставлены сюда вручную.'
            }
          >
            <Select
              value={draft.tlsMode}
              onValueChange={(value) => patch('tlsMode', value as Settings['tlsMode'])}
              items={[
                { value: 'self-signed', label: 'Самоподписанный (свой CA)' },
                { value: 'files', label: 'Файлы на диске (Let’s Encrypt)' },
                { value: 'custom', label: 'Вставить PEM вручную' },
              ]}
            />
          </Field>

          {draft.tlsMode === 'files' ? (
            <div className="grid gap-4">
              <Field label="Путь к сертификату" hint="Путь внутри контейнера, вместе с цепочкой (fullchain.pem).">
                <Input
                  value={draft.tlsCertFile}
                  onChange={(event) => patch('tlsCertFile', event.target.value)}
                  placeholder="/etc/letsencrypt/live/example.com/fullchain.pem"
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="Путь к приватному ключу">
                <Input
                  value={draft.tlsKeyFile}
                  onChange={(event) => patch('tlsKeyFile', event.target.value)}
                  placeholder="/etc/letsencrypt/live/example.com/privkey.pem"
                  className="font-mono text-xs"
                />
              </Field>
            </div>
          ) : draft.tlsMode === 'self-signed' ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1">
                <Field label="Имя в сертификате" hint="Домен, по которому клиенты обращаются к прокси.">
                  <Input value={draft.tlsCommonName} onChange={(event) => patch('tlsCommonName', event.target.value)} />
                </Field>
              </div>
              <a href={api.settings.caUrl} download>
                <Button icon={<Download className="size-4" />}>Скачать CA</Button>
              </a>
            </div>
          ) : (
            <>
              <Field label="Сертификат (PEM, вместе с цепочкой)">
                <Textarea
                  rows={5}
                  value={draft.tlsCertPem}
                  onChange={(event) => patch('tlsCertPem', event.target.value)}
                  placeholder="-----BEGIN CERTIFICATE-----"
                />
              </Field>
              <Field
                label="Приватный ключ (PEM)"
                hint={draft.tlsKeyConfigured ? 'Ключ уже сохранён. Оставь поле пустым, чтобы не менять его.' : undefined}
              >
                <Textarea
                  rows={5}
                  value={tlsKeyInput}
                  onChange={(event) => setTlsKeyInput(event.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                />
              </Field>
            </>
          )}
        </div>
      </Card>

      <Card title="Журналирование ядра">
        <div className="p-4">
          <Field label="Уровень логов sing-box">
            <Select
              value={draft.singboxLogLevel}
              onValueChange={(value) => patch('singboxLogLevel', value)}
              items={['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic'].map((level) => ({
                value: level,
                label: level,
              }))}
            />
          </Field>
        </div>
      </Card>

      <AccountCard user={user} />
    </div>
  );
}

function AccountCard({ user }: { user: User }) {
  const toast = useToast();
  const [username, setUsername] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const saveUsername = useMutation({
    mutationFn: () => api.auth.changeUsername(username),
    onSuccess: () => toast.success('Логин изменён'),
    onError: (error) => toast.error('Не удалось изменить логин', errorText(error)),
  });

  const savePassword = useMutation({
    mutationFn: () => api.auth.changePassword(currentPassword, newPassword),
    onSuccess: () => {
      toast.success('Пароль изменён', 'Все сессии завершены — нужно войти заново');
      window.setTimeout(() => window.location.reload(), 1500);
    },
    onError: (error) => toast.error('Не удалось изменить пароль', errorText(error)),
  });

  return (
    <Card title="Учётная запись">
      <div className="space-y-4 p-4">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="Логин">
              <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </Field>
          </div>
          <Button onClick={() => saveUsername.mutate()} loading={saveUsername.isPending}>
            Изменить
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Текущий пароль">
            <Input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <Field label="Новый пароль" hint="Минимум 8 символов.">
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </Field>
        </div>

        <Button
          icon={<ShieldCheck className="size-4" />}
          onClick={() => savePassword.mutate()}
          loading={savePassword.isPending}
          disabled={!currentPassword || newPassword.length < 8}
        >
          Сменить пароль
        </Button>
      </div>
    </Card>
  );
}
