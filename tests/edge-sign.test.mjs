import test from 'node:test';
import assert from 'node:assert/strict';

import { presignPut, r2Config, signedHeaders } from '../functions/api/cdn/upload/_edge.js';

// 这两个形状各对应一次真实翻车：
//   1) 凭证里的 / 没百分号编码 → R2 重算出的 canonical query 与 URL 上的不一致 → SignatureDoesNotMatch；
//   2) path-style 少了桶名前缀 → 键的第一段被当成桶名 → NoSuchBucket（而 HEAD 的 404 又会被读成「键不存在」）。
// 所以这里断言的是「签出去的路径与查询串长什么样」，不是「有没有报错」。
const CFG = r2Config({
  R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: '0123456789abcdef0123456789abcdef',
  R2_SECRET_ACCESS_KEY: 'b'.repeat(64),
  R2_BUCKET: 'stronghold-assets',
});

test('signed requests address the bucket first, then the key', async () => {
  const { canonicalUri, headers } = await signedHeaders(CFG, 'HEAD', 'assets/char/mod 1.png');
  assert.equal(canonicalUri, '/stronghold-assets/assets/char/mod%201.png');
  assert.match(headers.Authorization, /Signature=[0-9a-f]{64}/);
  assert.equal(new URL(`https://${CFG.host}${canonicalUri}`).pathname, '/stronghold-assets/assets/char/mod%201.png');
});

test('a presigned PUT carries the bucket in the path and an encoded credential', async () => {
  const url = await presignPut(CFG, 'cdn/incoming/abc123/mod.png');
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/stronghold-assets/cdn/incoming/abc123/mod.png');
  const credential = parsed.searchParams.get('X-Amz-Credential');
  // 解码后要还原成完整 scope；日期段取自 X-Amz-Date，不是随手写的常量。
  const dateStamp = parsed.searchParams.get('X-Amz-Date').slice(0, 8);
  assert.equal(credential, `0123456789abcdef0123456789abcdef/${dateStamp}/auto/s3/aws4_request`);
  // 关键：URL 上那一串里凭证的斜杠必须是 %2F，否则服务端的 canonical query 与签名的不是同一份。
  const rawQuery = url.split('?')[1];
  const credentialField = rawQuery.split('&').find((p) => p.startsWith('X-Amz-Credential='));
  assert.ok(!credentialField.includes('/'), `credential 不能带裸斜杠：${credentialField}`);
  assert.match(credentialField, /%2F/);
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.match(rawQuery, /X-Amz-Signature=[0-9a-f]{64}$/);
});

test('missing R2 configuration is an explicit error, not a silent empty result', () => {
  assert.throws(() => r2Config({}), /R2 配置不全/);
  assert.throws(() => r2Config({ R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com' }), /R2_ACCESS_KEY_ID/);
});
