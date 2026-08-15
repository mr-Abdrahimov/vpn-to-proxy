/**
 * Подписки в дикой природе кодируются кто во что горазд: стандартный base64,
 * url-safe, с паддингом и без, иногда с переносами строк внутри. Единая точка
 * декодирования избавляет парсеры от этой возни.
 */

/** Управляющие символы, кроме \t, \n и \r — признак двоичных данных. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Символ замены: появляется там, где байты не сложились в корректный UTF-8. */
const REPLACEMENT_CHAR = '�';

function normalizeBase64(input: string): string {
  const cleaned = input.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  return cleaned.length % 4 === 0 ? cleaned : cleaned + '='.repeat(4 - (cleaned.length % 4));
}

export function decodeBase64(input: string): string {
  return Buffer.from(normalizeBase64(input), 'base64').toString('utf8');
}

/**
 * Похоже ли на base64-блоб?
 *
 * Buffer молча «декодирует» любой мусор, поэтому одной проверки алфавита мало:
 * сверяем обратным кодированием и убеждаемся, что получился валидный UTF-8
 * без управляющих символов.
 *
 * Важно: расшифрованная подписка почти всегда содержит пробелы — имена нод
 * вида «🇩🇪 Германия · Стабильный». Наличие пробелов в результате это норма,
 * а не признак того, что мы декодировали не то.
 */
export function looksLikeBase64(input: string): boolean {
  const cleaned = input.replace(/\s/g, '');
  if (cleaned.length < 16) return false;
  if (!/^[A-Za-z0-9+/\-_]+={0,2}$/.test(cleaned)) return false;

  const normalized = normalizeBase64(cleaned);
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length === 0) return false;

  const stripPadding = (value: string) => value.replace(/=+$/, '');
  if (stripPadding(buffer.toString('base64')) !== stripPadding(normalized)) return false;

  const text = buffer.toString('utf8');
  if (text.includes(REPLACEMENT_CHAR)) return false;

  const controlChars = text.match(CONTROL_CHARS);
  return (controlChars?.length ?? 0) / text.length < 0.01;
}

/** Декодирует, если это base64, иначе возвращает исходную строку. */
export function maybeDecodeBase64(input: string): { text: string; wasBase64: boolean } {
  const trimmed = input.trim();
  if (looksLikeBase64(trimmed)) {
    return { text: decodeBase64(trimmed), wasBase64: true };
  }
  return { text: trimmed, wasBase64: false };
}

/** percent-decode, который не падает на некорректной последовательности. */
export function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
