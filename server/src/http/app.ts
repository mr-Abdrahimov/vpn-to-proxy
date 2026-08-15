import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { env, paths } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { registerAuth } from './auth-plugin.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes/index.js';

/** Ошибки этих типов означают баг в коде, а не неверный ввод пользователя. */
const PROGRAMMING_ERRORS = new Set(['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError']);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Приведение к базовому типу оставляет FastifyInstance в дефолтной форме —
    // иначе конкретный тип pino протекает во все сигнатуры плагинов и роутов.
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: env.TRUST_PROXY,
    // Подписку можно вставить текстом — она бывает объёмной.
    bodyLimit: 24 * 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    // Панель не встраивает сторонние ресурсы, а COEP ломает предпросмотр в dev.
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cookie, { secret: env.appSecret });

  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: 'Слишком много запросов, подожди немного' }),
  });

  await registerAuth(app);
  await registerRoutes(app);

  await registerStatic(app);
  registerErrorHandling(app);

  return app;
}

/** Собранный фронтенд отдаётся тем же процессом — отдельный веб-сервер не нужен. */
async function registerStatic(app: FastifyInstance): Promise<void> {
  if (!fs.existsSync(paths.webRoot)) {
    app.log.warn(`Каталог со сборкой фронтенда не найден: ${paths.webRoot}. Доступен только API.`);
    return;
  }

  await app.register(fastifyStatic, {
    root: paths.webRoot,
    prefix: '/',
    index: ['index.html'],
    // Хэшированные ассеты Vite можно кэшировать надолго, index.html — нет.
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (/\/assets\//.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });
}

function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Метод API не найден' });
      return;
    }

    // Любой другой путь — это маршрут SPA: отдаём index.html.
    const indexFile = path.join(paths.webRoot, 'index.html');
    if (request.method === 'GET' && fs.existsSync(indexFile)) {
      reply.type('text/html').header('Cache-Control', 'no-cache').send(fs.createReadStream(indexFile));
      return;
    }

    reply.code(404).send({ error: 'Не найдено' });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ error: error.message, details: error.details });
      return;
    }

    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : null;
    if (status && status < 500) {
      reply.code(status).send({ error: error.message });
      return;
    }

    // Ошибки бизнес-логики несут понятный текст и адресованы пользователю;
    // сбои уровня рантайма прячем за общей формулировкой и пишем в лог.
    if (!PROGRAMMING_ERRORS.has(error.name) && error.message) {
      request.log.warn({ err: error }, 'запрос отклонён');
      reply.code(400).send({ error: error.message });
      return;
    }

    request.log.error({ err: error }, 'необработанная ошибка');
    reply.code(500).send({ error: 'Внутренняя ошибка сервера' });
  });
}
