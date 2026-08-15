import { singbox } from './core/singbox/supervisor.js';
import { env } from './config/env.js';
import { closeDatabase, connectDatabase } from './db/index.js';
import { buildApp } from './http/app.js';
import { logger } from './lib/logger.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { bootstrapAdmin } from './services/auth.js';
import { loadSettings } from './services/settings.js';
import { migrateLegacyHeaders } from './services/subscriptions.js';
import { syncSingBox } from './services/singbox-sync.js';

/**
 * Порядок запуска важен:
 *   БД → настройки → администратор → ядро → конфиг → HTTP.
 * Панель поднимается даже если sing-box не стартовал: тогда пользователь
 * увидит ошибку в интерфейсе и сможет её починить, а не будет гадать,
 * почему приложение не отвечает.
 */
async function main(): Promise<void> {
  await connectDatabase(logger);
  await loadSettings();
  await bootstrapAdmin();
  await migrateLegacyHeaders();

  await singbox.init();

  const sync = await syncSingBox('запуск приложения');
  if (sync.error) {
    logger.error(`sing-box не запущен: ${sync.error}`);
  } else {
    logger.info(`sing-box: активных прокси — ${sync.bindings}`);
  }

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info(`Панель доступна на http://${env.HOST}:${env.PORT}`);

  startScheduler();
  installShutdownHandlers(app);
}

function installShutdownHandlers(app: Awaited<ReturnType<typeof buildApp>>): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Получен ${signal}, останавливаюсь…`);

      stopScheduler();
      // Сначала перестаём принимать запросы, потом гасим ядро и рвём соединение с БД.
      await app.close().catch((error: unknown) => logger.error({ err: error }, 'ошибка остановки HTTP'));
      await singbox.stop().catch((error: unknown) => logger.error({ err: error }, 'ошибка остановки sing-box'));
      await closeDatabase().catch((error: unknown) => logger.error({ err: error }, 'ошибка закрытия БД'));

      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'необработанное отклонение промиса');
  });
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'не удалось запустить приложение');
  process.exit(1);
});
