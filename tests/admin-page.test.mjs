// The upload backend's page: what it must expose, and what it must NOT.
//
// This page holds a key that can write bytes into the domain players download from, so several of
// these assertions are about absence — no delete control, nothing that acts before the gate passes.
// They are source-level because the page is a classic script (an IIFE) with no DOM harness in this
// repository; the behavioural check for the endpoint side lives in agent-doc-endpoint.test.mjs and
// the page itself is exercised against the live deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'site', 'admin.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'admin.js'), 'utf8');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

test('no duplicate element ids on the admin page', () => {
  const seen = new Set();
  const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);
});

// The failure this catches: a control that looks present but is wired to nothing, or a wire that
// targets an element the page no longer has. On this page that reads as "点了没反应".
test('every id the admin script looks up exists in the page', () => {
  const looked = [...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(looked)].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, [], `the script looks up ids that are not in the page: ${missing.join(', ')}`);
});

// 删除是刻意没有界面的：一次误点就会拿掉对外正被引用的字节。The page must have no way to do it.
test('the page offers no way to delete anything', () => {
  for (const wording of ['清暂存', '下线', '删除']) {
    assert.ok(
      !new RegExp(`>\\s*${wording}\\s*<`).test(html),
      `the page must not render a "${wording}" control`,
    );
  }
  assert.ok(!/actionButton/.test(script), 'the per-row action-button helper must be gone');
  // The delete endpoints exist for agents; the page must not call them.
  assert.ok(!/upload\/staging\?id=/.test(script), 'the page must not call the staging delete endpoint');
  assert.ok(
    !/['"`]\/api\/cdn\/upload\/remove/.test(script),
    'the page must not call the published-remove endpoint',
  );
  // ...and it should say why, rather than leaving the reader to guess it was forgotten.
  assert.match(html, /删除不在这张页面上，是刻意的/);
  assert.match(html, /--purge=/);
  assert.match(html, /--rm=/);
});

test('the copy control cannot be used before the gate passes', () => {
  assert.match(html, /id="copy-agent"[^>]*\bdisabled\b/, 'it must start disabled');
  assert.match(script, /function setCopyEnabled/, 'something must re-enable it');
  assert.match(script, /btn\.disabled = !key\(\)/, 'it is enabled only when a key is present');
  // Enabled again after a successful gate, and disabled again when the key turns out to be wrong.
  const gate = script.slice(script.indexOf("$('gate-form')"));
  assert.ok(gate.includes('setCopyEnabled()'), 'the gate must refresh the button state');
});

// The instructions are assembled server-side from the deploy-time docs index; a path written into
// the page is the thing that goes stale when the document is renamed.
test('the instructions come from the index, not a path hard-coded in the page', () => {
  assert.match(script, /\/api\/cdn\/upload\/agent-doc/, 'the copy must use the assembling endpoint');
  assert.ok(!/docs\/agent-upload\.md/.test(html), 'the page must not name a document path');
  assert.ok(!/docs\/agent-upload\.md/.test(script), 'the script must not name a document path');
  assert.match(html, /id="doc-note"/, 'the page must have somewhere to say which document it used');
});

test('staging and recent publishes are shown as trees, not tables', () => {
  for (const id of ['stage-tree', 'log-tree']) {
    assert.ok(ids.includes(id), `#${id} is missing`);
  }
  assert.ok(!/id="staging-table"/.test(html), 'the flat staging table must be gone');
  assert.ok(!/id="log-table"/.test(html), 'the flat log table must be gone');
  // Same marking as the home page, so the two trees behave identically.
  assert.match(html, /class="tree" role="tree"/);
  assert.match(script, /tree__row/);
  assert.match(script, /class="tree__caret"/);
});

// Key names and source ids come from whoever uploaded: they are untrusted input, and this page
// builds rows with innerHTML.
test('untrusted names are escaped before they reach innerHTML', () => {
  assert.match(script, /const esc =/, 'an escaping helper is required');
  const rowBuilder = script.slice(script.indexOf('function treeRow'), script.indexOf('/** {path, size'));
  assert.ok(rowBuilder.length > 200, 'treeRow was not found');
  for (const field of ['node.name', 'node.url', 'node.note', 'node.tag']) {
    assert.ok(
      rowBuilder.includes(`esc(${field}`),
      `${field} goes into innerHTML and must be escaped`,
    );
  }
});
