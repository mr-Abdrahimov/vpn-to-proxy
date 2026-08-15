import type { NodeProtocol } from '../../db/models.js';
import { decodeBase64, safeDecodeUriComponent } from '../../lib/encoding.js';
import { computeFingerprint } from './fingerprint.js';
import { applyStream, normalizeFlow, parseAlpn } from './stream.js';
import { UnsupportedNodeError, type ParsedNode, type SingBoxOutbound, type StreamOptions } from './types.js';

/**
 * Разбор одиночных ссылок из подписки: vless://, vmess://, trojan://, ss://,
 * hysteria2://, tuic://.
 *
 * Каждая функция возвращает готовый outbound sing-box. Всё, что sing-box
 * заведомо не потянет (ssr://, mKCP, xhttp), отбрасывается с внятной причиной —
 * это лучше, чем сгенерировать конфиг, который молча не поднимется.
 */

export function parseUri(rawUri: string): ParsedNode {
  const uri = rawUri.trim();
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd <= 0) throw new Error('строка не похожа на ссылку вида scheme://…');

  const scheme = uri.slice(0, schemeEnd).toLowerCase();

  switch (scheme) {
    case 'vless':
      return parseVless(uri);
    case 'vmess':
      return parseVmess(uri);
    case 'trojan':
      return parseTrojan(uri);
    case 'ss':
      return parseShadowsocks(uri);
    case 'hysteria2':
    case 'hy2':
      return parseHysteria2(uri);
    case 'tuic':
      return parseTuic(uri);
    case 'ssr':
      throw new UnsupportedNodeError('ShadowsocksR (ssr://) не поддерживается sing-box');
    case 'hysteria':
      throw new UnsupportedNodeError('Hysteria v1 устарел и не поддерживается; нужен hysteria2://');
    default:
      throw new UnsupportedNodeError(`неизвестный протокол "${scheme}"`);
  }
}

/** Понимает ли парсер такую схему (для быстрой фильтрации строк подписки). */
export function isKnownUri(value: string): boolean {
  return /^(vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic):\/\//i.test(value.trim());
}

// ────────────────────────────────── VLESS ──────────────────────────────────

function parseVless(uri: string): ParsedNode {
  const url = new URL(uri);
  const uuid = safeDecodeUriComponent(url.username);
  if (!uuid) throw new Error('в ссылке vless:// нет UUID');

  const params = url.searchParams;
  const stream = streamFromParams(params);
  // Некоторые провайдеры забывают security=reality, но кладут pbk — чиним.
  if (!stream.security && stream.publicKey) stream.security = 'reality';

  const server = hostOf(url);
  const outbound: SingBoxOutbound = {
    type: 'vless',
    server,
    server_port: portOf(url, 443),
    uuid,
    packet_encoding: 'xudp',
  };

  const flow = normalizeFlow(params.get('flow') ?? undefined);
  if (flow) outbound.flow = flow;

  applyStream(outbound, stream, server);
  return finalize(nameOf(url), 'vless', outbound, uri);
}

// ────────────────────────────────── VMess ──────────────────────────────────

interface VmessJson {
  ps?: string;
  add?: string;
  port?: string | number;
  id?: string;
  aid?: string | number;
  scy?: string;
  net?: string;
  type?: string;
  host?: string;
  path?: string;
  tls?: string;
  sni?: string;
  alpn?: string;
  fp?: string;
}

function parseVmess(uri: string): ParsedNode {
  const body = uri.slice('vmess://'.length);

  // Каноничный формат — base64 от JSON. Некоторые клиенты отдают обычный URI.
  let json: VmessJson | null = null;
  try {
    const decoded = decodeBase64(body.split('#')[0] ?? body);
    const parsed: unknown = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object') json = parsed as VmessJson;
  } catch {
    json = null;
  }

  if (!json) return parseVmessAsUri(uri);

  const server = String(json.add ?? '').trim();
  const uuid = String(json.id ?? '').trim();
  if (!server) throw new Error('в vmess-ссылке нет адреса сервера (add)');
  if (!uuid) throw new Error('в vmess-ссылке нет UUID (id)');

  const stream: StreamOptions = {
    network: json.net,
    security: json.tls && json.tls !== 'none' ? json.tls : undefined,
    sni: json.sni,
    host: json.host,
    path: json.path,
    serviceName: json.net === 'grpc' ? json.path : undefined,
    alpn: parseAlpn(json.alpn),
    fingerprint: json.fp,
    headerType: json.type,
  };

  const outbound: SingBoxOutbound = {
    type: 'vmess',
    server,
    server_port: toPort(json.port, 443),
    uuid,
    security: json.scy && json.scy !== '' ? json.scy : 'auto',
    alter_id: toInt(json.aid, 0),
    packet_encoding: 'xudp',
  };

  applyStream(outbound, stream, server);
  return finalize(String(json.ps ?? ''), 'vmess', outbound, uri);
}

/** Нестандартный, но встречающийся вариант: vmess://uuid@host:port?… */
function parseVmessAsUri(uri: string): ParsedNode {
  const url = new URL(uri);
  const uuid = safeDecodeUriComponent(url.username);
  if (!uuid) throw new Error('vmess-ссылка не является ни base64-JSON, ни URI с UUID');

  const params = url.searchParams;
  const server = hostOf(url);
  const outbound: SingBoxOutbound = {
    type: 'vmess',
    server,
    server_port: portOf(url, 443),
    uuid,
    security: params.get('encryption') ?? 'auto',
    alter_id: toInt(params.get('alterId') ?? undefined, 0),
    packet_encoding: 'xudp',
  };

  applyStream(outbound, streamFromParams(params), server);
  return finalize(nameOf(url), 'vmess', outbound, uri);
}

// ────────────────────────────────── Trojan ──────────────────────────────────

function parseTrojan(uri: string): ParsedNode {
  const url = new URL(uri);
  // Пароль лежит в userinfo; двоеточие внутри него не является разделителем.
  const password = safeDecodeUriComponent(url.password ? `${url.username}:${url.password}` : url.username);
  if (!password) throw new Error('в ссылке trojan:// нет пароля');

  const params = url.searchParams;
  const stream = streamFromParams(params);
  // Trojan по спецификации всегда поверх TLS.
  if (!stream.security) stream.security = 'tls';

  const server = hostOf(url);
  const outbound: SingBoxOutbound = {
    type: 'trojan',
    server,
    server_port: portOf(url, 443),
    password,
  };

  applyStream(outbound, stream, server);
  return finalize(nameOf(url), 'trojan', outbound, uri);
}

// ─────────────────────────────── Shadowsocks ───────────────────────────────

/**
 * Три формата в обиходе:
 *   ss://base64(method:password)@host:port#name     — SIP002
 *   ss://method:password@host:port#name             — SIP002 без base64
 *   ss://base64(method:password@host:port)#name     — legacy
 */
function parseShadowsocks(uri: string): ParsedNode {
  const withoutScheme = uri.slice('ss://'.length);

  const hashIndex = withoutScheme.indexOf('#');
  const name = hashIndex === -1 ? '' : safeDecodeUriComponent(withoutScheme.slice(hashIndex + 1));
  const withoutHash = hashIndex === -1 ? withoutScheme : withoutScheme.slice(0, hashIndex);

  const queryIndex = withoutHash.indexOf('?');
  const params = new URLSearchParams(queryIndex === -1 ? '' : withoutHash.slice(queryIndex + 1));
  let body = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);

  // Legacy: весь блок закодирован целиком.
  if (!body.includes('@')) {
    body = decodeBase64(body);
    if (!body.includes('@')) throw new Error('не удалось разобрать ss-ссылку');
  }

  const atIndex = body.lastIndexOf('@');
  let userInfo = body.slice(0, atIndex);
  const hostPort = body.slice(atIndex + 1).replace(/\/$/, '');

  // userinfo может быть как base64, так и percent-encoded «method:password».
  if (!userInfo.includes(':')) {
    userInfo = decodeBase64(userInfo);
  } else {
    userInfo = safeDecodeUriComponent(userInfo);
  }

  const colonIndex = userInfo.indexOf(':');
  if (colonIndex === -1) throw new Error('в ss-ссылке не найдены метод шифрования и пароль');
  const method = userInfo.slice(0, colonIndex);
  const password = userInfo.slice(colonIndex + 1);

  const { host, port } = splitHostPort(hostPort, 8388);

  const outbound: SingBoxOutbound = {
    type: 'shadowsocks',
    server: host,
    server_port: port,
    method,
    password,
  };

  const plugin = params.get('plugin');
  if (plugin) {
    const [pluginName, ...pluginOpts] = plugin.split(';');
    const normalized = normalizePluginName(pluginName ?? '');
    if (!normalized) {
      throw new UnsupportedNodeError(`SIP003-плагин "${pluginName}" не поддерживается sing-box`);
    }
    outbound.plugin = normalized;
    if (pluginOpts.length > 0) outbound.plugin_opts = pluginOpts.join(';');
  }

  return finalize(name, 'shadowsocks', outbound, uri);
}

function normalizePluginName(raw: string): string | null {
  const value = raw.trim();
  if (value === 'obfs-local' || value === 'simple-obfs') return 'obfs-local';
  if (value === 'v2ray-plugin') return 'v2ray-plugin';
  return null;
}

// ─────────────────────────────── Hysteria2 ───────────────────────────────

function parseHysteria2(uri: string): ParsedNode {
  const url = new URL(uri);
  const password = safeDecodeUriComponent(url.password ? `${url.username}:${url.password}` : url.username);
  if (!password) throw new Error('в ссылке hysteria2:// нет пароля');

  const params = url.searchParams;
  const server = hostOf(url);

  const tls: Record<string, unknown> = { enabled: true };
  const sni = params.get('sni') ?? params.get('peer');
  if (sni) tls.server_name = sni;
  if (truthy(params.get('insecure')) || truthy(params.get('allowInsecure'))) tls.insecure = true;
  const alpn = parseAlpn(params.get('alpn') ?? undefined);
  if (alpn) tls.alpn = alpn;

  const outbound: SingBoxOutbound = {
    type: 'hysteria2',
    server,
    server_port: portOf(url, 443),
    password,
    tls,
  };

  const obfs = params.get('obfs');
  if (obfs === 'salamander') {
    outbound.obfs = { type: 'salamander', password: params.get('obfs-password') ?? '' };
  }

  return finalize(nameOf(url), 'hysteria2', outbound, uri);
}

// ────────────────────────────────── TUIC ──────────────────────────────────

function parseTuic(uri: string): ParsedNode {
  const url = new URL(uri);
  const uuid = safeDecodeUriComponent(url.username);
  const password = safeDecodeUriComponent(url.password);
  if (!uuid) throw new Error('в ссылке tuic:// нет UUID');

  const params = url.searchParams;
  const server = hostOf(url);

  const tls: Record<string, unknown> = { enabled: true };
  const sni = params.get('sni');
  if (sni) tls.server_name = sni;
  if (truthy(params.get('allow_insecure')) || truthy(params.get('insecure'))) tls.insecure = true;
  const alpn = parseAlpn(params.get('alpn') ?? undefined);
  if (alpn) tls.alpn = alpn;

  const outbound: SingBoxOutbound = {
    type: 'tuic',
    server,
    server_port: portOf(url, 443),
    uuid,
    password,
    tls,
  };

  const congestion = params.get('congestion_control');
  if (congestion) outbound.congestion_control = congestion;
  const relayMode = params.get('udp_relay_mode');
  if (relayMode) outbound.udp_relay_mode = relayMode;

  return finalize(nameOf(url), 'tuic', outbound, uri);
}

// ──────────────────────────────── Утилиты ────────────────────────────────

function streamFromParams(params: URLSearchParams): StreamOptions {
  const network = params.get('type') ?? params.get('net') ?? undefined;
  return {
    network: network ?? undefined,
    security: params.get('security') ?? undefined,
    sni: params.get('sni') ?? params.get('peer') ?? undefined,
    host: params.get('host') ?? undefined,
    path: params.get('path') ?? undefined,
    serviceName: params.get('serviceName') ?? params.get('servicename') ?? undefined,
    alpn: parseAlpn(params.get('alpn') ?? undefined),
    fingerprint: params.get('fp') ?? undefined,
    publicKey: params.get('pbk') ?? undefined,
    shortId: params.get('sid') ?? undefined,
    insecure:
      truthy(params.get('allowInsecure')) || truthy(params.get('insecure')) || truthy(params.get('skip-cert-verify')),
    headerType: params.get('headerType') ?? undefined,
  };
}

function finalize(rawName: string, protocol: NodeProtocol, outbound: SingBoxOutbound, rawUri: string): ParsedNode {
  const server = String(outbound.server ?? '').trim();
  const serverPort = Number(outbound.server_port);

  if (!server) throw new Error('пустой адрес сервера');
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new Error(`некорректный порт: ${String(outbound.server_port)}`);
  }

  const name = rawName.trim() || `${protocol} ${server}:${serverPort}`;
  return {
    name: name.slice(0, 200),
    protocol,
    server,
    serverPort,
    outbound,
    rawUri,
    fingerprint: computeFingerprint(outbound),
  };
}

/** URL отдаёт IPv6 в скобках — sing-box ждёт голый адрес. */
function hostOf(url: URL): string {
  const hostname = url.hostname;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function portOf(url: URL, fallback: number): number {
  if (url.port === '') return fallback;
  const parsed = Number.parseInt(url.port, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nameOf(url: URL): string {
  return url.hash.length > 1 ? safeDecodeUriComponent(url.hash.slice(1)) : '';
}

function splitHostPort(value: string, fallbackPort: number): { host: string; port: number } {
  // IPv6 в квадратных скобках: [::1]:8388
  const bracketMatch = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketMatch) {
    return { host: bracketMatch[1] ?? '', port: toPort(bracketMatch[2], fallbackPort) };
  }

  const colonIndex = value.lastIndexOf(':');
  if (colonIndex === -1) return { host: value, port: fallbackPort };
  return { host: value.slice(0, colonIndex), port: toPort(value.slice(colonIndex + 1), fallbackPort) };
}

function toPort(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function toInt(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function truthy(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
