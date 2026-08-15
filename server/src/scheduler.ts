import { logger } from './lib/logger.js';
import { isHealthcheckRunning, runHealthchecks } from './services/healthcheck.js';
import { getSettings } from './services/settings.js';
import { refreshDueSubscriptions } from './services/subscriptions.js';

/**
 * Один тикер на все фоновые задачи.
 *
 * Интервалы живут в настройках и меняются на лету, поэтому не заводим отдельные
 * setInterval под каждую задачу: раз в минуту просыпаемся и решаем, чему пришёл
 * срок. Так изменение настройки применяется сразу, без перезапуска.
 */

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let lastHealthcheckAt = 0;
let ticking = false;

export function startScheduler(): void {
  if (timer) return;

  timer = setInterval(() => {
    void tick();
  }, TICK_MS);

  // Не держим процесс живым только ради таймера.
  timer.unref();
  logger.info('Планировщик фоновых задач запущен');
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;

  try {
    const settings = getSettings();

    if (settings.subscriptionRefreshMinutes > 0) {
      const reports = await refreshDueSubscriptions();
      if (reports.length > 0) {
        logger.info(`Автообновление: обработано подписок — ${reports.length}`);
      }
    }

    if (settings.healthcheckMinutes > 0 && !isHealthcheckRunning()) {
      const dueAt = lastHealthcheckAt + settings.healthcheckMinutes * 60_000;
      if (Date.now() >= dueAt) {
        lastHealthcheckAt = Date.now();
        await runHealthchecks();
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'ошибка в планировщике');
  } finally {
    ticking = false;
  }
}
