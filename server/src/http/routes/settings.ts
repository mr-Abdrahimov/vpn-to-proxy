import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readCaCertificate } from '../../core/tls.js';
import { PROXY_KINDS, type ProxyKind } from '../../db/models.js';
import { getSettings, resolvePublicHost, updateSettings, type AppSettings } from '../../services/settings.js';
import { scheduleSync } from '../../services/singbox-sync.js';
import { notFound, parseInput } from '../errors.js';

const patchSchema = z.object({
  publicHost: z.string().trim().max(255).optional(),
  proxyListen: z.string().trim().min(1).max(64).optional(),
  portRangeStart: z.number().int().min(1024).max(65535).optional(),
  portRangeEnd: z.number().int().min(1024).max(65535).optional(),
  defaultProxyKinds: z
    .array(z.enum(PROXY_KINDS as unknown as [ProxyKind, ...ProxyKind[]]))
    .min(1, 'выбери хотя бы один вид прокси')
    .optional(),
  tlsMode: z.enum(['self-signed', 'custom', 'files']).optional(),
  tlsCommonName: z.string().trim().max(255).optional(),
  tlsCertPem: z.string().max(64 * 1024).optional(),
  tlsKeyPem: z.string().max(64 * 1024).optional(),
  tlsCertFile: z.string().trim().max(512).optional(),
  tlsKeyFile: z.string().trim().max(512).optional(),
  subscriptionRefreshMinutes: z.number().int().min(0).max(43200).optional(),
  subscriptionUserAgent: z.string().trim().min(1).max(255).optional(),
  subscriptionHwid: z.string().trim().max(255).optional(),
  healthcheckMinutes: z.number().int().min(0).max(1440).optional(),
  healthcheckUrl: z.string().url().optional(),
  healthcheckConcurrency: z.number().int().min(1).max(64).optional(),
  healthcheckTimeoutMs: z.number().int().min(1000).max(60000).optional(),
  singboxLogLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic']).optional(),
});

/** Приватный ключ наружу не отдаём — только факт, что он задан. */
function toPublicSettings(settings: AppSettings) {
  const { tlsKeyPem, ...rest } = settings;
  return { ...rest, tlsKeyConfigured: tlsKeyPem.trim().length > 0 };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => ({
    settings: toPublicSettings(getSettings()),
    resolvedPublicHost: await resolvePublicHost(),
  }));

  app.patch('/api/settings', async (request) => {
    const body = parseInput(patchSchema, request.body);
    const before = getSettings();

    const updated = await updateSettings(body);

    // Всё, что влияет на конфиг ядра, требует пересборки и перезапуска.
    const affectsConfig =
      body.proxyListen !== undefined ||
      body.singboxLogLevel !== undefined ||
      body.tlsMode !== undefined ||
      body.tlsCertPem !== undefined ||
      body.tlsKeyPem !== undefined ||
      body.tlsCommonName !== undefined ||
      (body.publicHost !== undefined && body.publicHost !== before.publicHost);

    if (affectsConfig) scheduleSync('изменение настроек');

    return { settings: toPublicSettings(updated), resolvedPublicHost: await resolvePublicHost() };
  });

  /** Корневой сертификат для доверия HTTPS-прокси. */
  app.get('/api/settings/ca.crt', async (_request, reply) => {
    const pem = readCaCertificate();
    if (!pem) throw notFound('Локальный CA ещё не выпущен — создай хотя бы один HTTPS-прокси');

    reply.header('Content-Type', 'application/x-pem-file');
    reply.header('Content-Disposition', 'attachment; filename="vpn-to-proxy-ca.crt"');
    return pem;
  });
}
