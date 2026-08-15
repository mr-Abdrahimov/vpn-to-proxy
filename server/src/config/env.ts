import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Переменные окружения — это только «загрузочные» настройки: то, что нужно знать
 * до того, как поднимется база. Всё, что пользователь меняет в рантайме
 * (публичный хост, диапазон портов, режим TLS…), живёт в коллекции settings
 * и лишь инициализируется значениями отсюда.
 */

const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
    });

const intFromEnv = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : defaultValue;
    })
    .pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  PORT: intFromEnv(8080, 1, 65535),
  HOST: z.string().default('0.0.0.0'),

  APP_SECRET: z.string().optional(),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().optional(),
  SESSION_TTL_HOURS: intFromEnv(720, 1, 24 * 365),
  TRUST_PROXY: boolFromEnv(false),
  SECURE_COOKIES: boolFromEnv(false),

  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/vpn_to_proxy'),

  DATA_DIR: z.string().default('./data'),

  SINGBOX_BIN: z.string().default('sing-box'),

  PUBLIC_HOST: z.string().optional(),
  PROXY_LISTEN: z.string().default('0.0.0.0'),
  PROXY_PORT_START: intFromEnv(20000, 1024, 65535),
  PROXY_PORT_END: intFromEnv(29999, 1024, 65535),

  /** Значения по умолчанию для загрузки подписок; меняются потом в панели. */
  SUBSCRIPTION_USER_AGENT: z.string().optional(),
  SUBSCRIPTION_HWID: z.string().optional(),

  SUBSCRIPTION_REFRESH_MINUTES: intFromEnv(360, 0, 60 * 24 * 30),
  HEALTHCHECK_MINUTES: intFromEnv(15, 0, 60 * 24),
  HEALTHCHECK_URL: z.string().url().default('https://api.ipify.org?format=json'),
});

export type Env = z.infer<typeof envSchema> & {
  dataDir: string;
  appSecret: string;
  isProduction: boolean;
};

/**
 * APP_SECRET не задан — не падаем, а генерируем один раз и кладём в DATA_DIR
 * с правами 0600. Так `npm run dev` работает «из коробки», при этом секрет
 * остаётся стабильным между перезапусками (иначе разлогинило бы всех
 * и сломало расшифровку сохранённых паролей).
 */
function resolveAppSecret(explicit: string | undefined, dataDir: string): string {
  if (explicit && explicit.trim().length > 0) {
    if (explicit.trim().length < 32) {
      throw new Error('APP_SECRET слишком короткий: нужно минимум 32 символа. Сгенерировать: openssl rand -base64 48');
    }
    return explicit.trim();
  }

  const secretFile = path.join(dataDir, 'app-secret');
  if (fs.existsSync(secretFile)) {
    const stored = fs.readFileSync(secretFile, 'utf8').trim();
    if (stored.length >= 32) return stored;
  }

  const generated = crypto.randomBytes(48).toString('base64');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${issues}`);
  }

  const value = parsed.data;

  if (value.PROXY_PORT_END <= value.PROXY_PORT_START) {
    throw new Error('PROXY_PORT_END должен быть больше PROXY_PORT_START');
  }

  const dataDir = path.resolve(process.cwd(), value.DATA_DIR);
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    ...value,
    dataDir,
    appSecret: resolveAppSecret(value.APP_SECRET, dataDir),
    isProduction: value.NODE_ENV === 'production',
  };
}

export const env: Env = load();

export const paths = {
  dataDir: env.dataDir,
  singboxDir: path.join(env.dataDir, 'sing-box'),
  singboxConfig: path.join(env.dataDir, 'sing-box', 'config.json'),
  singboxConfigCandidate: path.join(env.dataDir, 'sing-box', 'config.candidate.json'),
  tlsDir: path.join(env.dataDir, 'tls'),
  caCert: path.join(env.dataDir, 'tls', 'ca.crt'),
  caKey: path.join(env.dataDir, 'tls', 'ca.key'),
  proxyCert: path.join(env.dataDir, 'tls', 'proxy.crt'),
  proxyKey: path.join(env.dataDir, 'tls', 'proxy.key'),
  webRoot: path.resolve(process.cwd(), 'public'),
} as const;

for (const dir of [paths.singboxDir, paths.tlsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
