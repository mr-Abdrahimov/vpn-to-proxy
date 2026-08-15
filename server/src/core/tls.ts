import crypto from 'node:crypto';
import fs from 'node:fs';
import forge from 'node-forge';
import { paths } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getSettings, resolvePublicHost } from '../services/settings.js';

/**
 * Сертификаты для HTTPS-прокси (CONNECT поверх TLS).
 *
 * Два режима:
 *   • self-signed — панель выпускает собственный CA и подписывает им серверный
 *     сертификат. CA можно скачать из интерфейса и добавить в доверенные,
 *     тогда HTTPS-прокси работает без ключа «игнорировать сертификат».
 *   • custom — пользователь приносит свои cert/key (например, от Let's Encrypt).
 *
 * Ключи генерируем нативным crypto (быстро), а X.509 собираем через node-forge:
 * в Node нет публичного API для выпуска сертификатов.
 */

const CERT_META = `${paths.tlsDir}/cert.meta.json`;
const CA_VALIDITY_YEARS = 10;
const LEAF_VALIDITY_DAYS = 825; // максимум, который принимают браузеры
const RENEW_BEFORE_DAYS = 30;

interface CertMeta {
  mode: string;
  sans: string[];
  notAfter: string;
}

export interface ProxyCertificate {
  certPath: string;
  keyPath: string;
}

/**
 * Гарантирует наличие валидного сертификата и возвращает пути к файлам.
 * Перевыпускает, если сменился список имён или до истечения меньше месяца.
 */
export async function ensureProxyCertificate(): Promise<ProxyCertificate> {
  const settings = getSettings();

  if (settings.tlsMode === 'files') {
    // Сертификат живёт на диске и обновляется снаружи (certbot). Ничего не
    // копируем: sing-box читает файлы сам, а после продления его перезапустят.
    const certPath = settings.tlsCertFile.trim();
    const keyPath = settings.tlsKeyFile.trim();

    if (!certPath || !keyPath) {
      throw new Error('Режим TLS "files" выбран, но пути к сертификату и ключу не заданы');
    }
    for (const [label, file] of [
      ['сертификата', certPath],
      ['ключа', keyPath],
    ] as const) {
      if (!fs.existsSync(file)) {
        throw new Error(`Файл ${label} не найден внутри контейнера: ${file}`);
      }
      try {
        fs.accessSync(file, fs.constants.R_OK);
      } catch {
        throw new Error(`Файл ${label} не читается: ${file}`);
      }
    }

    return { certPath, keyPath };
  }

  if (settings.tlsMode === 'custom') {
    if (!settings.tlsCertPem.trim() || !settings.tlsKeyPem.trim()) {
      throw new Error('Режим TLS "custom" выбран, но сертификат или ключ не заданы в настройках');
    }
    fs.writeFileSync(paths.proxyCert, settings.tlsCertPem.trim() + '\n', { mode: 0o644 });
    fs.writeFileSync(paths.proxyKey, settings.tlsKeyPem.trim() + '\n', { mode: 0o600 });
    writeMeta({ mode: 'custom', sans: [], notAfter: new Date(0).toISOString() });
    return { certPath: paths.proxyCert, keyPath: paths.proxyKey };
  }

  const sans = await collectSans();
  if (!needsReissue(sans)) {
    return { certPath: paths.proxyCert, keyPath: paths.proxyKey };
  }

  logger.info({ sans }, 'выпускаю сертификат для HTTPS-прокси');
  issueSelfSigned(sans);
  return { certPath: paths.proxyCert, keyPath: paths.proxyKey };
}

/** PEM корневого сертификата — его пользователь скачивает и добавляет в доверенные. */
export function readCaCertificate(): string | null {
  return fs.existsSync(paths.caCert) ? fs.readFileSync(paths.caCert, 'utf8') : null;
}

/** Имена, которые должны попасть в сертификат: настроенное CN, публичный хост, localhost. */
async function collectSans(): Promise<string[]> {
  const settings = getSettings();
  const names = new Set<string>(['localhost', '127.0.0.1']);

  const common = settings.tlsCommonName.trim();
  if (common) names.add(common);

  const publicHost = await resolvePublicHost();
  if (publicHost) names.add(publicHost);

  return [...names].sort();
}

function needsReissue(sans: string[]): boolean {
  if (!fs.existsSync(paths.proxyCert) || !fs.existsSync(paths.proxyKey) || !fs.existsSync(paths.caCert)) return true;

  const meta = readMeta();
  if (!meta || meta.mode !== 'self-signed') return true;
  if (meta.sans.join(',') !== sans.join(',')) return true;

  const notAfter = new Date(meta.notAfter).getTime();
  if (!Number.isFinite(notAfter)) return true;
  return notAfter - Date.now() < RENEW_BEFORE_DAYS * 24 * 60 * 60 * 1000;
}

function issueSelfSigned(sans: string[]): void {
  const ca = loadOrCreateCa();

  const leafKeys = generateRsaKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = leafKeys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 60_000); // запас на рассинхрон часов
  cert.validity.notAfter = new Date(Date.now() + LEAF_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  // CN современными клиентами не проверяется — решает SAN, — но именно CN
  // видно в выводе openssl и в диалогах браузера, поэтому ставим туда то имя,
  // по которому к прокси реально обращаются.
  const configuredName = getSettings().tlsCommonName.trim();
  const commonName = configuredName || sans.find((name) => !isIpLiteral(name)) || sans[0] || 'localhost';
  cert.setSubject([{ name: 'commonName', value: commonName }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: sans.map((name) => (isIpLiteral(name) ? { type: 7, ip: name } : { type: 2, value: name })),
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  // Клиенту нужна вся цепочка: лист + CA.
  const chain = forge.pki.certificateToPem(cert) + forge.pki.certificateToPem(ca.cert);
  fs.writeFileSync(paths.proxyCert, chain, { mode: 0o644 });
  fs.writeFileSync(paths.proxyKey, forge.pki.privateKeyToPem(leafKeys.privateKey), { mode: 0o600 });

  writeMeta({ mode: 'self-signed', sans, notAfter: cert.validity.notAfter.toISOString() });
}

function loadOrCreateCa(): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } {
  if (fs.existsSync(paths.caCert) && fs.existsSync(paths.caKey)) {
    try {
      return {
        cert: forge.pki.certificateFromPem(fs.readFileSync(paths.caCert, 'utf8')),
        key: forge.pki.privateKeyFromPem(fs.readFileSync(paths.caKey, 'utf8')),
      };
    } catch (error) {
      logger.warn({ err: error }, 'существующий CA не читается, выпускаю новый');
    }
  }

  const keys = generateRsaKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + CA_VALIDITY_YEARS * 365 * 24 * 60 * 60 * 1000);

  const attrs = [
    { name: 'commonName', value: 'vpn-to-proxy local CA' },
    { name: 'organizationName', value: 'vpn-to-proxy' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(paths.caCert, forge.pki.certificateToPem(cert), { mode: 0o644 });
  fs.writeFileSync(paths.caKey, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  logger.info('выпущен новый локальный CA для HTTPS-прокси');

  return { cert, key: keys.privateKey };
}

/**
 * Генерация ключа нативным crypto: чистый JS в node-forge на 2048 бит
 * занимает секунды и блокирует event loop.
 */
function generateRsaKeyPair(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey } {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const forgePrivate = forge.pki.privateKeyFromPem(privateKey);
  return { privateKey: forgePrivate, publicKey: forge.pki.setRsaPublicKey(forgePrivate.n, forgePrivate.e) };
}

/** Серийный номер должен быть положительным: ведущий 00 гарантирует это. */
function randomSerial(): string {
  return `00${crypto.randomBytes(16).toString('hex')}`;
}

function readMeta(): CertMeta | null {
  try {
    return JSON.parse(fs.readFileSync(CERT_META, 'utf8')) as CertMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: CertMeta): void {
  fs.writeFileSync(CERT_META, JSON.stringify(meta, null, 2));
}

function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  return value.includes(':') && /^[0-9a-f:]+$/i.test(value);
}
