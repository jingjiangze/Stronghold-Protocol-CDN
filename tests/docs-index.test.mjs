// Which document the admin page hands out as "the integration instructions".
//
// The page used to hard-code `/docs/agent-upload.md`. That is the failure this module exists to
// remove: rename the document or publish a newer one and the page keeps answering with the old path.
// The rule is "the newest document that describes the upload channel", and the interesting case is
// the negative one below — the site carries newer documents that are *not* upload instructions, and
// picking the newest overall would hand an agent a bandwidth write-up as its upload contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  AGENT_DOC_MARKER,
  extractTitle,
  injectAdminKey,
  isAgentDoc,
  pickAgentDoc,
  sortDocs,
} from '../src/docs-index.mjs';
import { buildDocsIndex } from '../src/docs-index-build.mjs';

const doc = (p, updatedAt, agent) => ({ path: p, updatedAt, agent, bytes: 1, sha256: 'x', title: p });

test('a document is the integration one when it describes the upload channel', () => {
  assert.equal(isAgentDoc('POST /api/cdn/upload/begin'), true);
  assert.equal(isAgentDoc('# WS 链路压缩（当前已上线）'), false);
  assert.equal(isAgentDoc(''), false);
  assert.equal(isAgentDoc(null), false);
});

test('the title is the first heading, without markdown noise', () => {
  assert.equal(extractTitle('# agent 接入 · 上传静态素材\n\n正文'), 'agent 接入 · 上传静态素材');
  assert.equal(extractTitle('前言\n\n## 小标题\n\n# 真标题'), '真标题');
  assert.equal(extractTitle('# `带反引号` 的标题'), '带反引号 的标题');
  assert.equal(extractTitle('没有标题'), '');
});

// The case that matters. Newest-overall here is a bandwidth document; handing that to an agent as
// its upload instructions would be worse than a stale path, because it looks authoritative.
test('a newer unrelated document never becomes the integration instructions', () => {
  const docs = [
    doc('docs/bandwidth-max-compression.md', '2026-10-10T18:26:00+08:00', false),
    doc('docs/asset-cdn-reconcile.md', '2026-10-10T17:54:00+08:00', false),
    doc('docs/agent-upload.md', '2026-10-10T02:47:00+08:00', true),
  ];
  const picked = pickAgentDoc(docs);
  assert.equal(picked.path, 'docs/agent-upload.md');
  assert.match(picked.why, /最新一份/);
});

test('among several integration documents the newest wins, whatever the filename', () => {
  const docs = [
    doc('docs/z-old.md', '2026-01-01T00:00:00Z', true),
    doc('docs/a-new.md', '2026-10-10T00:00:00Z', true),
    doc('docs/newest-of-all.md', '2026-12-31T00:00:00Z', false),
  ];
  assert.equal(pickAgentDoc(docs).path, 'docs/a-new.md');
});

test('with nothing marked, it falls back to the newest and says so', () => {
  const picked = pickAgentDoc([doc('docs/a.md', '2026-01-01T00:00:00Z', false), doc('docs/b.md', '2026-02-01T00:00:00Z', false)]);
  assert.equal(picked.path, 'docs/b.md');
  assert.match(picked.why, /没有任何文档提到|退回到最新/);
  assert.deepEqual(pickAgentDoc([]), { path: '', why: '还没有任何文档' });
});

test('newest first, ties broken by path so the published index is stable', () => {
  const sorted = sortDocs([
    doc('docs/b.md', '2026-01-01T00:00:00Z', false),
    doc('docs/a.md', '2026-01-01T00:00:00Z', false),
    doc('docs/c.md', '2026-03-01T00:00:00Z', false),
  ]);
  assert.deepEqual(sorted.map((d) => d.path), ['docs/c.md', 'docs/a.md', 'docs/b.md']);
});

// Copying "the instructions" without the key is the failure this guards: the pasted text looks
// complete, the agent then sends an empty x-admin-key, and the error it gets back says nothing about
// the copy having been incomplete.
test('the key lands in the text, one way or another', () => {
  const doc = '# 接入\n\n接口鉴权   请求头 x-admin-key: <直连后台密钥>\n';
  const inPlace = injectAdminKey(doc, 'SECRET123');
  assert.equal(inPlace.injected, true);
  assert.match(inPlace.text, /x-admin-key: SECRET123/);
  assert.ok(!inPlace.text.includes('<直连后台密钥>'), 'the placeholder must not survive the copy');

  // Every spelling a human might write.
  for (const variant of ['<密钥>', '<后台密钥>', '<admin_key>', '<x-admin-key>', '<admin key>']) {
    assert.match(injectAdminKey(`key: ${variant}`, 'K').text, /key: K/, variant);
  }

  // No placeholder: append, and keep every byte of the document.
  const appended = injectAdminKey('# 接入\n正文\n', 'SECRET123');
  assert.equal(appended.injected, true);
  assert.ok(appended.text.startsWith('# 接入\n正文\n'));
  assert.match(appended.text, /x-admin-key/);
  assert.match(appended.text, /SECRET123/);

  // No key: never invent one, and say so.
  const none = injectAdminKey(doc, '');
  assert.equal(none.injected, false);
  assert.equal(none.text, doc);
});

test('the built index enumerates the docs directory and skips dotfiles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-docs-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'docs', '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(site, 'docs', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(site, 'docs', 'agent-upload.md'), `# 接入\n\nPOST ${AGENT_DOC_MARKER}begin\n`);
  fs.writeFileSync(path.join(site, 'docs', 'sub', 'notes.md'), '# 笔记\n');
  fs.writeFileSync(path.join(site, 'docs', '.private.md'), '# 隐藏\n');
  fs.writeFileSync(path.join(site, 'docs', '.hidden', 'x.md'), '# 隐藏目录\n');

  const index = await buildDocsIndex({ siteDir: site, repoRoot: root, log: () => {} });
  assert.deepEqual(index.docs.map((d) => d.path).sort(), ['docs/agent-upload.md', 'docs/sub/notes.md']);
  assert.equal(index.agentDoc, 'docs/agent-upload.md');
  // Not a git checkout, so the date is unknown -- and saying "unknown" beats inventing an mtime.
  assert.ok(index.docs.every((d) => d.updatedAt === '' && d.datedBy === 'none'));
  assert.match(index._how, /git/);
  fs.rmSync(root, { recursive: true, force: true });
});

// A shallow clone is the real-world failure: it holds one commit, so `git log -1` answers the same
// date for every file and "newest" quietly becomes a path tie-break. The index has to say so —
// otherwise the page tells a reader it picked the newest document when it did not.
test('when dates cannot discriminate, the index says so', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-docs-nogit-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(site, 'docs', 'a.md'), '# a\n');
  fs.writeFileSync(path.join(site, 'docs', 'b.md'), `# b\n\n${AGENT_DOC_MARKER}\n`);

  const index = await buildDocsIndex({ siteDir: site, repoRoot: root, log: () => {} });
  assert.equal(index.dating, 'degenerate');
  assert.match(index._dating_note, /浅克隆/);
  assert.match(index.agentDocWhy, /日期相同/);
  // It still answers, and still picks the marker-carrying document.
  assert.equal(index.agentDoc, 'docs/b.md');
  fs.rmSync(root, { recursive: true, force: true });
});

test('with real history the dates discriminate and the newer document wins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-docs-git-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'docs'), { recursive: true });
  const git = (...a) => {
    const res = spawnSync('git', ['-C', root, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], {
      encoding: 'utf8',
      env: process.env,
    });
    if (res.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${res.stderr}`);
  };
  const commitAt = (iso) => {
    const res = spawnSync('git', ['-C', root, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'c'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    });
    if (res.status !== 0) throw new Error(`commit failed: ${res.stderr}`);
  };

  git('init', '-q');
  fs.writeFileSync(path.join(site, 'docs', 'a-old.md'), `# old\n\n${AGENT_DOC_MARKER}\n`);
  git('add', '-A');
  commitAt('2026-01-01T00:00:00+08:00');
  fs.writeFileSync(path.join(site, 'docs', 'b-new.md'), `# new\n\n${AGENT_DOC_MARKER}\n`);
  git('add', '-A');
  commitAt('2026-06-01T00:00:00+08:00');

  const index = await buildDocsIndex({ siteDir: site, repoRoot: root, log: () => {} });
  assert.equal(index.dating, 'ok');
  assert.equal(index.docs[0].path, 'docs/b-new.md', 'sorted newest first');
  assert.equal(index.docs[0].datedBy, 'git');
  assert.notEqual(index.docs[0].updatedAt, index.docs[1].updatedAt);
  // Both carry the marker, so this one is decided by TIME — the thing the whole module is for.
  assert.equal(index.agentDoc, 'docs/b-new.md');
  fs.rmSync(root, { recursive: true, force: true });
});
