import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { SESSION_COOKIE, resolveSession, type AuthenticatedUser } from '../services/auth.js';
import { unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/** Пути под /api, доступные без сессии. */
const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/health']);

export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const user = await resolveSession(token);
      if (user) request.user = user;
    }
  });

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    if (PUBLIC_PATHS.has(path)) return;
    if (!request.user) throw unauthorized();
  });
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.SECURE_COOKIES,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) throw unauthorized();
  return request.user;
}
