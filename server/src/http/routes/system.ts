import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { singbox } from '../../core/singbox/supervisor.js';
import { isDatabaseHealthy } from '../../db/index.js';
import { EVENT_LEVELS, ProxyEndpointModel, SubscriptionModel, VpnNodeModel, type EventLevel } from '../../db/models.js';
import { clearEvents, listEvents } from '../../services/events.js';
import { isHealthcheckRunning } from '../../services/healthcheck.js';
import { getSettings, resolvePublicHost } from '../../services/settings.js';
import { getLastSyncError, syncSingBox } from '../../services/singbox-sync.js';
import { parseInput } from '../errors.js';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  /** Публичная проба для Docker healthcheck и балансировщиков. */
  app.get('/api/health', async (_request, reply) => {
    const healthy = isDatabaseHealthy();
    reply.code(healthy ? 200 : 503);
    return { ok: healthy };
  });

  app.get('/api/system/status', async () => {
    const [subscriptions, nodes, nodesEnabled, proxies, proxiesEnabled, proxiesOk, proxiesFail, nodesMissing] =
      await Promise.all([
        SubscriptionModel.countDocuments(),
        VpnNodeModel.countDocuments(),
        VpnNodeModel.countDocuments({ enabled: true }),
        ProxyEndpointModel.countDocuments(),
        ProxyEndpointModel.countDocuments({ enabled: true }),
        ProxyEndpointModel.countDocuments({ status: 'ok' }),
        ProxyEndpointModel.countDocuments({ status: 'fail' }),
        VpnNodeModel.countDocuments({ present: false }),
      ]);

    const settings = getSettings();

    return {
      singbox: singbox.getState(),
      syncError: getLastSyncError(),
      healthcheckRunning: isHealthcheckRunning(),
      publicHost: await resolvePublicHost(),
      portRange: { start: settings.portRangeStart, end: settings.portRangeEnd },
      counts: {
        subscriptions,
        nodes,
        nodesEnabled,
        nodesMissing,
        proxies,
        proxiesEnabled,
        proxiesOk,
        proxiesFail,
      },
    };
  });

  app.post('/api/system/sync', async () => ({ result: await syncSingBox('ручная синхронизация') }));

  app.post('/api/system/restart', async () => {
    await singbox.restart();
    return { state: singbox.getState() };
  });

  app.get('/api/system/logs', async (request) => {
    const { limit } = parseInput(z.object({ limit: z.coerce.number().int().min(1).max(800).default(300) }), request.query);
    return { lines: singbox.getLogs(limit) };
  });

  /** Текущий конфиг ядра — полезно, когда нода не поднимается. */
  app.get('/api/system/config', async () => ({ config: singbox.readCurrentConfig() }));

  app.get('/api/events', async (request) => {
    const query = parseInput(
      z.object({
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        level: z.enum(EVENT_LEVELS as unknown as [EventLevel, ...EventLevel[]]).optional(),
      }),
      request.query,
    );

    const events = await listEvents(query.limit, query.level);
    return {
      events: events.map((event) => ({
        id: String(event._id),
        level: event.level,
        source: event.source,
        message: event.message,
        meta: event.meta,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  });

  app.delete('/api/events', async () => ({ deleted: await clearEvents() }));
}
