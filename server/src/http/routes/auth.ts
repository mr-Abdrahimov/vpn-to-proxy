import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  InvalidCredentialsError,
  SESSION_COOKIE,
  changePassword,
  changeUsername,
  login,
  logout,
} from '../../services/auth.js';
import { clearSessionCookie, requireUser, setSessionCookie } from '../auth-plugin.js';
import { HttpError, parseInput } from '../errors.js';

const loginSchema = z.object({
  username: z.string().min(1, 'Введите логин').max(64),
  password: z.string().min(1, 'Введите пароль').max(256),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Новый пароль должен быть не короче 8 символов').max(256),
});

const usernameSchema = z.object({
  username: z.string().min(3).max(64),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/auth/login',
    {
      // Отдельный, жёсткий лимит: перебор пароля должен упираться в стену
      // раньше, чем в общий лимит API.
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const body = parseInput(loginSchema, request.body);

      try {
        const result = await login(body.username, body.password, {
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        setSessionCookie(reply, result.token, result.expiresAt);
        return { user: result.user };
      } catch (error) {
        if (error instanceof InvalidCredentialsError) throw new HttpError(401, error.message);
        throw error;
      }
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    await logout(request.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => ({ user: requireUser(request) }));

  app.post('/api/auth/password', async (request, reply) => {
    const user = requireUser(request);
    const body = parseInput(passwordSchema, request.body);

    try {
      await changePassword(user.id, body.currentPassword, body.newPassword);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) throw new HttpError(400, 'Текущий пароль неверен');
      throw error;
    }

    // Смена пароля завершает все сессии, включая текущую.
    clearSessionCookie(reply);
    return { ok: true, reloginRequired: true };
  });

  app.post('/api/auth/username', async (request) => {
    const user = requireUser(request);
    const body = parseInput(usernameSchema, request.body);
    return { user: await changeUsername(user.id, body.username) };
  });
}
