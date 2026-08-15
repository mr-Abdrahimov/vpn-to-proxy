import { EventModel, type EventLevel } from '../db/models.js';
import { logger } from '../lib/logger.js';

/**
 * Журнал событий для UI: обновления подписок, перезапуски sing-box, ошибки
 * health-check. Пишется «в фоне» — падение записи в журнал не должно ронять
 * основную операцию.
 */
export function recordEvent(
  level: EventLevel,
  source: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  logger[level]({ source, ...meta }, message);

  void EventModel.create({ level, source, message, meta: meta ?? null }).catch((error: unknown) => {
    logger.warn({ err: error }, 'не удалось записать событие в журнал');
  });
}

export async function listEvents(limit = 200, level?: EventLevel) {
  return EventModel.find(level ? { level } : {})
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 1000))
    .lean();
}

export async function clearEvents(): Promise<number> {
  const result = await EventModel.deleteMany({});
  return result.deletedCount ?? 0;
}
