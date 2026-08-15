import { env } from '../config/env.js';
import { SessionModel, UserModel, type IUser } from '../db/models.js';
import { hashPassword, newId, randomString, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { recordEvent } from './events.js';

/**
 * Авторизация по логину и паролю с сессией в cookie.
 *
 * Токен сессии генерируется случайно и в базе хранится только его SHA-256:
 * дамп базы не позволяет войти. Просроченные сессии удаляет сама MongoDB
 * по TTL-индексу на expiresAt.
 */

export const SESSION_COOKIE = 'vtp_session';

export interface AuthenticatedUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

export function toAuthUser(user: IUser): AuthenticatedUser {
  return { id: String(user._id), username: user.username, isAdmin: user.isAdmin };
}

/**
 * Создаёт администратора при первом запуске.
 * Если пароль не задан в окружении — генерирует и печатает ОДИН раз в лог.
 */
export async function bootstrapAdmin(): Promise<void> {
  const count = await UserModel.estimatedDocumentCount();
  if (count > 0) return;

  const username = env.ADMIN_USERNAME.trim() || 'admin';
  const explicit = env.ADMIN_PASSWORD?.trim();
  const password = explicit && explicit.length > 0 ? explicit : randomString(20);

  await UserModel.create({ username, passwordHash: hashPassword(password), isAdmin: true });

  if (explicit) {
    logger.info(`Создан администратор «${username}» с паролем из ADMIN_PASSWORD`);
  } else {
    logger.warn(
      `\n${'═'.repeat(64)}\n` +
        `  Создан администратор панели\n` +
        `    логин:  ${username}\n` +
        `    пароль: ${password}\n` +
        `  Этот пароль показан один раз — сохрани его сейчас.\n` +
        `${'═'.repeat(64)}`,
    );
  }
}

export interface LoginMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: AuthenticatedUser;
}

export async function login(username: string, password: string, meta: LoginMeta): Promise<LoginResult> {
  const user = await UserModel.findOne({ username: username.trim() });

  // Пароль проверяем даже когда пользователя нет: иначе разница во времени
  // ответа выдаёт, какие логины существуют.
  const hash = user?.passwordHash ?? DUMMY_HASH;
  const valid = verifyPassword(password, hash);

  if (!user || !valid) {
    recordEvent('warn', 'auth', `Неудачная попытка входа для «${username}»`, { ip: meta.ip ?? null });
    throw new InvalidCredentialsError();
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);

  await SessionModel.create({
    user: user._id,
    tokenHash: sha256(token),
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });

  user.lastLoginAt = new Date();
  await user.save();

  recordEvent('info', 'auth', `Вход в панель: ${user.username}`, { ip: meta.ip ?? null });
  return { token, expiresAt, user: toAuthUser(user.toObject()) };
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Неверный логин или пароль');
    this.name = 'InvalidCredentialsError';
  }
}

/** Хэш заведомо несуществующего пароля — для выравнивания времени ответа. */
const DUMMY_HASH = hashPassword(newId());

export async function resolveSession(token: string | undefined): Promise<AuthenticatedUser | null> {
  if (!token) return null;

  const session = await SessionModel.findOne({ tokenHash: sha256(token) }).lean();
  if (!session) return null;

  // TTL-индекс Mongo чистит записи с задержкой до минуты — проверяем сами.
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const user = await UserModel.findById(session.user).lean();
  return user ? toAuthUser(user) : null;
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await SessionModel.deleteOne({ tokenHash: sha256(token) });
}

/** Завершает все сессии пользователя — например, после смены пароля. */
export async function logoutEverywhere(userId: string): Promise<number> {
  const result = await SessionModel.deleteMany({ user: userId });
  return result.deletedCount ?? 0;
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw new Error('Новый пароль должен быть не короче 8 символов');

  const user = await UserModel.findById(userId);
  if (!user) throw new Error('Пользователь не найден');
  if (!verifyPassword(currentPassword, user.passwordHash)) throw new InvalidCredentialsError();

  user.passwordHash = hashPassword(newPassword);
  await user.save();

  await logoutEverywhere(userId);
  recordEvent('info', 'auth', `Пароль изменён: ${user.username}`);
}

export async function changeUsername(userId: string, username: string): Promise<AuthenticatedUser> {
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 64) throw new Error('Логин должен быть от 3 до 64 символов');
  if (/\s/.test(trimmed)) throw new Error('Логин не должен содержать пробелы');

  const taken = await UserModel.exists({ username: trimmed, _id: { $ne: userId } });
  if (taken) throw new Error('Такой логин уже занят');

  const user = await UserModel.findByIdAndUpdate(userId, { $set: { username: trimmed } }, { new: true });
  if (!user) throw new Error('Пользователь не найден');

  recordEvent('info', 'auth', `Логин изменён на «${trimmed}»`);
  return toAuthUser(user.toObject());
}
