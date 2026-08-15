import type { NodeProtocol } from '../../db/models.js';
import { computeFingerprint } from './fingerprint.js';
import { applyStream, normalizeFlow, parseAlpn } from './stream.js';
import { UnsupportedNodeError, type ParsedNode, type SingBoxOutbound, type StreamOptions } from './types.js';
import { asRecord, bool, num, str, strList } from './util.js';

/**
 * Разбор записей из `proxies:` конфига Clash / Clash.Meta / mihomo.
 * Формат ближе к человеку, чем к ядру, поэтому здесь больше всего
 * «переводов» имён полей (servername → server_name, cipher → method и т.д.).
 */

export function parseClashProxy(entry: unknown): ParsedNode {
  const record = asRecord(entry);
  if (!record) throw new Error('элемент proxies не является объектом');

  const type = str(record.type)?.toLowerCase();
  if (!type) throw new Error('у прокси не указан type');

  const server = str(record.server);
  const serverPort = num(record.port);
  if (!server) throw new Error(`у прокси "${type}" не указан server`);
  if (serverPort === undefined) throw new Error(`у прокси "${type}" не указан port`);

  const name = str(record.name) ?? `${type} ${server}:${serverPort}`;
  const stream = streamFromClash(record);

  switch (type) {
    case 'vless': {
      const uuid = str(record.uuid);
      if (!uuid) throw new Error('у прокси "vless" не указан uuid');

      const outbound: SingBoxOutbound = {
        type: 'vless',
        server,
        server_port: serverPort,
        uuid,
        packet_encoding: 'xudp',
      };
      const flow = normalizeFlow(str(record.flow));
      if (flow) outbound.flow = flow;

      applyStream(outbound, stream, server);
      return finalize(name, 'vless', outbound, serverPort, server);
    }

    case 'vmess': {
      const uuid = str(record.uuid);
      if (!uuid) throw new Error('у прокси "vmess" не указан uuid');

      const outbound: SingBoxOutbound = {
        type: 'vmess',
        server,
        server_port: serverPort,
        uuid,
        security: str(record.cipher) ?? 'auto',
        alter_id: num(record.alterId) ?? 0,
        packet_encoding: 'xudp',
      };

      applyStream(outbound, stream, server);
      return finalize(name, 'vmess', outbound, serverPort, server);
    }

    case 'trojan': {
      const password = str(record.password);
      if (!password) throw new Error('у прокси "trojan" не указан password');

      if (!stream.security) stream.security = 'tls';
      const outbound: SingBoxOutbound = { type: 'trojan', server, server_port: serverPort, password };
      applyStream(outbound, stream, server);
      return finalize(name, 'trojan', outbound, serverPort, server);
    }

    case 'ss':
    case 'shadowsocks': {
      const method = str(record.cipher);
      const password = str(record.password);
      if (!method) throw new Error('у прокси "ss" не указан cipher');
      if (!password) throw new Error('у прокси "ss" не указан password');

      const outbound: SingBoxOutbound = { type: 'shadowsocks', server, server_port: serverPort, method, password };

      const plugin = str(record.plugin);
      if (plugin) {
        const converted = convertClashPlugin(plugin, asRecord(record['plugin-opts']));
        outbound.plugin = converted.plugin;
        if (converted.opts) outbound.plugin_opts = converted.opts;
      }

      return finalize(name, 'shadowsocks', outbound, serverPort, server);
    }

    case 'hysteria2': {
      const password = str(record.password) ?? str(record.auth);
      if (!password) throw new Error('у прокси "hysteria2" не указан password');

      const tls: Record<string, unknown> = { enabled: true };
      const sni = str(record.sni) ?? str(record.servername);
      if (sni) tls.server_name = sni;
      if (bool(record['skip-cert-verify'])) tls.insecure = true;
      const alpn = parseAlpn(strList(record.alpn));
      if (alpn) tls.alpn = alpn;

      const outbound: SingBoxOutbound = { type: 'hysteria2', server, server_port: serverPort, password, tls };

      const obfs = str(record.obfs);
      if (obfs === 'salamander') {
        outbound.obfs = { type: 'salamander', password: str(record['obfs-password']) ?? '' };
      }

      return finalize(name, 'hysteria2', outbound, serverPort, server);
    }

    case 'tuic': {
      const uuid = str(record.uuid);
      if (!uuid) throw new Error('у прокси "tuic" не указан uuid');

      const tls: Record<string, unknown> = { enabled: true };
      const sni = str(record.sni) ?? str(record.servername);
      if (sni) tls.server_name = sni;
      if (bool(record['skip-cert-verify'])) tls.insecure = true;
      const alpn = parseAlpn(strList(record.alpn));
      if (alpn) tls.alpn = alpn;

      const outbound: SingBoxOutbound = {
        type: 'tuic',
        server,
        server_port: serverPort,
        uuid,
        password: str(record.password) ?? '',
        tls,
      };
      const congestion = str(record['congestion-controller']);
      if (congestion) outbound.congestion_control = congestion;
      const relayMode = str(record['udp-relay-mode']);
      if (relayMode) outbound.udp_relay_mode = relayMode;

      return finalize(name, 'tuic', outbound, serverPort, server);
    }

    case 'socks5':
    case 'socks': {
      const outbound: SingBoxOutbound = { type: 'socks', server, server_port: serverPort, version: '5' };
      const username = str(record.username);
      const password = str(record.password);
      if (username) outbound.username = username;
      if (password) outbound.password = password;
      return finalize(name, 'socks', outbound, serverPort, server);
    }

    case 'http': {
      const outbound: SingBoxOutbound = { type: 'http', server, server_port: serverPort };
      const username = str(record.username);
      const password = str(record.password);
      if (username) outbound.username = username;
      if (password) outbound.password = password;
      if (bool(record.tls)) applyStream(outbound, { ...stream, security: 'tls' }, server);
      return finalize(name, 'http', outbound, serverPort, server);
    }

    case 'ssr':
      throw new UnsupportedNodeError('ShadowsocksR не поддерживается sing-box');
    case 'snell':
      throw new UnsupportedNodeError('Snell не поддерживается sing-box');
    case 'wireguard':
      throw new UnsupportedNodeError('WireGuard в sing-box 1.13 вынесен в endpoints и здесь не поддерживается');
    default:
      throw new UnsupportedNodeError(`тип прокси Clash "${type}" не поддерживается`);
  }
}

function streamFromClash(record: Record<string, unknown>): StreamOptions {
  const options: StreamOptions = {
    network: str(record.network),
    sni: str(record.servername) ?? str(record.sni),
    alpn: parseAlpn(strList(record.alpn)),
    fingerprint: str(record['client-fingerprint']),
    insecure: bool(record['skip-cert-verify']) ?? false,
  };

  if (bool(record.tls)) options.security = 'tls';

  const reality = asRecord(record['reality-opts']);
  if (reality) {
    options.security = 'reality';
    options.publicKey = str(reality['public-key']);
    options.shortId = str(reality['short-id']);
  }

  const ws = asRecord(record['ws-opts']);
  if (ws) {
    options.path = str(ws.path);
    options.host = str(asRecord(ws.headers)?.Host) ?? str(asRecord(ws.headers)?.host);
    const earlyData = num(ws['max-early-data']);
    // Ранние данные в Clash задаются отдельными ключами; приводим к соглашению
    // ?ed=N, которое умеет разбирать наш общий сборщик транспорта.
    if (earlyData !== undefined && earlyData > 0) {
      options.path = `${options.path ?? '/'}?ed=${earlyData}`;
    }
  }

  const grpc = asRecord(record['grpc-opts']);
  if (grpc) options.serviceName = str(grpc['grpc-service-name']);

  const h2 = asRecord(record['h2-opts']);
  if (h2) {
    options.path = str(h2.path) ?? options.path;
    options.host = strList(h2.host)?.join(',') ?? options.host;
  }

  const httpOpts = asRecord(record['http-opts']);
  if (httpOpts) {
    options.path = strList(httpOpts.path)?.[0] ?? options.path;
    options.host = strList(asRecord(httpOpts.headers)?.Host)?.join(',') ?? options.host;
    options.headerType = 'http';
  }

  return options;
}

/** Плагины Clash описываются объектом, а sing-box ждёт SIP003-строку. */
function convertClashPlugin(
  plugin: string,
  opts: Record<string, unknown> | undefined,
): { plugin: string; opts?: string } {
  const name = plugin.trim().toLowerCase();

  if (name === 'obfs' || name === 'simple-obfs' || name === 'obfs-local') {
    const parts: string[] = [];
    const mode = str(opts?.mode);
    const host = str(opts?.host);
    if (mode) parts.push(`obfs=${mode}`);
    if (host) parts.push(`obfs-host=${host}`);
    return { plugin: 'obfs-local', opts: parts.length > 0 ? parts.join(';') : undefined };
  }

  if (name === 'v2ray-plugin') {
    const parts: string[] = [];
    parts.push(`mode=${str(opts?.mode) ?? 'websocket'}`);
    if (bool(opts?.tls)) parts.push('tls');
    const host = str(opts?.host);
    const path = str(opts?.path);
    if (host) parts.push(`host=${host}`);
    if (path) parts.push(`path=${path}`);
    return { plugin: 'v2ray-plugin', opts: parts.join(';') };
  }

  throw new UnsupportedNodeError(`SIP003-плагин "${plugin}" не поддерживается sing-box`);
}

function finalize(
  name: string,
  protocol: NodeProtocol,
  outbound: SingBoxOutbound,
  serverPort: number,
  server: string,
): ParsedNode {
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new Error(`некорректный порт: ${String(serverPort)}`);
  }
  return {
    name: name.slice(0, 200),
    protocol,
    server,
    serverPort,
    outbound,
    fingerprint: computeFingerprint(outbound),
  };
}
