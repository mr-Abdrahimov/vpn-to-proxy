import type { ProxyKind } from '../../db/models.js';
import type { SingBoxOutbound } from '../parsers/types.js';

/**
 * Сборка конфига sing-box.
 *
 * Схема одна и та же для любого числа коннектов:
 *   inbound (socks/http/https с логином и паролем)
 *      └─ route rule по тегу inbound
 *            └─ outbound конкретной VPN-ноды
 *
 * Один outbound обслуживает все виды прокси своей ноды, поэтому socks5, http
 * и https одной ноды выходят через одно и то же соединение.
 *
 * Формат — современный (sing-box ≥ 1.11): правила маршрутизации пишутся через
 * `action: "route"`, устаревшие поля inbound (sniff, domain_strategy) и
 * outbound `block` не используются — в 1.13 они удалены.
 */

export interface ProxyBinding {
  proxyId: string;
  kind: ProxyKind;
  port: number;
  username: string;
  /** Уже расшифрованный пароль. */
  password: string;
  nodeId: string;
  nodeName: string;
  outbound: SingBoxOutbound;
}

export interface BuildOptions {
  bindings: ProxyBinding[];
  /** Интерфейс для прослушивания прокси-портов. */
  listen: string;
  logLevel: string;
  /** Пути к сертификату и ключу — обязательны, если есть хоть один https-прокси. */
  tls?: { certificatePath: string; keyPath: string };
}

export type SingBoxConfig = Record<string, unknown>;

export const DIRECT_TAG = 'direct';

export function inboundTag(proxyId: string): string {
  return `in-${proxyId}`;
}

export function outboundTag(nodeId: string): string {
  return `out-${nodeId}`;
}

export function buildSingBoxConfig(options: BuildOptions): SingBoxConfig {
  const { bindings, listen, logLevel, tls } = options;

  const needsTls = bindings.some((binding) => binding.kind === 'https');
  if (needsTls && !tls) {
    throw new Error('Есть HTTPS-прокси, но не переданы пути к сертификату и ключу');
  }

  const inbounds: Record<string, unknown>[] = [];
  const rules: Record<string, unknown>[] = [];
  const outbounds = new Map<string, Record<string, unknown>>();

  for (const binding of bindings) {
    const inTag = inboundTag(binding.proxyId);
    const outTag = outboundTag(binding.nodeId);

    inbounds.push(buildInbound(binding, inTag, listen, tls));

    // Каждый inbound обязан иметь правило: без него трафик ушёл бы в `final`,
    // то есть напрямую с адреса сервера. Это была бы утечка, а не «фолбэк».
    rules.push({ inbound: [inTag], action: 'route', outbound: outTag });

    if (!outbounds.has(outTag)) {
      outbounds.set(outTag, { ...binding.outbound, tag: outTag });
    }
  }

  const config: SingBoxConfig = {
    log: { level: logLevel, timestamp: true },
    inbounds,
    // direct нужен как значение route.final: сюда попадают только служебные
    // соединения самого sing-box (например, резолв адреса ноды).
    outbounds: [{ type: 'direct', tag: DIRECT_TAG }, ...outbounds.values()],
    route: { rules, final: DIRECT_TAG },
  };

  assertEveryInboundRouted(config);
  return config;
}

function buildInbound(
  binding: ProxyBinding,
  tag: string,
  listen: string,
  tls: BuildOptions['tls'],
): Record<string, unknown> {
  const users = [{ username: binding.username, password: binding.password }];

  switch (binding.kind) {
    case 'socks5':
      return { type: 'socks', tag, listen, listen_port: binding.port, users };

    case 'http':
      return { type: 'http', tag, listen, listen_port: binding.port, users };

    case 'https':
      return {
        type: 'http',
        tag,
        listen,
        listen_port: binding.port,
        users,
        tls: {
          enabled: true,
          certificate_path: tls!.certificatePath,
          key_path: tls!.keyPath,
        },
      };
  }
}

/** Страховка от утечки: каждый слушающий порт должен быть привязан к ноде. */
function assertEveryInboundRouted(config: SingBoxConfig): void {
  const inbounds = config.inbounds as { tag: string }[];
  const route = config.route as { rules: { inbound?: string[] }[] };

  const routed = new Set<string>();
  for (const rule of route.rules) {
    for (const tag of rule.inbound ?? []) routed.add(tag);
  }

  const orphans = inbounds.filter((inbound) => !routed.has(inbound.tag)).map((inbound) => inbound.tag);
  if (orphans.length > 0) {
    throw new Error(`Внутренняя ошибка: inbound без правила маршрутизации: ${orphans.join(', ')}`);
  }
}

/** Стабильная сериализация — по ней сравниваем «конфиг изменился или нет». */
export function serializeConfig(config: SingBoxConfig): string {
  return JSON.stringify(config, null, 2);
}
