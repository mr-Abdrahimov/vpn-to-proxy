import { ProxyEndpointModel, SubscriptionModel, VpnNodeModel } from '../db/models.js';
import { buildSingBoxConfig, type ProxyBinding } from '../core/singbox/config.js';
import { SingBoxConfigError, singbox } from '../core/singbox/supervisor.js';
import { ensureProxyCertificate } from '../core/tls.js';
import type { SingBoxOutbound } from '../core/parsers/types.js';
import { tryDecryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { recordEvent } from './events.js';
import { getSettings } from './settings.js';

/**
 * Мост между базой и ядром: собирает актуальный набор «прокси → нода» и
 * скармливает его супервизору.
 *
 * Изменения в UI сыплются пачками (добавили подписку — появилось 40 нод и
 * 120 прокси), поэтому синхронизация склеивается по таймеру: один перезапуск
 * sing-box на всю пачку вместо ста подряд.
 */

const DEBOUNCE_MS = 600;

let debounceTimer: NodeJS.Timeout | null = null;
let pendingReasons = new Set<string>();
let running: Promise<SyncResult> | null = null;
let rerunRequested = false;
let lastError: { message: string; output?: string; at: string } | null = null;

export interface SyncResult {
  changed: boolean;
  bindings: number;
  error?: string;
}

/** Немедленная синхронизация. Параллельные вызовы разделяют один прогон. */
export async function syncSingBox(reason: string): Promise<SyncResult> {
  if (running) {
    // Пока идёт синхронизация, состояние БД могло снова измениться —
    // помечаем, что по завершении нужен ещё один проход.
    rerunRequested = true;
    return running;
  }

  running = performSync(reason).finally(() => {
    running = null;
    if (rerunRequested) {
      rerunRequested = false;
      scheduleSync('отложенные изменения');
    }
  });

  return running;
}

/** Отложенная синхронизация со склейкой: используется всеми мутирующими ручками. */
export function scheduleSync(reason: string): void {
  pendingReasons.add(reason);
  if (debounceTimer) return;

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const reasons = [...pendingReasons].join(', ');
    pendingReasons = new Set();
    void syncSingBox(reasons).catch((error: unknown) => {
      logger.error({ err: error }, 'фоновая синхронизация sing-box не удалась');
    });
  }, DEBOUNCE_MS);
}

export function getLastSyncError(): typeof lastError {
  return lastError;
}

async function performSync(reason: string): Promise<SyncResult> {
  try {
    const bindings = await collectBindings();
    const settings = getSettings();

    const needsTls = bindings.some((binding) => binding.kind === 'https');
    const tls = needsTls ? await ensureProxyCertificate() : undefined;

    const config = buildSingBoxConfig({
      bindings,
      listen: settings.proxyListen,
      logLevel: settings.singboxLogLevel,
      ...(tls ? { tls: { certificatePath: tls.certPath, keyPath: tls.keyPath } } : {}),
    });

    const changed = await singbox.apply(config, bindings.length);
    lastError = null;

    if (changed) {
      recordEvent('info', 'sing-box', `Конфигурация применена: ${bindings.length} прокси (${reason})`, {
        bindings: bindings.length,
      });
    }

    return { changed, bindings: bindings.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output = error instanceof SingBoxConfigError ? error.output : undefined;

    lastError = { message, at: new Date().toISOString(), ...(output ? { output } : {}) };
    recordEvent('error', 'sing-box', `Не удалось применить конфигурацию: ${message}`, output ? { output } : undefined);

    return { changed: false, bindings: 0, error: message };
  }
}

/**
 * Прокси попадает в конфиг, если включён он сам, его нода и её подписка.
 * Ноды, пропавшие из подписки (present=false), намеренно НЕ исключаются:
 * провайдер мог отдать неполный ответ, и молча гасить рабочие прокси хуже,
 * чем оставить их и показать метку в интерфейсе.
 */
async function collectBindings(): Promise<ProxyBinding[]> {
  const disabledSubscriptions = await SubscriptionModel.find({ enabled: false }).distinct('_id');

  const nodes = await VpnNodeModel.find({
    enabled: true,
    ...(disabledSubscriptions.length > 0 ? { subscription: { $nin: disabledSubscriptions } } : {}),
  })
    .select({ _id: 1, name: 1, outboundJson: 1 })
    .lean();

  if (nodes.length === 0) return [];

  const nodeById = new Map(nodes.map((node) => [String(node._id), node]));

  const proxies = await ProxyEndpointModel.find({
    enabled: true,
    node: { $in: nodes.map((node) => node._id) },
  })
    .sort({ port: 1 })
    .lean();

  const bindings: ProxyBinding[] = [];

  for (const proxy of proxies) {
    const node = nodeById.get(String(proxy.node));
    if (!node) continue;

    const outbound = parseOutbound(node.outboundJson);
    if (!outbound) {
      recordEvent('warn', 'sing-box', `Нода «${node.name}» пропущена: не читается сохранённый outbound`);
      continue;
    }

    bindings.push({
      proxyId: String(proxy._id),
      kind: proxy.kind,
      port: proxy.port,
      username: proxy.username,
      password: tryDecryptSecret(proxy.password),
      nodeId: String(node._id),
      nodeName: node.name,
      outbound,
    });
  }

  return bindings;
}

function parseOutbound(encrypted: string): SingBoxOutbound | null {
  try {
    const json = tryDecryptSecret(encrypted);
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as SingBoxOutbound;
    }
    return null;
  } catch {
    return null;
  }
}
