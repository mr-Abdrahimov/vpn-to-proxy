/**
 * Диагностика подписки без запуска панели.
 *
 *   npx tsx scripts/probe-subscription.ts <url|файл> [-H "x-hwid: ..."]...
 *
 * Показывает распознанный формат, разбор по протоколам, предупреждения и
 * несколько собранных outbound'ов. Незаменимо, когда провайдер отдаёт что-то
 * нестандартное и надо понять, что именно.
 */
import fs from 'node:fs';
import { parseSubscriptionContent } from '../src/core/parsers/index.js';

const args = process.argv.slice(2);
const source = args[0];

if (!source) {
  console.error('Использование: tsx scripts/probe-subscription.ts <url|файл> [-H "Заголовок: значение"]...');
  process.exit(1);
}

const headers: Record<string, string> = { 'User-Agent': 'v2rayNG/1.8.23', Accept: '*/*' };
for (let i = 1; i < args.length; i += 1) {
  if (args[i] !== '-H') continue;
  const raw = args[i + 1];
  if (!raw) continue;
  const separator = raw.indexOf(':');
  if (separator > 0) headers[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
}

const content = /^https?:\/\//i.test(source)
  ? await fetch(source, { headers }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response.text();
    })
  : fs.readFileSync(source, 'utf8');

const result = parseSubscriptionContent(content);

console.log(`Формат:          ${result.format}`);
console.log(`Разобрано нод:   ${result.nodes.length}`);
console.log(`Предупреждений:  ${result.warnings.length}`);

const byProtocol = new Map<string, number>();
const byTransport = new Map<string, number>();
const bySecurity = new Map<string, number>();

for (const node of result.nodes) {
  byProtocol.set(node.protocol, (byProtocol.get(node.protocol) ?? 0) + 1);

  const transport = node.outbound.transport as { type?: string } | undefined;
  const key = transport?.type ?? 'tcp';
  byTransport.set(key, (byTransport.get(key) ?? 0) + 1);

  const tls = node.outbound.tls as { enabled?: boolean; reality?: unknown } | undefined;
  const security = !tls?.enabled ? 'none' : tls.reality ? 'reality' : 'tls';
  bySecurity.set(security, (bySecurity.get(security) ?? 0) + 1);
}

const show = (title: string, map: Map<string, number>) => {
  console.log(`\n${title}`);
  for (const [key, count] of [...map].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(14)} ${count}`);
  }
};

show('Протоколы:', byProtocol);
show('Транспорт:', byTransport);
show('Безопасность:', bySecurity);

if (result.warnings.length > 0) {
  console.log('\nПредупреждения:');
  for (const warning of result.warnings.slice(0, 20)) {
    console.log(`  • ${warning.reason}\n    ${warning.input.slice(0, 100)}`);
  }
}

console.log('\nПримеры собранных outbound sing-box:');
for (const node of result.nodes.slice(0, 3)) {
  console.log(`\n  ${node.name}`);
  console.log(
    JSON.stringify(node.outbound, null, 2)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  );
}

// Отпечатки должны быть уникальны — иначе ноды будут «схлопываться» при сверке.
const fingerprints = new Set(result.nodes.map((node) => node.fingerprint));
console.log(`\nУникальных отпечатков: ${fingerprints.size} из ${result.nodes.length}`);
