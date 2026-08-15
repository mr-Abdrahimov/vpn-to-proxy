import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SubscriptionModel } from '../../db/models.js';
import {
  createSubscription,
  deleteSubscription,
  refreshDueSubscriptions,
  refreshSubscription,
  toSubscriptionDto,
  updateSubscription,
} from '../../services/subscriptions.js';
import { notFound, parseInput } from '../errors.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'некорректный идентификатор');

const createSchema = z
  .object({
    name: z.string().min(1, 'Введите название').max(120),
    sourceType: z.enum(['url', 'raw']),
    url: z.string().trim().optional(),
    rawContent: z.string().optional(),
    headers: z.record(z.string().max(255)).optional(),
    autoRefresh: z.boolean().optional(),
    refreshIntervalMinutes: z.number().int().min(5).max(43200).optional(),
  })
  .refine((value) => (value.sourceType === 'url' ? Boolean(value.url) : Boolean(value.rawContent?.trim())), {
    message: 'Укажи ссылку на подписку или вставь её содержимое',
  });

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().trim().optional(),
  rawContent: z.string().optional(),
  headers: z.record(z.string().max(255)).optional(),
  enabled: z.boolean().optional(),
  autoRefresh: z.boolean().optional(),
  refreshIntervalMinutes: z.number().int().min(5).max(43200).optional(),
});

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/subscriptions', async () => {
    const list = await SubscriptionModel.find().sort({ createdAt: 1 });
    return { subscriptions: list.map((sub) => toSubscriptionDto(sub.toObject())) };
  });

  app.post('/api/subscriptions', async (request, reply) => {
    const body = parseInput(createSchema, request.body);
    const result = await createSubscription(body);
    reply.code(201);
    return result;
  });

  app.patch('/api/subscriptions/:id', async (request) => {
    const { id } = parseInput(z.object({ id: objectId }), request.params);
    const body = parseInput(updateSchema, request.body);
    const updated = await updateSubscription(id, body);
    return { subscription: toSubscriptionDto(updated) };
  });

  app.delete('/api/subscriptions/:id', async (request) => {
    const { id } = parseInput(z.object({ id: objectId }), request.params);
    const exists = await SubscriptionModel.exists({ _id: id });
    if (!exists) throw notFound('Подписка не найдена');

    await deleteSubscription(id);
    return { ok: true };
  });

  app.post('/api/subscriptions/:id/refresh', async (request) => {
    const { id } = parseInput(z.object({ id: objectId }), request.params);
    return { report: await refreshSubscription(id) };
  });

  app.post('/api/subscriptions/refresh-all', async () => {
    const subscriptions = await SubscriptionModel.find({ enabled: true }).select({ _id: 1 }).lean();

    const reports = [];
    const failures: { id: string; error: string }[] = [];

    for (const sub of subscriptions) {
      try {
        reports.push(await refreshSubscription(String(sub._id)));
      } catch (error) {
        failures.push({ id: String(sub._id), error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { reports, failures };
  });

  // Прогон только тех подписок, у которых подошёл срок — используется планировщиком,
  // но полезен и вручную.
  app.post('/api/subscriptions/refresh-due', async () => ({ reports: await refreshDueSubscriptions() }));
}
