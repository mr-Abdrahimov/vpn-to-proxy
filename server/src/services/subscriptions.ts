import { Types } from 'mongoose';
import { parseSubscriptionContent, type ParseWarning } from '../core/parsers/index.js';
import {
  ProxyEndpointModel,
  SubscriptionModel,
  VpnNodeModel,
  type ISubscription,
  type SubscriptionSource,
} from '../db/models.js';
import { encryptSecret, tryDecryptSecret } from '../lib/crypto.js';
import { recordEvent } from './events.js';
import { ensureProxiesForNodes } from './proxies.js';
import { getSettings } from './settings.js';
import { scheduleSync } from './singbox-sync.js';

/**
 * Жизненный цикл подписки: загрузка → разбор → сверка с тем, что уже в базе.
 *
 * Ключевая идея сверки — отпечаток ноды (fingerprint). Провайдеры регулярно
 * переставляют ноды местами и переименовывают их, поэтому сопоставлять по
 * позиции или имени нельзя: пользователь каждый раз получал бы новые порты
 * и пароли. По отпечатку же «та же» нода узнаётся и сохраняет свои прокси.
 */

const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

/** Заголовки, которые нельзя переопределять через пользовательские: сломают запрос. */

export interface RefreshReport {
  subscriptionId: string;
  name: string;
  format: string;
  total: number;
  added: number;
  updated: number;
  /** Ноды, которых больше нет в подписке (помечены, но не удалены). */
  missing: number;
  proxiesCreated: number;
  warnings: ParseWarning[];
}

export interface SubscriptionDto {
  id: string;
  name: string;
  source: string | null;
  sourceType: SubscriptionSource;
  url: string | null;
  userAgent: string | null;
  hwid: string | null;
  detectedFormat: string | null;
  enabled: boolean;
  autoRefresh: boolean;
  refreshIntervalMinutes: number;
  lastFetchedAt: string | null;
  lastError: string | null;
  nodeCount: number;
  createdAt: string;
}

export function toSubscriptionDto(sub: ISubscription): SubscriptionDto {
  return {
    id: String(sub._id),
    name: sub.name,
    source: sub.source,
    sourceType: sub.sourceType,
    url: sub.url ? tryDecryptSecret(sub.url) : null,
    userAgent: sub.userAgent,
    hwid: sub.hwid ? tryDecryptSecret(sub.hwid) : null,
    detectedFormat: sub.detectedFormat,
    enabled: sub.enabled,
    autoRefresh: sub.autoRefresh,
    refreshIntervalMinutes: sub.refreshIntervalMinutes,
    lastFetchedAt: sub.lastFetchedAt ? sub.lastFetchedAt.toISOString() : null,
    lastError: sub.lastError,
    nodeCount: sub.nodeCount,
    createdAt: sub.createdAt.toISOString(),
  };
}

// ─────────────────────────────── CRUD ───────────────────────────────

export interface CreateSubscriptionInput {
  name: string;
  source?: string;
  sourceType: SubscriptionSource;
  url?: string;
  rawContent?: string;
  userAgent?: string;
  hwid?: string;
  autoRefresh?: boolean;
  refreshIntervalMinutes?: number;
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<{ id: string; report: RefreshReport }> {
  if (input.sourceType === 'url') {
    assertHttpUrl(input.url ?? '');
  } else if (!input.rawContent?.trim()) {
    throw new Error('Для источника «текст» нужно вставить содержимое подписки');
  }

  const created = await SubscriptionModel.create({
    name: input.name.trim() || 'Подписка',
    source: input.source?.trim() || null,
    sourceType: input.sourceType,
    url: input.url ? encryptSecret(input.url.trim()) : null,
    rawContent: input.rawContent ? encryptSecret(input.rawContent) : null,
    userAgent: input.userAgent?.trim() || null,
    hwid: input.hwid?.trim() ? encryptSecret(input.hwid.trim()) : null,
    autoRefresh: input.autoRefresh ?? true,
    refreshIntervalMinutes: input.refreshIntervalMinutes ?? getSettings().subscriptionRefreshMinutes ?? 360,
  });

  try {
    const report = await refreshSubscription(String(created._id));
    return { id: String(created._id), report };
  } catch (error) {
    // Подписку оставляем — пользователь поправит ссылку или заголовки и повторит.
    throw error;
  }
}

export interface UpdateSubscriptionInput {
  name?: string;
  source?: string;
  url?: string;
  rawContent?: string;
  userAgent?: string;
  hwid?: string;
  enabled?: boolean;
  autoRefresh?: boolean;
  refreshIntervalMinutes?: number;
}

export async function updateSubscription(id: string, patch: UpdateSubscriptionInput): Promise<ISubscription> {
  const update: Record<string, unknown> = {};

  if (patch.name !== undefined) update.name = patch.name.trim() || 'Подписка';
  if (patch.url !== undefined) {
    assertHttpUrl(patch.url);
    update.url = encryptSecret(patch.url.trim());
  }
  if (patch.rawContent !== undefined) update.rawContent = encryptSecret(patch.rawContent);
  // Пустая строка — осознанная очистка поля, поэтому не путаем её с undefined.
  if (patch.userAgent !== undefined) update.userAgent = patch.userAgent.trim() || null;
  if (patch.hwid !== undefined) {
    update.hwid = patch.hwid.trim() ? encryptSecret(patch.hwid.trim()) : null;
    // Старые произвольные заголовки больше не участвуют в запросе.
    update.headers = null;
  }
  if (patch.source !== undefined) update.source = patch.source.trim() || null;
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (patch.autoRefresh !== undefined) update.autoRefresh = patch.autoRefresh;
  if (patch.refreshIntervalMinutes !== undefined) update.refreshIntervalMinutes = patch.refreshIntervalMinutes;

  const updated = await SubscriptionModel.findByIdAndUpdate(id, { $set: update }, { new: true });
  if (!updated) throw new Error('Подписка не найдена');

  if (patch.enabled !== undefined) scheduleSync('переключение подписки');
  return updated.toObject();
}

/** MongoDB не умеет каскадное удаление — чистим связанные документы сами. */
export async function deleteSubscription(id: string): Promise<void> {
  const nodeIds = await VpnNodeModel.find({ subscription: id }).distinct('_id');
  await ProxyEndpointModel.deleteMany({ node: { $in: nodeIds } });
  await VpnNodeModel.deleteMany({ subscription: id });
  await SubscriptionModel.deleteOne({ _id: id });

  recordEvent('info', 'subscriptions', 'Подписка удалена', { subscriptionId: id, nodes: nodeIds.length });
  scheduleSync('удаление подписки');
}

// ────────────────────────────── Обновление ──────────────────────────────

export async function refreshSubscription(id: string): Promise<RefreshReport> {
  const sub = await SubscriptionModel.findById(id);
  if (!sub) throw new Error('Подписка не найдена');

  try {
    const content = await loadContent(sub);
    const parsed = parseSubscriptionContent(content);

    if (parsed.nodes.length === 0) {
      const reason =
        parsed.warnings[0]?.reason ?? 'в ответе не найдено ни одного коннекта — проверь ссылку и формат подписки';
      throw new Error(reason);
    }

    const reconciled = await reconcileNodes(String(sub._id), parsed.nodes);
    const ensured = await ensureProxiesForNodes(reconciled.touchedNodeIds, getSettings().defaultProxyKinds);

    sub.detectedFormat = parsed.format;
    sub.lastFetchedAt = new Date();
    sub.lastError = null;
    sub.nodeCount = parsed.nodes.length;
    if (sub.sourceType === 'url') sub.rawContent = encryptSecret(content);
    await sub.save();

    const report: RefreshReport = {
      subscriptionId: String(sub._id),
      name: sub.name,
      format: parsed.format,
      total: parsed.nodes.length,
      added: reconciled.added,
      updated: reconciled.updated,
      missing: reconciled.missing,
      proxiesCreated: ensured.created,
      warnings: parsed.warnings,
    };

    recordEvent(
      'info',
      'subscriptions',
      `Подписка «${sub.name}» обновлена: ${report.total} коннектов (+${report.added}, пропало ${report.missing}), создано прокси: ${report.proxiesCreated}`,
      { subscriptionId: report.subscriptionId, format: report.format, warnings: report.warnings.length },
    );

    if (reconciled.added > 0 || reconciled.missing > 0 || ensured.created > 0) {
      scheduleSync('обновление подписки');
    }

    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sub.lastError = message;
    sub.lastFetchedAt = new Date();
    await sub.save();

    recordEvent('error', 'subscriptions', `Не удалось обновить подписку «${sub.name}»: ${message}`, {
      subscriptionId: String(sub._id),
    });
    throw error;
  }
}

/** Обновляет все подписки, у которых подошёл срок. Возвращает отчёты. */
export async function refreshDueSubscriptions(): Promise<RefreshReport[]> {
  const now = Date.now();
  const candidates = await SubscriptionModel.find({ enabled: true, autoRefresh: true, sourceType: 'url' }).lean();

  const reports: RefreshReport[] = [];
  for (const sub of candidates) {
    const dueAt = (sub.lastFetchedAt?.getTime() ?? 0) + sub.refreshIntervalMinutes * 60_000;
    if (now < dueAt) continue;

    try {
      reports.push(await refreshSubscription(String(sub._id)));
    } catch {
      // Ошибка уже записана в lastError и в журнал — цикл не прерываем.
    }
  }
  return reports;
}

// ─────────────────────────────── Внутреннее ───────────────────────────────

async function loadContent(sub: ISubscription): Promise<string> {
  if (sub.sourceType === 'raw') {
    const content = tryDecryptSecret(sub.rawContent ?? '');
    if (!content.trim()) throw new Error('Содержимое подписки пусто');
    return content;
  }

  const url = tryDecryptSecret(sub.url ?? '');
  assertHttpUrl(url);

  const timeoutMs = getSettings().subscriptionTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: buildRequestHeaders(sub),
    });

    if (!response.ok) {
      throw new Error(`сервер подписки ответил ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    if (text.length > MAX_CONTENT_BYTES) {
      throw new Error('ответ слишком большой — это точно подписка?');
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`сервер подписки не ответил за ${Math.round(timeoutMs / 1000)} с — увеличь таймаут в настройках`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Заголовки запроса собираются из двух явных полей подписки.
 *
 * User-Agent важен потому, что провайдеры отдают под разными клиентами разный
 * формат: под клиентский UA — base64 со ссылками, под браузерный — HTML-страницу.
 * HWID уходит в x-hwid: панели с привязкой к устройству без него присылают
 * одну ноду-заглушку вместо реального списка.
 *
 * Если у подписки поле пустое, берётся значение по умолчанию из настроек.
 */
function buildRequestHeaders(sub: ISubscription): Record<string, string> {
  const settings = getSettings();

  const userAgent = sub.userAgent?.trim() || settings.subscriptionUserAgent;
  const hwid = (sub.hwid ? tryDecryptSecret(sub.hwid).trim() : '') || settings.subscriptionHwid.trim();

  const headers: Record<string, string> = {
    'User-Agent': userAgent,
    Accept: '*/*',
  };
  if (hwid) headers['x-hwid'] = hwid;

  return headers;
}

/**
 * Раньше заголовки задавались произвольным JSON. Переносим из него User-Agent
 * и x-hwid в отдельные поля: форма теперь спрашивает только их, а остальные
 * заголовки на практике никому не понадобились.
 */
export async function migrateLegacyHeaders(): Promise<number> {
  const legacy = await SubscriptionModel.find({ headers: { $ne: null } });
  let migrated = 0;

  for (const sub of legacy) {
    const entries = new Map(
      Object.entries(decodeHeaders(sub.headers)).map(([key, value]) => [key.toLowerCase(), value]),
    );

    const userAgent = entries.get('user-agent');
    const hwid = entries.get('x-hwid');

    if (!sub.userAgent && userAgent) sub.userAgent = userAgent;
    if (!sub.hwid && hwid) sub.hwid = encryptSecret(hwid);
    sub.headers = null;

    await sub.save();
    migrated += 1;
  }

  if (migrated > 0) {
    recordEvent('info', 'subscriptions', `Заголовки перенесены в поля User-Agent и HWID: ${migrated}`);
  }
  return migrated;
}

function decodeHeaders(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(tryDecryptSecret(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

interface ReconcileResult {
  added: number;
  updated: number;
  missing: number;
  touchedNodeIds: Types.ObjectId[];
}

/**
 * Сверка выполняется одним bulkWrite: подписки на несколько сотен нод —
 * норма, и последовательные upsert'ы превратились бы в сотни round-trip'ов.
 */
async function reconcileNodes(
  subscriptionId: string,
  parsed: ReturnType<typeof parseSubscriptionContent>['nodes'],
): Promise<ReconcileResult> {
  const subscription = new Types.ObjectId(subscriptionId);

  const operations = parsed.map((node, index) => ({
    updateOne: {
      filter: { subscription, fingerprint: node.fingerprint },
      update: {
        $set: {
          name: node.name,
          protocol: node.protocol,
          server: node.server,
          serverPort: node.serverPort,
          outboundJson: encryptSecret(JSON.stringify(node.outbound)),
          rawUri: node.rawUri ? encryptSecret(node.rawUri) : null,
          present: true,
          sortOrder: index,
        },
        // Флаг «включена» ставим только при создании: если пользователь
        // выключил ноду вручную, обновление подписки не должно её включать.
        $setOnInsert: { enabled: true },
      },
      upsert: true,
    },
  }));

  const result = await VpnNodeModel.bulkWrite(operations, { ordered: false });

  const fingerprints = parsed.map((node) => node.fingerprint);
  const touchedNodeIds: Types.ObjectId[] = await VpnNodeModel.find({
    subscription,
    fingerprint: { $in: fingerprints },
  }).distinct('_id');

  // Пропавшие ноды не удаляем: у них уже выданы порты и пароли, которыми
  // пользователь мог поделиться. Помечаем и показываем в интерфейсе.
  const missingResult = await VpnNodeModel.updateMany(
    { subscription, fingerprint: { $nin: fingerprints }, present: true },
    { $set: { present: false } },
  );

  return {
    added: result.upsertedCount,
    updated: result.modifiedCount,
    missing: missingResult.modifiedCount,
    touchedNodeIds,
  };
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Некорректная ссылка на подписку');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Поддерживаются только ссылки http:// и https://');
  }
}
