/** Мелкие безопасные «сужатели» типов для разбора чужого JSON/YAML. */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return undefined;
}

export function strList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.map((v) => str(v)).filter((v): v is string => v !== undefined);
    return list.length > 0 ? list : undefined;
  }
  const single = str(value);
  if (!single) return undefined;
  const list = single
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return list.length > 0 ? list : undefined;
}
