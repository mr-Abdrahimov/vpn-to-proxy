import { NODE_PROTOCOLS, type NodeProtocol } from '../../db/models.js';
import { computeFingerprint } from './fingerprint.js';
import { applyStream, normalizeFlow, parseAlpn } from './stream.js';
import { UnsupportedNodeError, type ParsedNode, type SingBoxOutbound, type StreamOptions } from './types.js';
import { asArray, asRecord, bool, num, str, strList } from './util.js';

/**
 * Разбор JSON-конфигов двух ядер:
 *   • sing-box — outbound'ы уже в нужном виде, остаётся отфильтровать и проверить;
 *   • Xray/V2Ray — форма другая (protocol + settings.vnext/servers + streamSettings),
 *     конвертируем в sing-box.
 */

/** Служебные outbound'ы, которые не являются коннектами. */
const SINGBOX_NON_PROXY = new Set(['direct', 'block', 'dns', 'selector', 'urltest']);
const XRAY_NON_PROXY = new Set(['freedom', 'blackhole', 'dns', 'loopback']);

const SUPPORTED_PROTOCOLS = new Set<string>(NODE_PROTOCOLS);

export type JsonFlavor = 'sing-box' | 'xray';

/** Определяет, чей это JSON, по форме outbound'ов. */
export function detectJsonFlavor(value: unknown): JsonFlavor | null {
  const outbounds = extractOutbounds(value);
  if (!outbounds) return null;

  for (const entry of outbounds) {
    const record = asRecord(entry);
    if (!record) continue;
    if (typeof record.protocol === 'string') return 'xray';
    if (typeof record.type === 'string') return 'sing-box';
  }
  return null;
}

/** Достаёт список outbound'ов из полного конфига, голого массива или одиночного объекта. */
export function extractOutbounds(value: unknown): unknown[] | null {
  const direct = asArray(value);
  if (direct) return direct;

  const record = asRecord(value);
  if (!record) return null;

  const outbounds = asArray(record.outbounds);
  if (outbounds) return outbounds;

  // Одиночный outbound.
  if (typeof record.type === 'string' || typeof record.protocol === 'string') return [record];
  return null;
}

// ─────────────────────────────── sing-box ───────────────────────────────

export function parseSingBoxOutbound(entry: unknown): ParsedNode {
  const record = asRecord(entry);
  if (!record) throw new Error('элемент outbounds не является объектом');

  const type = str(record.type);
  if (!type) throw new Error('у outbound не указан type');
  if (SINGBOX_NON_PROXY.has(type)) throw new UnsupportedNodeError(`служебный outbound "${type}"`);
  if (!SUPPORTED_PROTOCOLS.has(type)) throw new UnsupportedNodeError(`протокол "${type}" не поддерживается панелью`);

  const server = str(record.server);
  const serverPort = num(record.server_port);
  if (!server) throw new Error(`у outbound "${type}" не указан server`);
  if (serverPort === undefined) throw new Error(`у outbound "${type}" не указан server_port`);

  // Копируем как есть, вычищая только тег и поля, относящиеся к маршрутизации:
  // конфиг мы собираем сами и теги проставляем сами.
  const outbound: SingBoxOutbound = { ...record, type, server, server_port: serverPort };
  delete outbound.tag;
  delete outbound.detour;
  delete outbound.domain_strategy;

  const name = str(record.tag) ?? `${type} ${server}:${serverPort}`;
  return {
    name: name.slice(0, 200),
    protocol: type as NodeProtocol,
    server,
    serverPort,
    outbound,
    fingerprint: computeFingerprint(outbound),
  };
}

// ───────────────────────────────── Xray ─────────────────────────────────

export function parseXrayOutbound(entry: unknown): ParsedNode {
  const record = asRecord(entry);
  if (!record) throw new Error('элемент outbounds не является объектом');

  const protocol = str(record.protocol)?.toLowerCase();
  if (!protocol) throw new Error('у outbound не указан protocol');
  if (XRAY_NON_PROXY.has(protocol)) throw new UnsupportedNodeError(`служебный outbound "${protocol}"`);

  const settings = asRecord(record.settings) ?? {};
  const stream = streamFromXray(asRecord(record.streamSettings));
  const tag = str(record.tag);

  switch (protocol) {
    case 'vless':
    case 'vmess': {
      const vnext = asRecord(asArray(settings.vnext)?.[0]);
      if (!vnext) throw new Error(`у outbound "${protocol}" пуст settings.vnext`);

      const server = str(vnext.address);
      const serverPort = num(vnext.port);
      const user = asRecord(asArray(vnext.users)?.[0]);
      if (!server || serverPort === undefined) throw new Error(`у outbound "${protocol}" нет адреса или порта`);
      if (!user) throw new Error(`у outbound "${protocol}" нет users[0]`);

      const uuid = str(user.id);
      if (!uuid) throw new Error(`у outbound "${protocol}" нет user id`);

      const outbound: SingBoxOutbound = {
        type: protocol,
        server,
        server_port: serverPort,
        uuid,
        packet_encoding: 'xudp',
      };

      if (protocol === 'vless') {
        const flow = normalizeFlow(str(user.flow));
        if (flow) outbound.flow = flow;
      } else {
        outbound.security = str(user.security) ?? 'auto';
        outbound.alter_id = num(user.alterId) ?? 0;
      }

      applyStream(outbound, stream, server);
      return finalizeJson(tag, protocol as NodeProtocol, outbound);
    }

    case 'trojan': {
      const target = asRecord(asArray(settings.servers)?.[0]);
      if (!target) throw new Error('у outbound "trojan" пуст settings.servers');

      const server = str(target.address);
      const serverPort = num(target.port);
      const password = str(target.password);
      if (!server || serverPort === undefined) throw new Error('у outbound "trojan" нет адреса или порта');
      if (!password) throw new Error('у outbound "trojan" нет пароля');

      if (!stream.security) stream.security = 'tls';
      const outbound: SingBoxOutbound = { type: 'trojan', server, server_port: serverPort, password };
      applyStream(outbound, stream, server);
      return finalizeJson(tag, 'trojan', outbound);
    }

    case 'shadowsocks': {
      const target = asRecord(asArray(settings.servers)?.[0]);
      if (!target) throw new Error('у outbound "shadowsocks" пуст settings.servers');

      const server = str(target.address);
      const serverPort = num(target.port);
      const method = str(target.method);
      const password = str(target.password);
      if (!server || serverPort === undefined) throw new Error('у outbound "shadowsocks" нет адреса или порта');
      if (!method || !password) throw new Error('у outbound "shadowsocks" нет метода шифрования или пароля');

      const outbound: SingBoxOutbound = { type: 'shadowsocks', server, server_port: serverPort, method, password };
      return finalizeJson(tag, 'shadowsocks', outbound);
    }

    case 'socks':
    case 'http': {
      const target = asRecord(asArray(settings.servers)?.[0]);
      if (!target) throw new Error(`у outbound "${protocol}" пуст settings.servers`);

      const server = str(target.address);
      const serverPort = num(target.port);
      if (!server || serverPort === undefined) throw new Error(`у outbound "${protocol}" нет адреса или порта`);

      const outbound: SingBoxOutbound = { type: protocol, server, server_port: serverPort };
      const account = asRecord(asArray(target.users)?.[0]);
      if (account) {
        const username = str(account.user);
        const password = str(account.pass);
        if (username) outbound.username = username;
        if (password) outbound.password = password;
      }
      applyStream(outbound, stream, server);
      return finalizeJson(tag, protocol as NodeProtocol, outbound);
    }

    default:
      throw new UnsupportedNodeError(`протокол Xray "${protocol}" не поддерживается`);
  }
}

/** streamSettings Xray → нормализованный StreamOptions. */
function streamFromXray(streamSettings: Record<string, unknown> | undefined): StreamOptions {
  if (!streamSettings) return {};

  const security = str(streamSettings.security)?.toLowerCase();
  const options: StreamOptions = {
    network: str(streamSettings.network),
    security,
  };

  const tlsSettings = asRecord(streamSettings.tlsSettings);
  if (tlsSettings) {
    options.sni = str(tlsSettings.serverName);
    options.alpn = parseAlpn(strList(tlsSettings.alpn));
    options.fingerprint = str(tlsSettings.fingerprint);
    options.insecure = bool(tlsSettings.allowInsecure) ?? false;
  }

  const realitySettings = asRecord(streamSettings.realitySettings);
  if (realitySettings) {
    options.security = 'reality';
    options.sni = str(realitySettings.serverName) ?? options.sni;
    options.publicKey = str(realitySettings.publicKey);
    options.shortId = str(realitySettings.shortId);
    options.fingerprint = str(realitySettings.fingerprint) ?? options.fingerprint;
  }

  const ws = asRecord(streamSettings.wsSettings);
  if (ws) {
    options.path = str(ws.path);
    options.host = str(asRecord(ws.headers)?.Host) ?? str(ws.host);
  }

  const grpc = asRecord(streamSettings.grpcSettings);
  if (grpc) options.serviceName = str(grpc.serviceName);

  const httpUpgrade = asRecord(streamSettings.httpupgradeSettings);
  if (httpUpgrade) {
    options.path = str(httpUpgrade.path) ?? options.path;
    options.host = str(httpUpgrade.host) ?? options.host;
  }

  const http = asRecord(streamSettings.httpSettings);
  if (http) {
    options.path = str(http.path) ?? options.path;
    options.host = strList(http.host)?.join(',') ?? options.host;
  }

  const tcp = asRecord(streamSettings.tcpSettings);
  if (tcp) {
    const header = asRecord(tcp.header);
    options.headerType = str(header?.type);
    const request = asRecord(header?.request);
    if (request) {
      options.path = strList(request.path)?.[0] ?? options.path;
      options.host = strList(asRecord(request.headers)?.Host)?.join(',') ?? options.host;
    }
  }

  return options;
}

function finalizeJson(tag: string | undefined, protocol: NodeProtocol, outbound: SingBoxOutbound): ParsedNode {
  const server = String(outbound.server);
  const serverPort = Number(outbound.server_port);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new Error(`некорректный порт: ${String(outbound.server_port)}`);
  }

  const name = (tag ?? `${protocol} ${server}:${serverPort}`).slice(0, 200);
  return { name, protocol, server, serverPort, outbound, fingerprint: computeFingerprint(outbound) };
}
