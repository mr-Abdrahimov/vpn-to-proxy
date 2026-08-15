import { Types } from 'mongoose';
import { assertPortAllowed, findFreePorts, isDuplicateKeyError } from '../core/ports.js';
import { PROXY_KINDS, ProxyEndpointModel, type IProxyEndpoint, type ProxyKind } from '../db/models.js';
import { encryptSecret, generateProxyPassword, generateProxyUsername, tryDecryptSecret } from '../lib/crypto.js';
import { getSettings } from './settings.js';

/**
 * Выдача и редактирование прокси.
 *
 * Порт захватывается «оптимистично»: аллокатор предлагает список свободных
 * кандидатов, а окончательный арбитр — уникальный индекс в MongoDB. Если два
 * запроса одновременно нацелились на один порт, второй получит E11000 и
 * спокойно возьмёт следующий кандидат.
 */

/** Сколько лишних кандидатов запрашивать про запас на случай гонок. */
const PORT_SLACK = 16;
/** Сколько раз перевыдаём порты тем, кто проиграл гонку за порт. */
const MAX_INSERT_PASSES = 5;

export interface ProxyDto {
  id: string;
  nodeId: string;
  kind: ProxyKind;
  port: number;
  username: string;
  password: string;
  enabled: boolean;
  status: IProxyEndpoint['status'];
  latencyMs: number | null;
  exitIp: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Готовая строка подключения, например socks5://user:pass@1.2.3.4:20001 */
  url: string;
  host: string;
}

export function toProxyDto(proxy: IProxyEndpoint, host: string): ProxyDto {
  const password = tryDecryptSecret(proxy.password);
  return {
    id: String(proxy._id),
    nodeId: String(proxy.node),
    kind: proxy.kind,
    port: proxy.port,
    username: proxy.username,
    password,
    enabled: proxy.enabled,
    status: proxy.status,
    latencyMs: proxy.latencyMs,
    exitIp: proxy.exitIp,
    lastCheckedAt: proxy.lastCheckedAt ? proxy.lastCheckedAt.toISOString() : null,
    lastError: proxy.lastError,
    url: buildProxyUrl(proxy.kind, host, proxy.port, proxy.username, password),
    host,
  };
}

export function buildProxyUrl(kind: ProxyKind, host: string, port: number, username: string, password: string): string {
  const scheme = kind === 'socks5' ? 'socks5' : kind;
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  const hostPart = host.includes(':') ? `[${host}]` : host;
  return `${scheme}://${auth}@${hostPart}:${port}`;
}

// ────────────────────────────── Создание ──────────────────────────────

export interface EnsureResult {
  created: number;
  skipped: number;
}

/**
 * Досоздаёт недостающие прокси указанных видов для перечисленных нод.
 * Уже существующие пары «нода + вид» не трогает — креды и порты сохраняются.
 */
export async function ensureProxiesForNodes(
  nodeIds: (string | Types.ObjectId)[],
  kinds: ProxyKind[] = getSettings().defaultProxyKinds,
): Promise<EnsureResult> {
  if (nodeIds.length === 0 || kinds.length === 0) return { created: 0, skipped: 0 };

  const ids = nodeIds.map((id) => new Types.ObjectId(String(id)));
  const existing = await ProxyEndpointModel.find({ node: { $in: ids } })
    .select({ node: 1, kind: 1 })
    .lean();

  const taken = new Set(existing.map((proxy) => `${String(proxy.node)}:${proxy.kind}`));

  const wanted: { node: Types.ObjectId; kind: ProxyKind }[] = [];
  for (const node of ids) {
    for (const kind of kinds) {
      if (!taken.has(`${String(node)}:${kind}`)) wanted.push({ node, kind });
    }
  }

  if (wanted.length === 0) return { created: 0, skipped: 0 };

  // Подписка на несколько сотен нод — обычное дело, поэтому вставляем пачкой.
  // ordered:false означает «вставляй что можешь», а конфликты возвращаются
  // списком, и мы перевыдаём порты только тем, кому не повезло.
  let remaining = wanted;
  let created = 0;
  let skipped = 0;

  for (let pass = 0; pass < MAX_INSERT_PASSES && remaining.length > 0; pass += 1) {
    const ports = await findFreePorts(remaining.length + PORT_SLACK);

    const documents = remaining.map((item, index) => ({
      node: item.node,
      kind: item.kind,
      port: ports[index]!,
      username: generateProxyUsername(),
      password: encryptSecret(generateProxyPassword()),
      enabled: true,
    }));

    try {
      const inserted = await ProxyEndpointModel.insertMany(documents, { ordered: false });
      created += inserted.length;
      remaining = [];
    } catch (error) {
      if (!isDuplicateKeyError(error) && !hasWriteErrors(error)) throw error;

      const failures = writeErrorsOf(error);
      created += documents.length - failures.length;

      const retry: typeof remaining = [];
      for (const failure of failures) {
        const item = remaining[failure.index];
        if (!item) continue;

        // Конфликт по порту — берём другой порт. Конфликт по паре «нода+вид»
        // означает, что прокси уже существует: создавать нечего.
        if (failure.message.includes('port')) retry.push(item);
        else skipped += 1;
      }
      remaining = retry;
    }
  }

  if (remaining.length > 0) {
    throw new Error(`Не удалось выделить порты для ${remaining.length} прокси — расширь диапазон в настройках`);
  }

  return { created, skipped };
}

interface BulkWriteFailure {
  index: number;
  message: string;
}

function hasWriteErrors(error: unknown): boolean {
  return writeErrorsOf(error).length > 0;
}

/** Форма ошибки различается между драйвером и mongoose — разбираем обе. */
function writeErrorsOf(error: unknown): BulkWriteFailure[] {
  if (typeof error !== 'object' || error === null) return [];

  const raw = (error as { writeErrors?: unknown }).writeErrors;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

  return list.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as { index?: number; errmsg?: string; err?: { index?: number; errmsg?: string } };
    const index = record.index ?? record.err?.index;
    if (typeof index !== 'number') return [];
    return [{ index, message: record.errmsg ?? record.err?.errmsg ?? '' }];
  });
}

// ────────────────────────────── Изменение ──────────────────────────────

export interface ProxyPatch {
  username?: string;
  password?: string;
  port?: number;
  enabled?: boolean;
}

export async function updateProxy(id: string, patch: ProxyPatch): Promise<IProxyEndpoint> {
  const update: Record<string, unknown> = {};

  if (patch.username !== undefined) {
    const username = patch.username.trim();
    if (username.length < 1 || username.length > 64) throw new Error('Логин должен быть от 1 до 64 символов');
    if (/[\s:@]/.test(username)) throw new Error('Логин не должен содержать пробелы, «:» и «@»');
    update.username = username;
  }

  if (patch.password !== undefined) {
    if (patch.password.length < 1 || patch.password.length > 128) {
      throw new Error('Пароль должен быть от 1 до 128 символов');
    }
    if (/[\s]/.test(patch.password)) throw new Error('Пароль не должен содержать пробелы');
    update.password = encryptSecret(patch.password);
  }

  if (patch.port !== undefined) {
    assertPortAllowed(patch.port);
    update.port = patch.port;
  }

  if (patch.enabled !== undefined) update.enabled = patch.enabled;

  try {
    const updated = await ProxyEndpointModel.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!updated) throw new Error('Прокси не найден');
    return updated.toObject();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new Error(`Порт ${patch.port} уже занят другим прокси`);
    throw error;
  }
}

/** Перевыпуск логина и пароля. Возвращает число обновлённых прокси. */
export async function regenerateCredentials(ids: string[]): Promise<number> {
  let updated = 0;
  for (const id of ids) {
    const result = await ProxyEndpointModel.updateOne(
      { _id: id },
      { $set: { username: generateProxyUsername(), password: encryptSecret(generateProxyPassword()) } },
    );
    updated += result.modifiedCount;
  }
  return updated;
}

export async function setEnabled(ids: string[], enabled: boolean): Promise<number> {
  const result = await ProxyEndpointModel.updateMany({ _id: { $in: ids } }, { $set: { enabled } });
  return result.modifiedCount;
}

export async function deleteProxies(ids: string[]): Promise<number> {
  const result = await ProxyEndpointModel.deleteMany({ _id: { $in: ids } });
  return result.deletedCount ?? 0;
}

// ─────────────────────────────── Экспорт ───────────────────────────────

export const EXPORT_FORMATS = ['uri', 'hostport', 'json', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportRow extends ProxyDto {
  nodeName: string;
}

export function renderExport(rows: ExportRow[], format: ExportFormat): { body: string; contentType: string; filename: string } {
  switch (format) {
    case 'uri':
      return {
        body: rows.map((row) => row.url).join('\n'),
        contentType: 'text/plain; charset=utf-8',
        filename: 'proxies.txt',
      };

    case 'hostport':
      // Формат, который понимают большинство парсеров списков прокси.
      return {
        body: rows.map((row) => `${row.host}:${row.port}:${row.username}:${row.password}`).join('\n'),
        contentType: 'text/plain; charset=utf-8',
        filename: 'proxies.txt',
      };

    case 'json':
      return {
        body: JSON.stringify(
          rows.map((row) => ({
            name: row.nodeName,
            kind: row.kind,
            host: row.host,
            port: row.port,
            username: row.username,
            password: row.password,
            url: row.url,
            status: row.status,
            latencyMs: row.latencyMs,
            exitIp: row.exitIp,
          })),
          null,
          2,
        ),
        contentType: 'application/json; charset=utf-8',
        filename: 'proxies.json',
      };

    case 'csv': {
      const header = 'name,kind,host,port,username,password,status,latency_ms,exit_ip';
      const lines = rows.map((row) =>
        [
          csvCell(row.nodeName),
          row.kind,
          row.host,
          String(row.port),
          csvCell(row.username),
          csvCell(row.password),
          row.status,
          row.latencyMs === null ? '' : String(row.latencyMs),
          row.exitIp ?? '',
        ].join(','),
      );
      return {
        body: [header, ...lines].join('\n'),
        contentType: 'text/csv; charset=utf-8',
        filename: 'proxies.csv',
      };
    }
  }
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function isProxyKind(value: string): value is ProxyKind {
  return (PROXY_KINDS as readonly string[]).includes(value);
}
