import { parse as parseYaml } from 'yaml';
import { maybeDecodeBase64 } from '../../lib/encoding.js';
import { parseClashProxy } from './clash.js';
import { detectJsonFlavor, extractOutbounds, parseSingBoxOutbound, parseXrayOutbound } from './json.js';
import { UnsupportedNodeError, type ParseResult, type ParsedNode, type ParseWarning } from './types.js';
import { isKnownUri, parseUri } from './uri.js';
import { asArray, asRecord } from './util.js';

export * from './types.js';
export { computeFingerprint } from './fingerprint.js';
export { isKnownUri, parseUri } from './uri.js';

/**
 * Единая точка входа: на вход — что угодно, что вернул провайдер подписки,
 * на выход — список нормализованных нод плюс список того, что не получилось
 * разобрать (с причинами, которые показываем пользователю).
 *
 * Форматы определяются по содержимому, а не по расширению или Content-Type:
 * провайдеры слишком часто врут в заголовках.
 */
export function parseSubscriptionContent(raw: string): ParseResult {
  if (raw.trim() === '') {
    return { nodes: [], warnings: [], format: 'пусто' };
  }

  // Подписку почти всегда отдают в base64. Декодируем ДО определения формата:
  // внутри может оказаться и список ссылок, и YAML, и JSON.
  const { text, wasBase64 } = maybeDecodeBase64(raw);
  const prefix = wasBase64 ? 'base64 → ' : '';

  const result = parseDecoded(text, prefix);
  return { ...result, nodes: dedupe(result.nodes) };
}

function parseDecoded(text: string, prefix: string): ParseResult {
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return parseJsonValue(JSON.parse(trimmed) as unknown, prefix);
    } catch (error) {
      // Битый JSON — не повод сдаваться: возможно, это всё-таки список ссылок.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  if (/^\s*proxies\s*:/m.test(trimmed)) {
    return parseClashYaml(trimmed, prefix);
  }

  return parseUriList(trimmed, prefix);
}

function parseJsonValue(value: unknown, prefix: string): ParseResult {
  // Clash умеет отдаваться и в JSON — у него ключ proxies.
  const record = asRecord(value);
  const clashProxies = asArray(record?.proxies);
  if (clashProxies) {
    return collect(clashProxies, parseClashProxy, `${prefix}Clash JSON`, describeClashEntry);
  }

  const flavor = detectJsonFlavor(value);
  const outbounds = extractOutbounds(value);

  if (!flavor || !outbounds) {
    return { nodes: [], warnings: [{ input: 'JSON', reason: 'в JSON не найдено ни outbounds, ни proxies' }], format: `${prefix}JSON` };
  }

  const parser = flavor === 'xray' ? parseXrayOutbound : parseSingBoxOutbound;
  const label = flavor === 'xray' ? 'Xray JSON' : 'sing-box JSON';
  return collect(outbounds, parser, `${prefix}${label}`, describeOutboundEntry);
}

function parseClashYaml(text: string, prefix: string): ParseResult {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    return {
      nodes: [],
      warnings: [{ input: 'YAML', reason: `не удалось разобрать YAML: ${errorMessage(error)}` }],
      format: `${prefix}Clash YAML`,
    };
  }

  const proxies = asArray(asRecord(document)?.proxies);
  if (!proxies) {
    return {
      nodes: [],
      warnings: [{ input: 'YAML', reason: 'в конфиге Clash нет секции proxies' }],
      format: `${prefix}Clash YAML`,
    };
  }

  return collect(proxies, parseClashProxy, `${prefix}Clash YAML`, describeClashEntry);
}

/**
 * Служебные схемы, которые провайдеры кладут в подписку рядом с нодами
 * (настройки маршрутизации для конкретного клиента и т.п.). Это не коннекты,
 * и сообщать о них как о проблеме — только зашумлять отчёт.
 */
const IGNORED_SCHEMES = /^(happ|clash|sn|sing-box|v2raytun|streisand|hiddify|shadowrocket):\/\//i;

function parseUriList(text: string, prefix: string): ParseResult {
  const nodes: ParsedNode[] = [];
  const warnings: ParseWarning[] = [];

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Строки-комментарии несут метаданные профиля: #profile-title, #announce…
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));

  for (const line of lines) {
    if (IGNORED_SCHEMES.test(line)) continue;

    if (!isKnownUri(line)) {
      warnings.push({ input: truncate(line), reason: 'строка не похожа на ссылку известного протокола' });
      continue;
    }
    try {
      nodes.push(parseUri(line));
    } catch (error) {
      warnings.push({ input: truncate(line), reason: errorMessage(error) });
    }
  }

  return { nodes, warnings, format: `${prefix}список ссылок` };
}

/** Общий цикл «разбери каждый элемент, ошибки собери в warnings». */
function collect(
  entries: unknown[],
  parser: (entry: unknown) => ParsedNode,
  format: string,
  describe: (entry: unknown, index: number) => string,
): ParseResult {
  const nodes: ParsedNode[] = [];
  const warnings: ParseWarning[] = [];

  entries.forEach((entry, index) => {
    try {
      nodes.push(parser(entry));
    } catch (error) {
      // Служебные outbound'ы (direct/block/dns) есть в любом конфиге —
      // сообщать о них пользователю как о проблеме было бы шумом.
      if (error instanceof UnsupportedNodeError && /служебный/.test(error.message)) return;
      warnings.push({ input: describe(entry, index), reason: errorMessage(error) });
    }
  });

  return { nodes, warnings, format };
}

/** Одинаковые коннекты в одной подписке — обычное дело; берём первый. */
function dedupe(nodes: ParsedNode[]): ParsedNode[] {
  const seen = new Set<string>();
  const result: ParsedNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.fingerprint)) continue;
    seen.add(node.fingerprint);
    result.push(node);
  }
  return result;
}

function describeOutboundEntry(entry: unknown, index: number): string {
  const record = asRecord(entry);
  const tag = record?.tag ?? record?.type ?? record?.protocol;
  return typeof tag === 'string' ? tag : `outbounds[${index}]`;
}

function describeClashEntry(entry: unknown, index: number): string {
  const record = asRecord(entry);
  const name = record?.name ?? record?.type;
  return typeof name === 'string' ? name : `proxies[${index}]`;
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
