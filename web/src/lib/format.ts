const dateTime = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTime.format(date);
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : time.format(date);
}

/** «3 мин назад» — читается быстрее, чем абсолютная метка, в списках событий. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'никогда';

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'никогда';

  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 45) return 'только что';
  if (seconds < 90) return 'минуту назад';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;

  return formatDateTime(value);
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`;
}

export function formatDuration(minutes: number): string {
  if (minutes === 0) return 'выключено';
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минута', 'минуты', 'минут')}`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} ${plural(Math.round(hours), 'час', 'часа', 'часов')}`;
}

/** Русские числительные: 1 нода, 2 ноды, 5 нод. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export const PROXY_KIND_LABELS: Record<string, string> = {
  socks5: 'SOCKS5',
  http: 'HTTP',
  https: 'HTTPS',
};
