import { UnsupportedNodeError, type SingBoxOutbound, type StreamOptions } from './types.js';

/**
 * Сборка блоков `tls` и `transport` sing-box из нормализованного StreamOptions.
 * Здесь же — единственное место, где мы решаем, что делать с параметрами,
 * которых в sing-box нет (например, xhttp из Xray).
 */

const UTLS_FINGERPRINTS = new Set([
  'chrome',
  'firefox',
  'edge',
  'safari',
  'ios',
  'android',
  'random',
  'randomized',
  '360',
  'qq',
]);

/** sing-box умеет ровно один flow; всё остальное молча выкидываем. */
export const SUPPORTED_FLOW = 'xtls-rprx-vision';

export function normalizeFlow(flow: string | undefined): string | undefined {
  if (!flow) return undefined;
  const trimmed = flow.trim();
  if (trimmed === '' || trimmed === 'none') return undefined;
  return trimmed.startsWith(SUPPORTED_FLOW) ? SUPPORTED_FLOW : undefined;
}

export function parseAlpn(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : raw.split(',');
  const cleaned = list.map((v) => v.trim()).filter((v) => v.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function buildTls(opts: StreamOptions, fallbackServerName: string): Record<string, unknown> | undefined {
  const security = (opts.security ?? 'none').toLowerCase();
  const isReality = security === 'reality';
  const isTls = isReality || security === 'tls' || security === 'xtls';
  if (!isTls) return undefined;

  const serverName = opts.sni?.trim() || opts.host?.trim() || fallbackServerName;

  const tls: Record<string, unknown> = { enabled: true };
  if (serverName && !isIpLiteral(serverName)) tls.server_name = serverName;
  if (opts.insecure) tls.insecure = true;

  const alpn = parseAlpn(opts.alpn);
  if (alpn) tls.alpn = alpn;

  const fingerprint = opts.fingerprint?.trim().toLowerCase();
  // REALITY в sing-box работает только поверх uTLS, поэтому для него
  // отпечаток включаем всегда, даже если в ссылке его не было.
  if (isReality || (fingerprint && UTLS_FINGERPRINTS.has(fingerprint))) {
    tls.utls = {
      enabled: true,
      fingerprint: fingerprint && UTLS_FINGERPRINTS.has(fingerprint) ? fingerprint : 'chrome',
    };
  }

  if (isReality) {
    if (!opts.publicKey) {
      throw new UnsupportedNodeError('REALITY без публичного ключа (pbk) — подключиться невозможно');
    }
    const reality: Record<string, unknown> = { enabled: true, public_key: opts.publicKey };
    if (opts.shortId) reality.short_id = opts.shortId;
    tls.reality = reality;
    // Для REALITY insecure бессмысленен и мешает: сертификат проверяется иначе.
    delete tls.insecure;
  }

  return tls;
}

export function buildTransport(opts: StreamOptions): Record<string, unknown> | undefined {
  const network = (opts.network ?? 'tcp').toLowerCase();

  switch (network) {
    case '':
    case 'tcp':
    case 'raw': {
      // tcp+headerType=http — это HTTP-обфускация; ближайший аналог в sing-box.
      if (opts.headerType === 'http') {
        const transport: Record<string, unknown> = { type: 'http' };
        if (opts.host) transport.host = splitList(opts.host);
        if (opts.path) transport.path = opts.path;
        return transport;
      }
      return undefined;
    }

    case 'ws': {
      const transport: Record<string, unknown> = { type: 'ws' };
      const { path, earlyData } = splitEarlyData(opts.path ?? '/');
      transport.path = path;
      if (opts.host) transport.headers = { Host: opts.host };
      if (earlyData !== undefined) {
        transport.max_early_data = earlyData;
        transport.early_data_header_name = 'Sec-WebSocket-Protocol';
      }
      return transport;
    }

    case 'grpc': {
      const serviceName = opts.serviceName ?? stripLeadingSlash(opts.path ?? '');
      return { type: 'grpc', service_name: serviceName };
    }

    case 'http':
    case 'h2': {
      const transport: Record<string, unknown> = { type: 'http' };
      if (opts.host) transport.host = splitList(opts.host);
      transport.path = opts.path && opts.path.length > 0 ? opts.path : '/';
      return transport;
    }

    case 'httpupgrade': {
      const transport: Record<string, unknown> = { type: 'httpupgrade' };
      if (opts.host) transport.host = opts.host;
      transport.path = opts.path && opts.path.length > 0 ? opts.path : '/';
      return transport;
    }

    case 'quic':
      return { type: 'quic' };

    case 'xhttp':
    case 'splithttp':
      // Транспорт Xray, аналога в sing-box нет — честнее отбросить ноду,
      // чем сгенерировать конфиг, который молча не работает.
      throw new UnsupportedNodeError(`Транспорт "${network}" поддерживается только в Xray, sing-box его не умеет`);

    case 'kcp':
    case 'mkcp':
      throw new UnsupportedNodeError('Транспорт mKCP не поддерживается sing-box');

    default:
      throw new UnsupportedNodeError(`Неизвестный транспорт "${network}"`);
  }
}

/** Приклеивает tls/transport к outbound, пропуская пустые блоки. */
export function applyStream(
  outbound: SingBoxOutbound,
  opts: StreamOptions,
  fallbackServerName: string,
): SingBoxOutbound {
  const tls = buildTls(opts, fallbackServerName);
  if (tls) outbound.tls = tls;

  const transport = buildTransport(opts);
  if (transport) outbound.transport = transport;

  return outbound;
}

/**
 * `/path?ed=2048` → путь и размер early data. Соглашение из v2ray-ссылок,
 * которое sing-box выражает через max_early_data.
 */
function splitEarlyData(rawPath: string): { path: string; earlyData?: number } {
  const index = rawPath.indexOf('?');
  if (index === -1) return { path: rawPath || '/' };

  const path = rawPath.slice(0, index) || '/';
  const query = new URLSearchParams(rawPath.slice(index + 1));
  const ed = query.get('ed');
  if (ed === null) return { path };

  const parsed = Number.parseInt(ed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? { path, earlyData: parsed } : { path };
}

function stripLeadingSlash(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** SNI с IP-адресом невалиден — сервер его отвергнет, лучше не выставлять. */
function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  return value.includes(':') && /^[0-9a-f:]+$/i.test(value);
}
