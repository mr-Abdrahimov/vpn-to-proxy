import type { NodeProtocol } from '../../db/models.js';

/** Outbound sing-box. Тег проставляется уже на этапе генерации конфига. */
export type SingBoxOutbound = Record<string, unknown> & { type: string };

/** Результат разбора одного коннекта из подписки — до записи в БД. */
export interface ParsedNode {
  name: string;
  protocol: NodeProtocol;
  server: string;
  serverPort: number;
  outbound: SingBoxOutbound;
  rawUri?: string;
  /** Стабильный идентификатор коннекта, см. fingerprint.ts */
  fingerprint: string;
}

/** Строка подписки, которую разобрать не вышло — показываем пользователю. */
export interface ParseWarning {
  input: string;
  reason: string;
}

export interface ParseResult {
  nodes: ParsedNode[];
  warnings: ParseWarning[];
  /** Человекочитаемый ярлык формата: «base64 + список URI», «sing-box JSON»… */
  format: string;
}

/**
 * Нормализованное описание транспорта/TLS, общее для всех входных форматов.
 * Ссылка vless://, outbound xray и запись Clash приводятся к нему, а дальше
 * один и тот же код собирает из него объекты sing-box.
 */
export interface StreamOptions {
  /** tcp | ws | grpc | http | httpupgrade | quic */
  network?: string;
  /** none | tls | reality */
  security?: string;
  sni?: string;
  /** Host-заголовок для ws/httpupgrade/http */
  host?: string;
  path?: string;
  serviceName?: string;
  alpn?: string[];
  /** uTLS-отпечаток: chrome, firefox, safari, randomized… */
  fingerprint?: string;
  /** REALITY */
  publicKey?: string;
  shortId?: string;
  insecure?: boolean;
  /** headerType=http у tcp-транспорта */
  headerType?: string;
}

export class UnsupportedNodeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsupportedNodeError';
  }
}
