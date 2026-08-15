import crypto from 'node:crypto';
import type { SingBoxOutbound } from './types.js';

/**
 * Отпечаток должен отвечать на вопрос «это тот же самый коннект?» при
 * очередном обновлении подписки. Поэтому в него входит только то, что задаёт
 * идентичность соединения: протокол, адрес, порт, учётные данные и ключевые
 * параметры транспорта.
 *
 * Сознательно НЕ входят: имя ноды, alpn, uTLS-отпечаток, флаг insecure.
 * Провайдеры меняют их косметически, а мы не хотим из-за этого выдавать
 * пользователю новый порт и новый пароль на, по сути, тот же сервер.
 */
export function computeFingerprint(outbound: SingBoxOutbound): string {
  const transport = asRecord(outbound.transport);
  const tls = asRecord(outbound.tls);

  const identity = {
    type: outbound.type,
    server: String(outbound.server ?? '').toLowerCase(),
    port: Number(outbound.server_port ?? 0),
    credential: pickCredential(outbound),
    network: typeof transport?.type === 'string' ? transport.type : 'tcp',
    route: String(transport?.path ?? transport?.service_name ?? ''),
    sni: String(tls?.server_name ?? ''),
  };

  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32);
}

/** Учётные данные различаются по протоколам — собираем всё, что может быть. */
function pickCredential(outbound: SingBoxOutbound): string {
  const parts = [outbound.uuid, outbound.password, outbound.private_key]
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.join('|');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
