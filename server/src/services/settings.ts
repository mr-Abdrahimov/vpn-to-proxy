import { z } from 'zod';
import { env } from '../config/env.js';
import { PROXY_KINDS, SettingModel, type ProxyKind } from '../db/models.js';
import { encryptSecret, tryDecryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

/**
 * Настройки рантайма. Переменные окружения задают только начальные значения:
 * дальше пользователь правит их в панели, и источником истины становится БД.
 */

const proxyKindEnum = z.enum(PROXY_KINDS as unknown as [ProxyKind, ...ProxyKind[]]);

export const appSettingsSchema = z.object({
  /** Хост/IP в выдаваемых строках прокси. Пусто — определяем внешний IP сами. */
  publicHost: z.string().trim().default(''),
  /** Интерфейс, на котором sing-box слушает прокси-порты. */
  proxyListen: z.string().trim().min(1).default('0.0.0.0'),
  portRangeStart: z.number().int().min(1024).max(65535),
  portRangeEnd: z.number().int().min(1024).max(65535),
  /** Какие виды прокси создавать для новых нод. */
  defaultProxyKinds: z.array(proxyKindEnum).min(1).default(['socks5', 'http']),

  /**
   * Откуда брать сертификат для HTTPS-прокси:
   *   self-signed — панель выпускает собственный CA и подписывает им сертификат;
   *   custom      — PEM вставлены руками в настройках;
   *   files       — читать из файлов на диске (сюда смотрит certbot/Let's Encrypt).
   */
  tlsMode: z.enum(['self-signed', 'custom', 'files']).default('self-signed'),
  /** Имя в сертификате для HTTPS-прокси (CN/SAN). */
  tlsCommonName: z.string().trim().default(''),
  tlsCertPem: z.string().default(''),
  /** Хранится зашифрованным. */
  tlsKeyPem: z.string().default(''),
  /** Пути внутри контейнера для режима files. */
  tlsCertFile: z.string().trim().default(''),
  tlsKeyFile: z.string().trim().default(''),

  subscriptionRefreshMinutes: z.number().int().min(0).max(43200),
  healthcheckMinutes: z.number().int().min(0).max(1440),
  // Только https: проверка идёт через CONNECT, и это единственный метод,
  // который одинаково работает и для SOCKS5, и для HTTP, и для HTTPS-прокси.
  healthcheckUrl: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), 'URL проверки должен начинаться с https://'),
  healthcheckConcurrency: z.number().int().min(1).max(64).default(8),
  healthcheckTimeoutMs: z.number().int().min(1000).max(60000).default(12000),

  /**
   * User-Agent при загрузке подписки. Многие провайдеры отдают разный формат
   * в зависимости от него: под клиентский UA приходит base64 со ссылками,
   * под «браузерный» — HTML-страница.
   */
  subscriptionUserAgent: z.string().trim().min(1).default('Happ/4.13.0/macos catalyst/2606221804589'),

  /**
   * Идентификатор устройства (заголовок x-hwid).
   *
   * Панели с привязкой к устройству (Remnawave и подобные) без него отдают
   * одну ноду-заглушку вида «❌ Нужен HWID» вместо полного списка. Значение
   * берётся из настроек, но каждая подписка может переопределить его своими
   * заголовками.
   */
  subscriptionHwid: z.string().trim().default('wfl2vh3p3hzgb0lr'),

  singboxLogLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic']).default('info'),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const SETTINGS_ID = 'app';

function defaultsFromEnv(): AppSettings {
  return appSettingsSchema.parse({
    publicHost: env.PUBLIC_HOST ?? '',
    proxyListen: env.PROXY_LISTEN,
    portRangeStart: env.PROXY_PORT_START,
    portRangeEnd: env.PROXY_PORT_END,
    defaultProxyKinds: ['socks5', 'http'],
    tlsMode: 'self-signed',
    tlsCommonName: '',
    tlsCertPem: '',
    tlsKeyPem: '',
    tlsCertFile: '',
    tlsKeyFile: '',
    subscriptionRefreshMinutes: env.SUBSCRIPTION_REFRESH_MINUTES,
    healthcheckMinutes: env.HEALTHCHECK_MINUTES,
    healthcheckUrl: env.HEALTHCHECK_URL,
    healthcheckConcurrency: 8,
    healthcheckTimeoutMs: 12000,
    subscriptionUserAgent: env.SUBSCRIPTION_USER_AGENT ?? 'Happ/4.13.0/macos catalyst/2606221804589',
    subscriptionHwid: env.SUBSCRIPTION_HWID ?? 'wfl2vh3p3hzgb0lr',
    singboxLogLevel: 'info',
  });
}

let cache: AppSettings | null = null;

/** Читает настройки из БД, создавая документ со значениями из окружения при первом запуске. */
export async function loadSettings(): Promise<AppSettings> {
  const stored = await SettingModel.findById(SETTINGS_ID).lean();

  if (!stored) {
    const defaults = defaultsFromEnv();
    await SettingModel.updateOne(
      { _id: SETTINGS_ID },
      { $set: { value: serialize(defaults) } },
      { upsert: true },
    );
    cache = defaults;
    return defaults;
  }

  // Слияние с дефолтами: после обновления панели в документе может не хватать
  // новых полей — schema.parse их доставит.
  const merged = appSettingsSchema.safeParse({ ...defaultsFromEnv(), ...(stored.value as object) });
  if (!merged.success) {
    logger.warn({ issues: merged.error.issues }, 'настройки в БД повреждены, используются значения по умолчанию');
    cache = defaultsFromEnv();
    return cache;
  }

  cache = deserialize(merged.data);
  return cache;
}

export function getSettings(): AppSettings {
  if (!cache) throw new Error('Настройки ещё не загружены: вызови loadSettings() при старте');
  return cache;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = appSettingsSchema.parse({ ...getSettings(), ...patch });

  if (next.portRangeEnd <= next.portRangeStart) {
    throw new Error('Конец диапазона портов должен быть больше начала');
  }

  await SettingModel.updateOne({ _id: SETTINGS_ID }, { $set: { value: serialize(next) } }, { upsert: true });
  cache = next;
  return next;
}

/** Приватный ключ TLS не должен лежать в базе открытым текстом. */
function serialize(settings: AppSettings): AppSettings {
  return { ...settings, tlsKeyPem: settings.tlsKeyPem ? encryptSecret(settings.tlsKeyPem) : '' };
}

function deserialize(settings: AppSettings): AppSettings {
  return { ...settings, tlsKeyPem: tryDecryptSecret(settings.tlsKeyPem) };
}

// ─────────────────────── Определение публичного адреса ───────────────────────

let cachedPublicIp: { value: string; at: number } | null = null;
const PUBLIC_IP_TTL_MS = 60 * 60 * 1000;

/**
 * Хост, который подставляется в выдаваемые строки прокси.
 * Если пользователь не задал его явно, один раз в час спрашиваем внешний IP.
 */
export async function resolvePublicHost(): Promise<string> {
  const configured = getSettings().publicHost.trim();
  if (configured) return configured;

  if (cachedPublicIp && Date.now() - cachedPublicIp.at < PUBLIC_IP_TTL_MS) {
    return cachedPublicIp.value;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
    clearTimeout(timer);

    const payload = (await response.json()) as { ip?: string };
    if (payload.ip) {
      cachedPublicIp = { value: payload.ip, at: Date.now() };
      return payload.ip;
    }
  } catch (error) {
    logger.debug({ err: error }, 'не удалось определить внешний IP');
  }

  return '127.0.0.1';
}
