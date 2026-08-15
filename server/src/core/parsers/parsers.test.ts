import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { parseSubscriptionContent } from './index.js';
import { parseUri } from './uri.js';

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

describe('парсер ссылок', () => {
  test('VLESS + REALITY + Vision', () => {
    const node = parseUri(
      'vless://11111111-2222-3333-4444-555555555555@example.com:443' +
        '?security=reality&sni=www.microsoft.com&fp=chrome&pbk=ABCDEF&sid=0123abcd&type=tcp&flow=xtls-rprx-vision#Node%20A',
    );

    assert.equal(node.protocol, 'vless');
    assert.equal(node.name, 'Node A');
    assert.equal(node.server, 'example.com');
    assert.equal(node.serverPort, 443);
    assert.equal(node.outbound.flow, 'xtls-rprx-vision');

    const tls = node.outbound.tls as Record<string, unknown>;
    assert.equal(tls.enabled, true);
    assert.equal(tls.server_name, 'www.microsoft.com');
    assert.deepEqual(tls.reality, { enabled: true, public_key: 'ABCDEF', short_id: '0123abcd' });
    // REALITY в sing-box работает только поверх uTLS.
    assert.deepEqual(tls.utls, { enabled: true, fingerprint: 'chrome' });
    // Транспорт tcp не порождает блок transport.
    assert.equal(node.outbound.transport, undefined);
  });

  test('VLESS over WebSocket с early data', () => {
    const node = parseUri(
      'vless://uuid-1@cdn.example.com:8443?security=tls&type=ws&path=%2Fray%3Fed%3D2048&host=front.example.com&sni=front.example.com#WS',
    );

    assert.deepEqual(node.outbound.transport, {
      type: 'ws',
      path: '/ray',
      headers: { Host: 'front.example.com' },
      max_early_data: 2048,
      early_data_header_name: 'Sec-WebSocket-Protocol',
    });
  });

  test('Trojan по умолчанию считается TLS', () => {
    const node = parseUri('trojan://s3cr3t@t.example.com:443?type=grpc&serviceName=grpcsvc#T');
    assert.equal(node.protocol, 'trojan');
    assert.equal(node.outbound.password, 's3cr3t');
    assert.equal((node.outbound.tls as Record<string, unknown>).enabled, true);
    assert.deepEqual(node.outbound.transport, { type: 'grpc', service_name: 'grpcsvc' });
  });

  test('Shadowsocks SIP002 с base64-userinfo', () => {
    const node = parseUri(`ss://${b64('aes-256-gcm:pa55w0rd')}@ss.example.com:8388#SS`);
    assert.equal(node.protocol, 'shadowsocks');
    assert.equal(node.outbound.method, 'aes-256-gcm');
    assert.equal(node.outbound.password, 'pa55w0rd');
    assert.equal(node.serverPort, 8388);
  });

  test('Shadowsocks в legacy-формате (закодирован целиком)', () => {
    const node = parseUri(`ss://${b64('chacha20-ietf-poly1305:pw@1.2.3.4:9000')}#Legacy`);
    assert.equal(node.server, '1.2.3.4');
    assert.equal(node.serverPort, 9000);
    assert.equal(node.outbound.method, 'chacha20-ietf-poly1305');
  });

  test('VMess из base64-JSON', () => {
    const node = parseUri(
      `vmess://${b64(
        JSON.stringify({ v: '2', ps: 'VM', add: 'v.example.com', port: '443', id: 'uuid-2', aid: '0', net: 'ws', path: '/p', host: 'h.example.com', tls: 'tls' }),
      )}`,
    );

    assert.equal(node.protocol, 'vmess');
    assert.equal(node.name, 'VM');
    assert.equal(node.outbound.alter_id, 0);
    assert.deepEqual(node.outbound.transport, { type: 'ws', path: '/p', headers: { Host: 'h.example.com' } });
  });

  test('Hysteria2 с обфускацией', () => {
    const node = parseUri('hysteria2://pw@hy.example.com:8443?sni=hy.example.com&obfs=salamander&obfs-password=xyz#H2');
    assert.equal(node.protocol, 'hysteria2');
    assert.deepEqual(node.outbound.obfs, { type: 'salamander', password: 'xyz' });
  });

  test('неподдерживаемое ядром отбрасывается с причиной', () => {
    assert.throws(() => parseUri('ssr://whatever'), /ShadowsocksR/);
    assert.throws(() => parseUri('vless://u@h:443?type=kcp'), /mKCP/);
    assert.throws(() => parseUri('vless://u@h:443?type=xhttp'), /Xray/);
    assert.throws(() => parseUri('vless://u@h:443?security=reality'), /pbk/);
  });
});

describe('парсер подписок', () => {
  test('base64-подписка со списком ссылок', () => {
    const list = ['vless://uuid-a@a.example.com:443?security=tls#A', 'trojan://pw@b.example.com:443#B'].join('\n');
    const result = parseSubscriptionContent(b64(list));

    assert.equal(result.nodes.length, 2);
    assert.match(result.format, /base64/);
    assert.deepEqual(
      result.nodes.map((n) => n.name),
      ['A', 'B'],
    );
  });

  test('нераспознанные строки попадают в warnings, остальные разбираются', () => {
    const result = parseSubscriptionContent(['vless://uuid-a@a.example.com:443#A', 'полный мусор', 'ssr://xxx'].join('\n'));

    assert.equal(result.nodes.length, 1);
    assert.equal(result.warnings.length, 2);
  });

  test('дубликаты внутри одной подписки схлопываются', () => {
    const uri = 'vless://uuid-a@a.example.com:443?security=tls#A';
    const result = parseSubscriptionContent([uri, `${uri}-copy`, uri].join('\n'));
    assert.equal(result.nodes.length, 1);
  });

  test('конфиг sing-box', () => {
    const config = {
      outbounds: [
        { type: 'direct', tag: 'direct' },
        { type: 'selector', tag: 'select', outbounds: ['direct'] },
        { type: 'trojan', tag: 'Real', server: 'x.example.com', server_port: 443, password: 'p', tls: { enabled: true } },
      ],
    };
    const result = parseSubscriptionContent(JSON.stringify(config));

    assert.equal(result.format, 'sing-box JSON');
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0]?.name, 'Real');
    // Служебные outbound'ы не должны сыпать предупреждениями.
    assert.equal(result.warnings.length, 0);
  });

  test('конфиг Xray конвертируется в outbound sing-box', () => {
    const config = {
      outbounds: [
        { protocol: 'freedom', tag: 'direct' },
        {
          protocol: 'vless',
          tag: 'XR',
          settings: { vnext: [{ address: 'x.example.com', port: 443, users: [{ id: 'uuid-x', flow: 'xtls-rprx-vision' }] }] },
          streamSettings: {
            network: 'ws',
            security: 'tls',
            tlsSettings: { serverName: 'x.example.com', fingerprint: 'chrome' },
            wsSettings: { path: '/xr', headers: { Host: 'x.example.com' } },
          },
        },
      ],
    };
    const result = parseSubscriptionContent(JSON.stringify(config));

    assert.equal(result.format, 'Xray JSON');
    const node = result.nodes[0];
    assert.equal(node?.outbound.type, 'vless');
    assert.equal(node?.outbound.flow, 'xtls-rprx-vision');
    assert.deepEqual(node?.outbound.transport, { type: 'ws', path: '/xr', headers: { Host: 'x.example.com' } });
  });

  test('конфиг Clash YAML', () => {
    const yaml = [
      'proxies:',
      '  - name: "CL"',
      '    type: vless',
      '    server: c.example.com',
      '    port: 443',
      '    uuid: uuid-c',
      '    tls: true',
      '    servername: c.example.com',
      '    network: grpc',
      '    grpc-opts:',
      '      grpc-service-name: svc',
      '  - name: "SS"',
      '    type: ss',
      '    server: s.example.com',
      '    port: 8388',
      '    cipher: aes-128-gcm',
      '    password: pw',
    ].join('\n');

    const result = parseSubscriptionContent(yaml);
    assert.equal(result.format, 'Clash YAML');
    assert.equal(result.nodes.length, 2);
    assert.deepEqual(result.nodes[0]?.outbound.transport, { type: 'grpc', service_name: 'svc' });
    assert.equal(result.nodes[1]?.protocol, 'shadowsocks');
  });
});

describe('отпечаток ноды', () => {
  test('не меняется от косметических правок', () => {
    const base = parseUri('vless://uuid-a@a.example.com:443?security=tls&sni=a.example.com&fp=chrome#Имя 1');
    const renamed = parseUri('vless://uuid-a@a.example.com:443?security=tls&sni=a.example.com&fp=firefox#Имя 2');
    assert.equal(base.fingerprint, renamed.fingerprint);
  });

  test('меняется при смене сервера или учётных данных', () => {
    const a = parseUri('vless://uuid-a@a.example.com:443?security=tls#A');
    const otherHost = parseUri('vless://uuid-a@b.example.com:443?security=tls#A');
    const otherUuid = parseUri('vless://uuid-b@a.example.com:443?security=tls#A');

    assert.notEqual(a.fingerprint, otherHost.fingerprint);
    assert.notEqual(a.fingerprint, otherUuid.fingerprint);
  });
});
