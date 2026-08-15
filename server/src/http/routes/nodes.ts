import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROXY_KINDS, PROXY_STATUSES, type ProxyKind } from '../../db/models.js';
import { deleteNodes, listNodes, purgeMissingNodes, setNodesEnabled, updateNode } from '../../services/nodes.js';
import { ensureProxiesForNodes } from '../../services/proxies.js';
import { getSettings, resolvePublicHost } from '../../services/settings.js';
import { scheduleSync } from '../../services/singbox-sync.js';
import { parseInput } from '../errors.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'некорректный идентификатор');

const listQuerySchema = z.object({
  subscriptionId: objectId.optional(),
  search: z.string().max(200).optional(),
  status: z.enum(PROXY_STATUSES as unknown as [string, ...string[]]).optional(),
  enabledOnly: z.coerce.boolean().optional(),
  includeRawUri: z.coerce.boolean().optional(),
});

const bulkSchema = z.object({
  ids: z.array(objectId).min(1, 'не выбрана ни одна нода').max(2000),
  action: z.enum(['enable', 'disable', 'delete', 'ensure-proxies']),
  kinds: z.array(z.enum(PROXY_KINDS as unknown as [ProxyKind, ...ProxyKind[]])).optional(),
});

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/nodes', async (request) => {
    const query = parseInput(listQuerySchema, request.query);
    const host = await resolvePublicHost();

    const nodes = await listNodes({
      host,
      ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.status ? { status: query.status as (typeof PROXY_STATUSES)[number] } : {}),
      ...(query.enabledOnly ? { enabledOnly: true } : {}),
      ...(query.includeRawUri ? { includeRawUri: true } : {}),
    });

    return { nodes, host };
  });

  app.patch('/api/nodes/:id', async (request) => {
    const { id } = parseInput(z.object({ id: objectId }), request.params);
    const body = parseInput(
      z.object({ enabled: z.boolean().optional(), name: z.string().min(1).max(200).optional() }),
      request.body,
    );

    await updateNode(id, body);
    return { ok: true };
  });

  app.delete('/api/nodes/:id', async (request) => {
    const { id } = parseInput(z.object({ id: objectId }), request.params);
    return { deleted: await deleteNodes([id]) };
  });

  app.post('/api/nodes/bulk', async (request) => {
    const body = parseInput(bulkSchema, request.body);

    switch (body.action) {
      case 'enable':
        return { updated: await setNodesEnabled(body.ids, true) };
      case 'disable':
        return { updated: await setNodesEnabled(body.ids, false) };
      case 'delete':
        return { deleted: await deleteNodes(body.ids) };
      case 'ensure-proxies': {
        const kinds = body.kinds && body.kinds.length > 0 ? body.kinds : getSettings().defaultProxyKinds;
        const result = await ensureProxiesForNodes(body.ids, kinds);
        if (result.created > 0) scheduleSync('созданы прокси');
        return result;
      }
    }
  });

  /** Удаляет ноды, пропавшие из подписок, вместе с их прокси. */
  app.post('/api/nodes/purge-missing', async () => ({ deleted: await purgeMissingNodes() }));
}
