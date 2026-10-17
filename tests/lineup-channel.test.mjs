import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 新通道必须先被 _routes.json include，否则 Pages 在 Function 运行之前就回 404
// （site.yml 里记过同类事故：admin 页曾因 Functions 未部署整页死掉）。
test('the lineup data channel is routed', () => {
  const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', '_routes.json'), 'utf8'));
  assert.ok((routes.include || []).includes('/api/lineup/*'), '/api/lineup/* 必须在 _routes.json 的 include 里');
});

test('the lineup channel reuses the upload handlers instead of duplicating them', () => {
  for (const name of ['begin', 'put', 'commit']) {
    const file = path.join(ROOT, 'functions', 'api', 'lineup', `${name}.js`);
    assert.ok(fs.existsSync(file), `functions/api/lineup/${name}.js 不存在`);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /forcedSource/, `${name}.js 必须把来源钉死成 LINEUP_SOURCE`);
    assert.match(text, new RegExp(`cdn/upload/${name}\\.js`), `${name}.js 应复用主通道的同名 handler`);
  }
});
