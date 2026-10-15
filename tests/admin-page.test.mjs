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
const stageHtml = fs.readFileSync(path.join(ROOT, 'site', 'stage.html'), 'utf8');
const stageScript = fs.readFileSync(path.join(ROOT, 'site', 'js', 'stage.js'), 'utf8');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const stageIds = [...stageHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

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

// The staging block and the manual-upload fold are mutually exclusive: the expanded upload form
// pushes the staging trees below the fold, so an operator watching the queue table has to scroll
// past two trees. This is the 2026-10-15 arrangement the user asked for by hand, and it is the kind
// of thing a later edit silently breaks (reveal both, forget the toggle, re-show on refresh).
test('the manual-upload fold hides the staging block while it is open', () => {
  assert.match(html, /id="manual"/, 'the upload fold is missing');
  assert.ok(html.includes('id="todo"'), 'the staging block is missing');
  // Hiding must be wired to the fold's own state, not to a second button somebody has to click.
  assert.match(script, /addEventListener\('toggle'/, 'the fold must drive the block through its toggle event');
  assert.match(script, /manualOpen/, 'the fold state must be remembered, so a refresh does not resurrect the block');
  // ...and the reveal path must go through the same helper, or the two disagree about who is hidden.
  // The helper has to be the only place that decides, so a force-reveal would defeat the exclusion.
  // `$` is escaped so the pattern reads as the literal path lookup it is checking for.
  const reveal = new RegExp("upload'\\)\\.hidden = false;\\n {4}showStaging\\(\\);");
  assert.ok(reveal.test(script), 'the gate must reveal the upload area and then let showStaging() decide about the staging block');
  assert.ok(!/\$\('todo'\)\.hidden = false/.test(script), 'the staging block must not be force-revealed');
  // The 401 path hides both again, or a rejected key leaves the trees on screen.
  assert.match(script, /\$\('todo'\)\.hidden = true;/, 'the rejected-key path must hide the staging block');
});

// The staging view is reachable without the upload form: that page answers "what is in staging"
// for an agent, and it must be a real page, not a query string off the console.
test('a standalone staging page exists and is linked from the console', () => {
  assert.match(html, /href="\.\/stage"/, 'the console must link to the staging page');
  assert.match(stageHtml, /id="gate-form"/, 'the staging page keeps the same password gate');
  // No upload controls: the moment this page can act, it is a second console to keep in sync.
  assert.ok(!/id="files"/.test(stageHtml), 'the staging page must not offer a file picker');
  assert.ok(!/id="go"/.test(stageHtml), 'the staging page must not upload');
  assert.ok(!/id="sync-mirrors"/.test(stageHtml), 'the staging page must not trigger mirrors');
  // ...and it must stay read-only in the same way the console is: no delete path on the page.
  assert.ok(!/upload\/staging\?id=/.test(stageScript), 'the staging page must not call the staging delete endpoint');
  assert.ok(!/['"`]\/api\/cdn\/upload\/remove/.test(stageScript), 'the staging page must not call the published-remove endpoint');
  // The key never survives the tab: same rule as the console.
  assert.match(stageScript, /sessionStorage/, 'the staging page must keep the key in sessionStorage');
  assert.ok(
    !/localStorage/.test(stageScript),
    'the staging page must not keep the key in localStorage',
  );
  // Every id its script looks up must exist on the page.
  const looked = [...stageScript.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(looked)].filter((id) => !stageIds.includes(id));
  assert.deepEqual(missing, [], `the staging script looks up ids that are not on the page: ${missing.join(', ')}`);
});

test('no duplicate element ids on the staging page', () => {
  const seen = new Set();
  const duplicates = stageIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);
});

// 2026-10-16 用户口径：手动发布不再选目录 —— 目标键由文件名+后缀自动推导，
// 推导不到的先进暂存区（packs/<来源>/，服务端判 hold 等放行）。
// 这条测试钉的是「页面上不能再有目录输入」和「推导必须发生在上传之前、看得见」。
test('the upload form derives the target key instead of asking for a directory', () => {
  assert.ok(!/id="prefix"/.test(html), 'the directory picker must be gone — the user chooses files, not paths');
  assert.ok(!/目标目录/.test(html), 'no label may still ask for a target directory');
  // 推导规则必须是独立文件（测试直接对它求值），页面只是消费者。
  assert.match(html, /src="\.\/js\/autokeys\.js"/, 'the rule module must be loaded before admin.js');
  const autoPos = html.indexOf('autokeys.js');
  const adminPos = html.indexOf('admin.js');
  assert.ok(autoPos < adminPos, 'autokeys.js must load before admin.js, which consumes it');
  assert.match(script, /SP_AUTO_KEYS\.autoTargetKey/, 'the script must derive keys through the shared rule');
  assert.match(script, /SP_AUTO_KEYS\.stagingKeyFor/, 'the fallback must use the shared packs/<source>/ rule');
  // 兜底不是失败：对不上的文件照样上传，只是落暂存区 —— 界面必须把这件事说在人点上传之前。
  assert.match(script, /对不上素材树/, 'the operator must be told before upload which files fall to staging');
  assert.match(html, /目标键（自动推导）/, 'the queue table must show the derived key per file');
  // 服务端护栏不能因为页面变聪明而放松：键的合法性、tier 判定仍由 put.js/formatVerdict 说了算。
  // （这条是给未来改 put.js 的人的提示，行为测试在 upload-flow/agent-doc 那边。）
});
