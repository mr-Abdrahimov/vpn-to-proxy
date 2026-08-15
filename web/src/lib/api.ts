/**
 * Тонкий клиент к API панели.
 *
 * Ответы сервера всегда JSON, ошибки — объект { error, details }. Здесь это
 * приводится к обычному throw, чтобы в компонентах работать через
 * react-query без ручной проверки response.ok.
 */

export type ProxyKind = 'socks5' | 'http' | 'https';
export type ProxyStatus = 'unknown' | 'ok' | 'fail';
export type NodeProtocol = string;
export type EventLevel = 'info' | 'warn' | 'error';
export type SingBoxStatus = 'stopped' | 'starting' | 'running' | 'failed' | 'binary-missing';

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface Proxy {
  id: string;
  nodeId: string;
  kind: ProxyKind;
  port: number;
  username: string;
  password: string;
  enabled: boolean;
  status: ProxyStatus;
  latencyMs: number | null;
  exitIp: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  url: string;
  host: string;
}

export interface VpnNode {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  name: string;
  protocol: NodeProtocol;
  server: string;
  serverPort: number;
  enabled: boolean;
  present: boolean;
  rawUri: string | null;
  proxies: Proxy[];
}

export interface Subscription {
  id: string;
  name: string;
  /** Справочная заметка «где куплено». В запросах не участвует. */
  source: string | null;
  sourceType: 'url' | 'raw';
  url: string | null;
  /** Пусто — берётся значение по умолчанию из настроек. */
  userAgent: string | null;
  /** Уходит в заголовок x-hwid. */
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

export interface RefreshReport {
  subscriptionId: string;
  name: string;
  format: string;
  total: number;
  added: number;
  updated: number;
  missing: number;
  proxiesCreated: number;
  warnings: { input: string; reason: string }[];
}

export interface Settings {
  publicHost: string;
  proxyListen: string;
  portRangeStart: number;
  portRangeEnd: number;
  defaultProxyKinds: ProxyKind[];
  tlsMode: 'self-signed' | 'custom' | 'files';
  tlsCommonName: string;
  tlsCertPem: string;
  tlsKeyConfigured: boolean;
  tlsCertFile: string;
  tlsKeyFile: string;
  subscriptionRefreshMinutes: number;
  subscriptionUserAgent: string;
  subscriptionHwid: string;
  subscriptionTimeoutMs: number;
  healthcheckMinutes: number;
  healthcheckUrl: string;
  healthcheckConcurrency: number;
  healthcheckTimeoutMs: number;
  singboxLogLevel: string;
}

export interface SystemStatus {
  singbox: {
    status: SingBoxStatus;
    pid: number | null;
    startedAt: string | null;
    lastError: string | null;
    version: string | null;
    binary: string;
    inboundCount: number;
    restarts: number;
    configuredAt: string | null;
  };
  syncError: { message: string; output?: string; at: string } | null;
  healthcheckRunning: boolean;
  publicHost: string;
  portRange: { start: number; end: number };
  counts: {
    subscriptions: number;
    nodes: number;
    nodesEnabled: number;
    nodesMissing: number;
    proxies: number;
    proxiesEnabled: number;
    proxiesOk: number;
    proxiesFail: number;
  };
}

export interface AppEvent {
  id: string;
  level: EventLevel;
  source: string;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Взводится клиентом при 401, чтобы приложение вернулось на экран входа. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, 'Требуется вход');
  }

  const raw = await response.text();
  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Ошибка ${response.status}`;
    const details = payload && typeof payload === 'object' ? (payload as { details?: unknown }).details : undefined;
    throw new ApiError(response.status, message, details);
  }

  return payload as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  auth: {
    me: () => get<{ user: User }>('/auth/me'),
    login: (username: string, password: string) => post<{ user: User }>('/auth/login', { username, password }),
    logout: () => post<{ ok: true }>('/auth/logout'),
    changePassword: (currentPassword: string, newPassword: string) =>
      post<{ ok: true; reloginRequired: boolean }>('/auth/password', { currentPassword, newPassword }),
    changeUsername: (username: string) => post<{ user: User }>('/auth/username', { username }),
  },

  subscriptions: {
    list: () => get<{ subscriptions: Subscription[] }>('/subscriptions'),
    create: (input: {
      name: string;
      source?: string;
      sourceType: 'url' | 'raw';
      url?: string;
      rawContent?: string;
      userAgent?: string;
      hwid?: string;
      autoRefresh?: boolean;
      refreshIntervalMinutes?: number;
    }) => post<{ id: string; report: RefreshReport }>('/subscriptions', input),
    update: (id: string, input: Partial<Subscription> & { rawContent?: string }) =>
      patch<{ subscription: Subscription }>(`/subscriptions/${id}`, input),
    remove: (id: string) => del<{ ok: true }>(`/subscriptions/${id}`),
    refresh: (id: string) => post<{ report: RefreshReport }>(`/subscriptions/${id}/refresh`),
    refreshAll: () =>
      post<{ reports: RefreshReport[]; failures: { id: string; error: string }[] }>('/subscriptions/refresh-all'),
  },

  nodes: {
    list: (params: { subscriptionId?: string; search?: string; status?: ProxyStatus } = {}) => {
      const query = new URLSearchParams();
      if (params.subscriptionId) query.set('subscriptionId', params.subscriptionId);
      if (params.search) query.set('search', params.search);
      if (params.status) query.set('status', params.status);
      const suffix = query.toString();
      return get<{ nodes: VpnNode[]; host: string }>(`/nodes${suffix ? `?${suffix}` : ''}`);
    },
    update: (id: string, input: { enabled?: boolean; name?: string }) => patch<{ ok: true }>(`/nodes/${id}`, input),
    remove: (id: string) => del<{ deleted: number }>(`/nodes/${id}`),
    bulk: (ids: string[], action: 'enable' | 'disable' | 'delete' | 'ensure-proxies', kinds?: ProxyKind[]) =>
      post<{ updated?: number; deleted?: number; created?: number; skipped?: number }>('/nodes/bulk', {
        ids,
        action,
        ...(kinds ? { kinds } : {}),
      }),
    purgeMissing: () => post<{ deleted: number }>('/nodes/purge-missing'),
  },

  proxies: {
    update: (id: string, input: { username?: string; password?: string; port?: number; enabled?: boolean }) =>
      patch<{ proxy: Proxy }>(`/proxies/${id}`, input),
    regenerate: (id: string) => post<{ proxy: Proxy | null }>(`/proxies/${id}/regenerate`),
    remove: (id: string) => del<{ deleted: number }>(`/proxies/${id}`),
    bulk: (ids: string[], action: 'enable' | 'disable' | 'delete' | 'regenerate' | 'check') =>
      post<{
        updated?: number;
        deleted?: number;
        summary?: { checked: number; ok: number; failed: number };
        /** Большие прогоны проверки уходят в фон — итога в ответе не будет. */
        started?: boolean;
        total?: number;
      }>('/proxies/bulk', { ids, action }),
    exportUrl: (params: {
      format: 'uri' | 'hostport' | 'json' | 'csv';
      subscriptionId?: string;
      kinds?: ProxyKind[];
      onlyEnabled?: boolean;
      onlyOk?: boolean;
    }) => {
      const query = new URLSearchParams({ format: params.format });
      if (params.subscriptionId) query.set('subscriptionId', params.subscriptionId);
      if (params.kinds?.length) query.set('kinds', params.kinds.join(','));
      if (params.onlyEnabled) query.set('onlyEnabled', 'true');
      if (params.onlyOk) query.set('onlyOk', 'true');
      return `/api/proxies/export?${query.toString()}`;
    },
  },

  healthcheck: (ids?: string[]) =>
    post<{
      summary?: { checked: number; ok: number; failed: number };
      started?: boolean;
      total?: number;
    }>('/healthcheck', ids ? { ids } : {}),

  settings: {
    get: () => get<{ settings: Settings; resolvedPublicHost: string }>('/settings'),
    update: (input: Partial<Settings> & { tlsKeyPem?: string }) =>
      patch<{ settings: Settings; resolvedPublicHost: string }>('/settings', input),
    caUrl: '/api/settings/ca.crt',
  },

  system: {
    status: () => get<SystemStatus>('/system/status'),
    sync: () => post<{ result: { changed: boolean; bindings: number; error?: string } }>('/system/sync'),
    restart: () => post<{ state: SystemStatus['singbox'] }>('/system/restart'),
    logs: (limit = 300) => get<{ lines: string[] }>(`/system/logs?limit=${limit}`),
    config: () => get<{ config: string | null }>('/system/config'),
  },

  events: {
    list: (limit = 200, level?: EventLevel) =>
      get<{ events: AppEvent[] }>(`/events?limit=${limit}${level ? `&level=${level}` : ''}`),
    clear: () => del<{ deleted: number }>('/events'),
  },
};
