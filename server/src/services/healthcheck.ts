import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyEndpointModel, type IProxyEndpoint } from '../db/models.js';
import { tryDecryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { recordEvent } from './events.js';
import { getSettings } from './settings.js';

/**
 * Проверка живости прокси: ходим через каждый из них на внешний URL, меряем
 * задержку и запоминаем IP, с которого нас видит мир. Это единственный способ
 * убедиться, что цепочка «клиент → прокси → VPN-нода → интернет» действительно
 * собрана: конфиг может быть валидным, а нода — мёртвой.
 *
 * Используется node:https с прокси-агентами, а не fetch: undici не принимает
 * произвольные агенты, а SOCKS5 без агента не сделать.
 */

export interface CheckResult {
  ok: boolean;
  latencyMs: number | null;
  exitIp: string | null;
  error: string | null;
}

export interface HealthcheckSummary {
  checked: number;
  ok: number;
  failed: number;
}

let running = false;

export function isHealthcheckRunning(): boolean {
  return running;
}

/**
 * Проверяет указанные прокси (или все включённые) и записывает результат.
 * Параллельность ограничена, чтобы не открыть разом сотни соединений.
 */
export async function runHealthchecks(ids?: string[]): Promise<HealthcheckSummary> {
  if (running) throw new Error('Проверка уже выполняется');
  running = true;

  try {
    const filter = ids && ids.length > 0 ? { _id: { $in: ids } } : { enabled: true };
    const proxies = await ProxyEndpointModel.find(filter).lean();

    const settings = getSettings();
    const summary: HealthcheckSummary = { checked: proxies.length, ok: 0, failed: 0 };

    await forEachWithLimit(proxies, settings.healthcheckConcurrency, async (proxy) => {
      const result = await checkProxy(proxy, settings.healthcheckUrl, settings.healthcheckTimeoutMs);

      if (result.ok) summary.ok += 1;
      else summary.failed += 1;

      await ProxyEndpointModel.updateOne(
        { _id: proxy._id },
        {
          $set: {
            status: result.ok ? 'ok' : 'fail',
            latencyMs: result.latencyMs,
            exitIp: result.exitIp,
            lastError: result.error,
            lastCheckedAt: new Date(),
          },
        },
      );
    });

    recordEvent(
      summary.failed > 0 ? 'warn' : 'info',
      'healthcheck',
      `Проверка завершена: ${summary.ok} из ${summary.checked} работают`,
      { ...summary },
    );

    return summary;
  } finally {
    running = false;
  }
}

/** Один прокси: подключиться, дождаться ответа, вернуть задержку и внешний IP. */
export async function checkProxy(
  proxy: Pick<IProxyEndpoint, 'kind' | 'port' | 'username' | 'password'>,
  targetUrl: string,
  timeoutMs: number,
): Promise<CheckResult> {
  const password = tryDecryptSecret(proxy.password);
  const auth = `${encodeURIComponent(proxy.username)}:${encodeURIComponent(password)}`;

  // Прокси слушает на всех интерфейсах, но проверяем через localhost:
  // так тест не зависит от внешней сети, фаервола и NAT.
  const endpoint = `127.0.0.1:${proxy.port}`;

  let agent: https.Agent;
  switch (proxy.kind) {
    case 'socks5':
      agent = new SocksProxyAgent(`socks5h://${auth}@${endpoint}`, { timeout: timeoutMs });
      break;
    case 'http':
      agent = new HttpsProxyAgent(`http://${auth}@${endpoint}`, { timeout: timeoutMs });
      break;
    case 'https':
      // Сертификат прокси может быть самоподписанным нашим же CA — проверять
      // его здесь незачем, мы стучимся на 127.0.0.1 в собственный процесс.
      agent = new HttpsProxyAgent(`https://${auth}@${endpoint}`, { timeout: timeoutMs, rejectUnauthorized: false });
      break;
  }

  const startedAt = Date.now();

  try {
    const body = await request(targetUrl, agent, timeoutMs);
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      exitIp: extractIp(body),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      exitIp: null,
      error: describeError(error),
    };
  } finally {
    agent.destroy();
  }
}

function request(targetUrl: string, agent: https.Agent, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(targetUrl, { agent, timeout: timeoutMs, method: 'GET' }, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        reject(new Error(`целевой сайт ответил ${res.statusCode ?? '?'}`));
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        // Ответ ожидается крошечный; ограничение — защита от «бесконечного» тела.
        if (data.length < 4096) data += chunk;
      });
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => {
      req.destroy(new Error(`нет ответа за ${Math.round(timeoutMs / 1000)} с`));
    });
    req.on('error', reject);
    req.end();
  });
}

function extractIp(body: string): string | null {
  const trimmed = body.trim();

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['ip', 'origin', 'query', 'YourFuckingIPAddress']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim().split(',')[0]?.trim() ?? null;
      }
    }
  } catch {
    // Не JSON — ниже разберём как обычный текст.
  }

  const match = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/i.exec(trimmed);
  return match?.[0] ?? null;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ECONNREFUSED':
      return 'порт не слушается — sing-box не запущен или прокси выключен';
    case 'ECONNRESET':
      return 'соединение сброшено — нода недоступна или отвергла подключение';
    case 'ETIMEDOUT':
      return 'таймаут подключения к ноде';
    default:
      return error.message;
  }
}

/** Простой пул: не более `limit` одновременных проверок. */
async function forEachWithLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, queue.length));

  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        try {
          await worker(item);
        } catch (error) {
          logger.warn({ err: error }, 'ошибка внутри health-check');
        }
      }
    }),
  );
}
