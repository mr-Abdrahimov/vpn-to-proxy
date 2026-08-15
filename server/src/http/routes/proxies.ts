import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROXY_KINDS, PROXY_STATUSES, ProxyEndpointModel, type ProxyKind } from '../../db/models.js';
import { runHealthchecks } from '../../services/healthcheck.js';
import { listNodes } from '../../services/nodes.js';
import {
  EXPORT_FORMATS,
  deleteProxies,
  regenerateCredentials,
  renderExport,
  setEnabled,
  toProxyDto,
  updateProxy,
  type ExportRow,
} from '../../services/proxies.js';
import { resolvePublicHost } from '../../services/settings.js';
import { scheduleSync } from '../../services/singbox-sync.js';
import { conflict, notFound, parseInput } from '../errors.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'некорректный идентификатор');

const updateSchema = z.object({
  username: z.string().min(1).max(64).optional(),
  password: z.string().min(1).max(128).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  enabled: z.boolean().optional(),
});

const bulkSchema = z.object({
  ids: z.array(objectId).min(1, 'не выбран ни один прокси').max(5000),
  action: z.enum(['enable', 'disable', 'delete', 'regenerate', 'check']),
});

const exportQuerySchema = z.object({
  format: z.enum(EXPORT_FORMATS as unknown as [string, ...string[]]).default('uri'),
  subscriptionId: objectId.optional(),
  kinds: z.string().optional(),
  onlyEnabled: z.coerce.boolean().optional(),
  onlyOk: z.coerce.boolean().optional(),
});

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  app.patch('/api/proxies/:id', async (request) => {
    const { id } = parseInput(z.object({ id: objectId }), request.params);
    const body = parseInput(updateSchema, request.body);

    if (Object.keys(body).length === 0) throw conflict('Нечего менять');

    const updated = await updateProxy(id, body);
    scheduleSync('изменение прокси');

    const host = await resolvePublicHost();
    return { proxy: toProxyDto(updated, host) };
  });

  app.post('/api/proxies/:id/regenerate', async (request) => {
    const { id } = parseInput(z.object({ id: objectId }), request.params);
    const updated = await regenerateCredentials([id]);
    if (updated === 0) throw notFound('Прокси не найден');

    scheduleSync('перевыпуск учётных данных');

    const proxy = await ProxyEndpointModel.findById(id).lean();
    const host = await resolvePublicHost();
    return { proxy: proxy ? toProxyDto(proxy, host) : null };
  });

  app.delete('/api/proxies/:id', async (request) => {
    const { id } = parseInput(z.object({ id: objectId }), request.params);
    const deleted = await deleteProxies([id]);
    if (deleted > 0) scheduleSync('удаление прокси');
    return { deleted };
  });

  app.post('/api/proxies/bulk', async (request) => {
    const body = parseInput(bulkSchema, request.body);

    switch (body.action) {
      case 'enable': {
        const updated = await setEnabled(body.ids, true);
        scheduleSync('включение прокси');
        return { updated };
      }
      case 'disable': {
        const updated = await setEnabled(body.ids, false);
        scheduleSync('выключение прокси');
        return { updated };
      }
      case 'delete': {
        const deleted = await deleteProxies(body.ids);
        scheduleSync('удаление прокси');
        return { deleted };
      }
      case 'regenerate': {
        const updated = await regenerateCredentials(body.ids);
        scheduleSync('перевыпуск учётных данных');
        return { updated };
      }
      case 'check':
        return { summary: await runHealthchecks(body.ids) };
    }
  });

  app.get('/api/proxies/export', async (request, reply) => {
    const query = parseInput(exportQuerySchema, request.query);
    const host = await resolvePublicHost();

    const nodes = await listNodes({ host, ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}) });

    const requestedKinds = query.kinds
      ? new Set(query.kinds.split(',').filter((kind): kind is ProxyKind => (PROXY_KINDS as readonly string[]).includes(kind)))
      : null;

    let rows: ExportRow[] = nodes.flatMap((node) => node.proxies.map((proxy) => ({ ...proxy, nodeName: node.name })));
    if (requestedKinds) rows = rows.filter((row) => requestedKinds.has(row.kind));
    if (query.onlyEnabled) rows = rows.filter((row) => row.enabled);
    if (query.onlyOk) rows = rows.filter((row) => row.status === 'ok');

    const rendered = renderExport(rows, query.format as (typeof EXPORT_FORMATS)[number]);

    reply.header('Content-Type', rendered.contentType);
    reply.header('Content-Disposition', `attachment; filename="${rendered.filename}"`);
    return rendered.body;
  });

  app.post('/api/healthcheck', async (request) => {
    const body = parseInput(
      z.object({ ids: z.array(objectId).max(5000).optional(), status: z.enum(PROXY_STATUSES as unknown as [string, ...string[]]).optional() }),
      request.body ?? {},
    );

    return { summary: await runHealthchecks(body.ids) };
  });
}
