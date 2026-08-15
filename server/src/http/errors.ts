import type { z } from 'zod';

/** Ошибка с явным HTTP-статусом. Всё остальное обработчик считает 500. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = 'Требуется вход') => new HttpError(401, message);
export const notFound = (message = 'Не найдено') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

/** Разбор тела/квери через zod с превращением ошибок в понятный 400. */
export function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(корень)',
    message: issue.message,
  }));
  const first = details[0];
  throw badRequest(first ? `${first.field}: ${first.message}` : 'Некорректные данные запроса', details);
}
