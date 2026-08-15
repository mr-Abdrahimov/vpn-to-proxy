import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Два независимых применения криптографии:
 *
 *  1. Пароли пользователей панели — scrypt (односторонний хэш).
 *  2. Секреты, которые нужно уметь ПОКАЗАТЬ обратно (пароли прокси, содержимое
 *     подписок, ключи нод) — AES-256-GCM с ключом, выведенным из APP_SECRET.
 *
 * Оба ключа выводятся из APP_SECRET через HKDF с разными `info`, чтобы
 * компрометация одного контекста не давала ничего во втором.
 */

const ENC_KEY = crypto.hkdfSync(
  'sha256',
  Buffer.from(env.appSecret, 'utf8'),
  Buffer.from('vpn-to-proxy/field-encryption/v1'),
  Buffer.from('aes-256-gcm'),
  32,
);

const encryptionKey = Buffer.from(ENC_KEY);

const ENC_PREFIX = 'enc.v1';

/** Шифрует строку. Формат: enc.v1.<iv>.<tag>.<ciphertext>, всё в base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_PREFIX, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/**
 * Расшифровывает строку. Значения без префикса возвращаются как есть —
 * это позволяет мигрировать существующие данные без отдельного шага.
 */
export function decryptSecret(value: string): string {
  if (!value.startsWith(`${ENC_PREFIX}.`)) return value;

  const parts = value.split('.');
  const ivRaw = parts[2];
  const tagRaw = parts[3];
  const dataRaw = parts[4];
  if (parts.length !== 5 || !ivRaw || !tagRaw || !dataRaw) {
    throw new Error('Повреждённое зашифрованное значение');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64url')), decipher.final()]).toString('utf8');
}

/** Безопасно расшифровывает: при повреждённых данных возвращает fallback, а не бросает. */
export function tryDecryptSecret(value: string | null | undefined, fallback = ''): string {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return decryptSecret(value);
  } catch {
    return fallback;
  }
}

// ─────────────────────────── Пароли пользователей ───────────────────────────

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 } as const;

/** Хэширует пароль. Формат: scrypt$N$r$p$salt$hash (base64url). */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 256 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/** Проверяет пароль в постоянном времени. Никогда не бросает — только true/false. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw] = stored.split('$');
    if (scheme !== 'scrypt' || !nRaw || !rRaw || !pRaw || !saltRaw || !hashRaw) return false;

    const expected = Buffer.from(hashRaw, 'base64url');
    const derived = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(saltRaw, 'base64url'), expected.length, {
      N: Number.parseInt(nRaw, 10),
      r: Number.parseInt(rRaw, 10),
      p: Number.parseInt(pRaw, 10),
      maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ───────────────────────────── Токены и креды ─────────────────────────────

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Алфавит без символов, которые легко перепутать глазами (0/O, 1/l/I). */
const SAFE_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Случайная строка из «неспутываемого» алфавита, без модуло-смещения. */
export function randomString(length: number, alphabet = SAFE_ALPHABET): string {
  const out: string[] = [];
  // rejection sampling: отбрасываем байты из «хвоста», чтобы распределение было равномерным
  const limit = 256 - (256 % alphabet.length);
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out.push(alphabet[byte % alphabet.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/** Логин прокси по умолчанию: коротко, но не угадывается перебором. */
export function generateProxyUsername(): string {
  return `u${randomString(10)}`;
}

export function generateProxyPassword(): string {
  return randomString(20);
}
