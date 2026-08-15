import { env } from '../config/env.js';
import { ProxyEndpointModel } from '../db/models.js';
import { getSettings } from '../services/settings.js';

/**
 * Выделение портов под прокси.
 *
 * Транзакций здесь нет и не нужно: уникальный индекс по `port` в MongoDB —
 * сам по себе механизм атомарного захвата. Аллокатор лишь предлагает
 * кандидатов, а вставка либо проходит, либо падает с E11000, и вызывающий
 * берёт следующего кандидата.
 */

export class NoFreePortsError extends Error {
  constructor(start: number, end: number) {
    super(`В диапазоне ${start}–${end} не осталось свободных портов. Расширь диапазон в настройках.`);
    this.name = 'NoFreePortsError';
  }
}

/** Порты, которые нельзя отдавать прокси, даже если они попали в диапазон. */
function reservedPorts(): Set<number> {
  return new Set([env.PORT]);
}

/**
 * Возвращает до `count` свободных портов по возрастанию.
 * `alsoTaken` позволяет учесть порты, которые уже выданы в текущей операции,
 * но ещё не записаны в БД.
 */
export async function findFreePorts(count: number, alsoTaken: Iterable<number> = []): Promise<number[]> {
  if (count <= 0) return [];

  const { portRangeStart, portRangeEnd } = getSettings();
  const used = new Set<number>(await ProxyEndpointModel.distinct('port'));
  for (const port of alsoTaken) used.add(port);
  for (const port of reservedPorts()) used.add(port);

  const free: number[] = [];
  for (let port = portRangeStart; port <= portRangeEnd && free.length < count; port += 1) {
    if (!used.has(port)) free.push(port);
  }

  if (free.length < count) throw new NoFreePortsError(portRangeStart, portRangeEnd);
  return free;
}

/** Один свободный порт. */
export async function findFreePort(alsoTaken: Iterable<number> = []): Promise<number> {
  const [port] = await findFreePorts(1, alsoTaken);
  if (port === undefined) throw new NoFreePortsError(getSettings().portRangeStart, getSettings().portRangeEnd);
  return port;
}

/** Проверяет, что порт входит в разрешённый диапазон и не зарезервирован. */
export function assertPortAllowed(port: number): void {
  const { portRangeStart, portRangeEnd } = getSettings();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Некорректный порт: ${port}`);
  }
  if (port < portRangeStart || port > portRangeEnd) {
    throw new Error(`Порт ${port} вне разрешённого диапазона ${portRangeStart}–${portRangeEnd}`);
  }
  if (reservedPorts().has(port)) {
    throw new Error(`Порт ${port} занят самой панелью`);
  }
}

/** Ошибка нарушения уникального индекса MongoDB. */
export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}
