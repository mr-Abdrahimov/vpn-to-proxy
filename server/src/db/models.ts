import { Schema, model, type Model, type Types } from 'mongoose';

/**
 * Все модели живут в одном файле намеренно: их немного, а связи между ними
 * (подписка → нода → прокси) читаются лучше, когда видны рядом.
 *
 * Поля, помеченные «зашифровано», хранят строку формата enc.v1.… из lib/crypto.
 * Наружу они уходят только через явные сериализаторы в слое API — на toJSON
 * мы не полагаемся, чтобы случайно не отдать секрет.
 */

const baseOptions = {
  timestamps: true,
  versionKey: false,
} as const;

// ───────────────────────────── Пользователи панели ─────────────────────────────

export interface IUser {
  _id: Types.ObjectId;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true },
    isAdmin: { type: Boolean, required: true, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  baseOptions,
);

export const UserModel: Model<IUser> = model<IUser>('User', userSchema);

// ──────────────────────────────── Сессии ────────────────────────────────

export interface ISession {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  /** В базе только SHA-256 от токена: дамп базы не даёт войти. */
  tokenHash: string;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    // TTL-индекс: Mongo сама удалит просроченные сессии, отдельная чистка не нужна.
    expiresAt: { type: Date, required: true, expires: 0 },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  baseOptions,
);

export const SessionModel: Model<ISession> = model<ISession>('Session', sessionSchema);

// ──────────────────────────────── Подписки ────────────────────────────────

/** 'url' — тянем по ссылке; 'raw' — пользователь вставил содержимое руками. */
export const SUBSCRIPTION_SOURCES = ['url', 'raw'] as const;
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number];

export interface ISubscription {
  _id: Types.ObjectId;
  name: string;
  /** Свободная заметка «где куплено» — чисто справочная, в запросах не участвует. */
  source: string | null;
  sourceType: SubscriptionSource;
  /** Зашифровано: ссылка на подписку часто сама по себе является секретом. */
  url: string | null;
  /** Зашифровано: сырое содержимое (для 'raw' — введённое, для 'url' — кэш последней загрузки). */
  rawContent: string | null;
  /** Ярлык распознанного формата, например «base64 + список URI». */
  detectedFormat: string | null;
  /**
   * User-Agent конкретной подписки. Провайдеры отдают разный формат в
   * зависимости от него, поэтому иногда его нужно задать точечно.
   * Пусто — берётся значение по умолчанию из настроек.
   */
  userAgent: string | null;
  /**
   * Идентификатор устройства. Панели с привязкой к устройству (Remnawave)
   * без заголовка x-hwid отдают одну ноду-заглушку вместо реального списка.
   * Хранится зашифрованным: по сути это часть учётных данных подписки.
   */
  hwid: string | null;
  /**
   * Устаревшее поле: произвольные заголовки в виде зашифрованного JSON.
   * Оставлено только ради переноса данных в userAgent/hwid, см. migrateLegacyHeaders().
   */
  headers: string | null;
  enabled: boolean;
  autoRefresh: boolean;
  refreshIntervalMinutes: number;
  lastFetchedAt: Date | null;
  lastError: string | null;
  nodeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    name: { type: String, required: true, trim: true },
    source: { type: String, default: null, trim: true },
    sourceType: { type: String, required: true, enum: SUBSCRIPTION_SOURCES },
    url: { type: String, default: null },
    rawContent: { type: String, default: null },
    detectedFormat: { type: String, default: null },
    userAgent: { type: String, default: null, trim: true },
    hwid: { type: String, default: null },
    headers: { type: String, default: null },
    enabled: { type: Boolean, required: true, default: true },
    autoRefresh: { type: Boolean, required: true, default: true },
    refreshIntervalMinutes: { type: Number, required: true, default: 360, min: 5 },
    lastFetchedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    nodeCount: { type: Number, required: true, default: 0 },
  },
  baseOptions,
);

export const SubscriptionModel: Model<ISubscription> = model<ISubscription>('Subscription', subscriptionSchema);

// ────────────────────────────── Ноды (коннекты) ──────────────────────────────

export const NODE_PROTOCOLS = [
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'socks',
  'http',
  'hysteria2',
  'tuic',
  'anytls',
] as const;
export type NodeProtocol = (typeof NODE_PROTOCOLS)[number];

export interface IVpnNode {
  _id: Types.ObjectId;
  subscription: Types.ObjectId;
  /**
   * Стабильный отпечаток коннекта (протокол + адрес + порт + креды + ключевые
   * параметры транспорта). По нему при обновлении подписки мы узнаём «ту же»
   * ноду и сохраняем за ней уже выданные порты и пароли прокси.
   */
  fingerprint: string;
  name: string;
  protocol: NodeProtocol;
  server: string;
  serverPort: number;
  /** Зашифровано: готовый outbound-объект sing-box в виде JSON-строки. */
  outboundJson: string;
  /** Зашифровано: исходная ссылка vless://… — для справки и реэкспорта. */
  rawUri: string | null;
  enabled: boolean;
  /** false — ноды больше нет в подписке после обновления (прокси при этом не удаляются молча). */
  present: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const vpnNodeSchema = new Schema<IVpnNode>(
  {
    subscription: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true, index: true },
    fingerprint: { type: String, required: true },
    name: { type: String, required: true },
    protocol: { type: String, required: true, enum: NODE_PROTOCOLS },
    server: { type: String, required: true },
    serverPort: { type: Number, required: true },
    outboundJson: { type: String, required: true },
    rawUri: { type: String, default: null },
    enabled: { type: Boolean, required: true, default: true },
    present: { type: Boolean, required: true, default: true },
    sortOrder: { type: Number, required: true, default: 0 },
  },
  baseOptions,
);

// Одна и та же нода не может встретиться в одной подписке дважды.
vpnNodeSchema.index({ subscription: 1, fingerprint: 1 }, { unique: true });

export const VpnNodeModel: Model<IVpnNode> = model<IVpnNode>('VpnNode', vpnNodeSchema);

// ──────────────────────────── Выданные прокси ────────────────────────────

export const PROXY_KINDS = ['socks5', 'http', 'https'] as const;
export type ProxyKind = (typeof PROXY_KINDS)[number];

export const PROXY_STATUSES = ['unknown', 'ok', 'fail'] as const;
export type ProxyStatus = (typeof PROXY_STATUSES)[number];

export interface IProxyEndpoint {
  _id: Types.ObjectId;
  node: Types.ObjectId;
  kind: ProxyKind;
  port: number;
  username: string;
  /** Зашифровано. Пользователь должен уметь его посмотреть, поэтому не хэш. */
  password: string;
  enabled: boolean;

  status: ProxyStatus;
  latencyMs: number | null;
  exitIp: string | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const proxyEndpointSchema = new Schema<IProxyEndpoint>(
  {
    node: { type: Schema.Types.ObjectId, ref: 'VpnNode', required: true, index: true },
    kind: { type: String, required: true, enum: PROXY_KINDS },
    // Порт уникален глобально — это и есть механизм атомарного выделения:
    // при гонке второй insert упадёт с E11000 и аллокатор возьмёт следующий.
    port: { type: Number, required: true, unique: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: true },

    status: { type: String, required: true, enum: PROXY_STATUSES, default: 'unknown' },
    latencyMs: { type: Number, default: null },
    exitIp: { type: String, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  baseOptions,
);

// На одну ноду — не больше одного прокси каждого вида.
proxyEndpointSchema.index({ node: 1, kind: 1 }, { unique: true });

export const ProxyEndpointModel: Model<IProxyEndpoint> = model<IProxyEndpoint>('ProxyEndpoint', proxyEndpointSchema);

// ──────────────────────────── Настройки и журнал ────────────────────────────

export interface ISetting {
  _id: string;
  value: unknown;
  updatedAt: Date;
}

const settingSchema = new Schema<ISetting>(
  {
    _id: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false, _id: false },
);

export const SettingModel: Model<ISetting> = model<ISetting>('Setting', settingSchema);

export const EVENT_LEVELS = ['info', 'warn', 'error'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export interface IEvent {
  _id: Types.ObjectId;
  level: EventLevel;
  source: string;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: Date;
}

const eventSchema = new Schema<IEvent>(
  {
    level: { type: String, required: true, enum: EVENT_LEVELS, default: 'info' },
    source: { type: String, required: true },
    message: { type: String, required: true },
    meta: { type: Schema.Types.Mixed, default: null },
    // Журнал самоочищается через 30 дней.
    createdAt: { type: Date, default: Date.now, expires: '30d' },
  },
  { versionKey: false, timestamps: false },
);

eventSchema.index({ createdAt: -1 });

export const EventModel: Model<IEvent> = model<IEvent>('Event', eventSchema);

export const allModels = [
  UserModel,
  SessionModel,
  SubscriptionModel,
  VpnNodeModel,
  ProxyEndpointModel,
  SettingModel,
  EventModel,
] as const;
