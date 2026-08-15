import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Один инстанс логгера на весь процесс: его же получает Fastify, поэтому
 * запросы и фоновые задачи пишутся в один поток с одинаковым форматом.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (env.isProduction ? 'info' : 'debug'),
  ...(env.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

export type Logger = typeof logger;
