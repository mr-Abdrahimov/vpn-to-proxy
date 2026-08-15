import { Types } from 'mongoose';
import { ProxyEndpointModel, SubscriptionModel, VpnNodeModel, type NodeProtocol, type ProxyStatus } from '../db/models.js';
import { tryDecryptSecret } from '../lib/crypto.js';
import { toProxyDto, type ProxyDto } from './proxies.js';
import { scheduleSync } from './singbox-sync.js';

/** Нода вместе со всеми выданными на неё прокси — основная единица в интерфейсе. */
export interface NodeDto {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  name: string;
  protocol: NodeProtocol;
  server: string;
  serverPort: number;
  enabled: boolean;
  /** false — нода пропала из подписки при последнем обновлении. */
  present: boolean;
  rawUri: string | null;
  proxies: ProxyDto[];
}

export interface ListNodesOptions {
  host: string;
  subscriptionId?: string;
  /** Поиск по имени ноды, адресу сервера и логину прокси. */
  search?: string;
  status?: ProxyStatus;
  enabledOnly?: boolean;
  includeRawUri?: boolean;
}

export async function listNodes(options: ListNodesOptions): Promise<NodeDto[]> {
  const filter: Record<string, unknown> = {};
  if (options.subscriptionId) filter.subscription = new Types.ObjectId(options.subscriptionId);
  if (options.enabledOnly) filter.enabled = true;

  const nodes = await VpnNodeModel.find(filter).sort({ subscription: 1, sortOrder: 1 }).lean();
  if (nodes.length === 0) return [];

  const subscriptions = await SubscriptionModel.find({ _id: { $in: nodes.map((n) => n.subscription) } })
    .select({ name: 1 })
    .lean();
  const subscriptionNames = new Map(subscriptions.map((s) => [String(s._id), s.name]));

  const proxies = await ProxyEndpointModel.find({ node: { $in: nodes.map((n) => n._id) } })
    .sort({ kind: 1, port: 1 })
    .lean();

  const proxiesByNode = new Map<string, ProxyDto[]>();
  for (const proxy of proxies) {
    const key = String(proxy.node);
    const list = proxiesByNode.get(key) ?? [];
    list.push(toProxyDto(proxy, options.host));
    proxiesByNode.set(key, list);
  }

  let result: NodeDto[] = nodes.map((node) => ({
    id: String(node._id),
    subscriptionId: String(node.subscription),
    subscriptionName: subscriptionNames.get(String(node.subscription)) ?? '—',
    name: node.name,
    protocol: node.protocol,
    server: node.server,
    serverPort: node.serverPort,
    enabled: node.enabled,
    present: node.present,
    rawUri: options.includeRawUri && node.rawUri ? tryDecryptSecret(node.rawUri) : null,
    proxies: proxiesByNode.get(String(node._id)) ?? [],
  }));

  // Фильтры по поиску и статусу применяем в памяти: статус живёт на прокси,
  // а результат нужен на уровне ноды — в БД это был бы неудобный aggregate.
  const search = options.search?.trim().toLowerCase();
  if (search) {
    result = result.filter(
      (node) =>
        node.name.toLowerCase().includes(search) ||
        node.server.toLowerCase().includes(search) ||
        node.subscriptionName.toLowerCase().includes(search) ||
        node.proxies.some((proxy) => proxy.username.toLowerCase().includes(search) || String(proxy.port) === search),
    );
  }

  if (options.status) {
    result = result.filter((node) => node.proxies.some((proxy) => proxy.status === options.status));
  }

  return result;
}

export async function updateNode(id: string, patch: { enabled?: boolean; name?: string }): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('Имя ноды не может быть пустым');
    update.name = name.slice(0, 200);
  }

  const result = await VpnNodeModel.updateOne({ _id: id }, { $set: update });
  if (result.matchedCount === 0) throw new Error('Нода не найдена');

  if (patch.enabled !== undefined) scheduleSync('переключение ноды');
}

export async function setNodesEnabled(ids: string[], enabled: boolean): Promise<number> {
  const result = await VpnNodeModel.updateMany({ _id: { $in: ids } }, { $set: { enabled } });
  scheduleSync('массовое переключение нод');
  return result.modifiedCount;
}

export async function deleteNodes(ids: string[]): Promise<number> {
  await ProxyEndpointModel.deleteMany({ node: { $in: ids } });
  const result = await VpnNodeModel.deleteMany({ _id: { $in: ids } });
  scheduleSync('удаление нод');
  return result.deletedCount ?? 0;
}

/** Удаляет все ноды, пропавшие из подписок, вместе с их прокси. */
export async function purgeMissingNodes(): Promise<number> {
  const ids = await VpnNodeModel.find({ present: false }).distinct('_id');
  if (ids.length === 0) return 0;
  return deleteNodes(ids.map(String));
}
