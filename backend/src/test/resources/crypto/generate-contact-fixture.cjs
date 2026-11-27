'use strict';
// 합성 fixture 생성기(테스트 전용, 실제 키·실제 연락처 아님). scripts/migrate-workspace.cjs 의 seal() 과 같은 알고리즘이다.
// 사용: node generate-contact-fixture.cjs > contact-envelope-fixture.json
const crypto = require('node:crypto');
function seal(value, key, aad, iv) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return JSON.stringify({ version: 1, keyVersion: 'v1', aad, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), body: body.toString('base64') });
}
// 가상 키: 0x00..0x1f (32바이트). 가상 번호만 사용한다.
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const lib = 'lib-synthetic';
const cases = [
  { name: 'migrated', phone: '010-0000-1234', sourceId: 'person-src-1', aad: `SMOA:v1:${lib}:TGMSTR:person-src-1:PHONE_ENC`, iv: Buffer.from(Array.from({ length: 12 }, (_, i) => i + 1)) },
  { name: 'web-created', phone: '+82 10 0000 5678', targetId: '42', aad: `SMOA:v1:${lib}:TGMSTR:db:42:PHONE_ENC`, iv: Buffer.from(Array.from({ length: 12 }, (_, i) => 100 + i)) },
];
console.log(JSON.stringify({
  keyHex: key.toString('hex'), library: lib,
  cases: cases.map((c) => ({ ...c, iv: undefined, envelope: seal(c.phone, key, c.aad, c.iv) })),
}, null, 2));
