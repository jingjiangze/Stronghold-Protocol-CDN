import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

// A duplicate id is not a style nit: getElementById returns the first match, so the page script
// can end up rewriting the wrong element — which is exactly how the section anchor "mirrors"
// collided with the cards container and made the script wipe the section it lived in.
test('no duplicate element ids in the site page', () => {
  const seen = new Set();
  const duplicates = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);
});

test('every id the page script looks up exists in the page', () => {
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  const looked = [...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(looked)].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, [], `the script looks up ids that are not in the page: ${missing.join(', ')}`);
});

test('every anchor in the navigation points at a section that exists', () => {
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.length >= 5, 'expected the section navigation to be present');
  for (const anchor of anchors) {
    assert.ok(ids.includes(anchor), `#${anchor} has no matching id`);
  }
});

// The manifest block exists to answer "does this git mount have the assets". It must read "是"
// now that the tree is committed, and the explanation has to say why it used to read "否" —
// otherwise the page still tells readers the opposite of the truth about the same sources.
test('the manifest block explains partial coverage instead of just labelling it', () => {
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');

  assert.ok(/id="manifest"/.test(html), 'the manifest block is missing from the page');
  assert.ok(/function renderManifest/.test(script), 'renderManifest is missing');
  assert.ok(/renderManifest\(/.test(script), 'renderManifest is never called');

  // The git-mount column must be generated, not typed per row: a hand-written row would survive
  // a future directory being added, and then quietly say the wrong thing about it.
  const render = script.slice(script.indexOf('function renderManifest'));
  const table = render.slice(0, render.indexOf('const tag ='));
  assert.match(table, /<td class="num">是<\/td>/, 'the git-mount column must render 是 for every row');

  // The explanation must not hide behind setText (which renders <b> as literal text), and must
  // name the branch the assets now live on, since that is the whole answer.
  assert.match(render, /innerHTML/, 'the lead uses innerHTML so its emphasis actually renders');
  assert.match(render, /assets-raw/, 'the lead names the branch that now carries the asset tree');
});

// 2026-10-29 用户令：站点精简，删掉「玩家：下载整合包，解压即开服」整块 —— 站上不再提供整合包下载入口。
// 所以这里反过来断言「入口与它的渲染器都不在了」：留着死配置会让人以为页面上还有第二个入口。
test('the player download section and its renderer are gone', () => {
  assert.doesNotMatch(html, /id="players"/, 'the player section must be gone');
  assert.doesNotMatch(html, /id="official-download"/, 'the drop-in download button must be gone');
  assert.doesNotMatch(html, /解压即开服/, 'the "unzip and run" framing must be gone');
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  assert.doesNotMatch(script, /const DOWNLOADS = \[/, 'the download variant table must be gone');
  assert.doesNotMatch(script, /function renderDownloads\(/, 'the download renderer must be gone');
});

// The directory listing has to go down to individual files, and the page must fetch the compact
// tree rather than the 1.6 MiB key table -- loading the key table to render a directory list is the
// thing this section exists to avoid.
test('the file tree is expandable, filterable, and fed by the compact tree file', () => {
  assert.match(html, /id="tree"/, 'the tree host is missing');
  assert.match(html, /id="tree-filter"/, 'the filter box is missing');
  assert.match(html, /id="tree-collapse"/, 'the collapse control is missing');
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  assert.match(script, /cdn\/v1\/tree\.json/, 'the page must read the compact tree, not the key table');
  // Scoped to the tree renderer only: cdn.js does reference index.json elsewhere (the speed test's
  // fallback probe path), so a whole-file check fails for the wrong reason. Bounded at the next
  // section banner so the slice cannot quietly swallow the rest of the file.
  const start = script.indexOf('async function renderTree');
  const rest = script.slice(start);
  const end = rest.indexOf('\n// ---- ');
  const treeFn = end > 0 ? rest.slice(0, end) : rest;
  assert.ok(treeFn.length > 500, 'renderTree was not found in cdn.js');
  assert.ok(!/cdn\/v1\/index\.json/.test(treeFn), 'the tree must not be fed by the 1.6 MiB key table');
  // Children are built on expand: a 12k-file tree cannot be in the DOM at once.
  assert.match(script, /function buildTreeModel/, 'the flat dirs map needs to become a tree');
  assert.match(script, /let built = false/, 'child rows must be built lazily');
});

// 2026-10-29 用户令：删掉「官方文档与 wiki 数据」整节（连同它作为 /docs/** 导流入口的作用）。
// 断言分节与渲染器都不在了，并且素材清单导语不再宣传 docs/ —— 那正是被删掉的那一节的内容。
test('the official docs section is gone', () => {
  assert.doesNotMatch(html, /id="official-docs"/, 'the docs section must be gone');
  assert.doesNotMatch(html, /id="doc-rows"/, 'the docs table host must be gone');
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  assert.doesNotMatch(script, /function renderDocs/, 'the docs renderer must be gone');
  assert.doesNotMatch(script, /docBytes/, 'the manifest lead must stop advertising docs/');
});

// 「打包通道」改称「预载通道」：同一批 zip，但用法是预载到本机；并且必须写明它跟上游 tag 滚动
// （包发布在 GitHub Release 的 assets-<tag> 下，页面读的是发布接口里的 packs 字段）。
test('the preload channel is documented together with its rolling update', () => {
  assert.match(html, /预载通道/, 'the preload block is missing');
  assert.match(html, /id="packs"/, 'the pack table host is missing');
  assert.match(html, /assets-&lt;tag&gt;/, 'the release tag naming must be stated');
  assert.match(html, /滚动更新（GitHub）/, 'the rolling update has to be stated');
  assert.doesNotMatch(html, /打包通道/, 'the old name must be gone');
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  assert.match(script, /function renderPacks/, 'the pack renderer must stay');
});

// WS 链路这条线（三份文档 + 外部库 + 首页卡片）已按用户要求下线。站点里不得再出现指向它们的链接，
// 文档文件也不得留在树里 —— 站内死链比少一节更难查。
test('the ws link line is gone from the site', () => {
  assert.doesNotMatch(html, /ws-link-compression|ws-compression-library-and-pack/, 'index must not link the ws docs');
  for (const page of ['bandwidth.html', 'asset-cdn.html']) {
    const text = fs.readFileSync(path.join(ROOT, 'site', page), 'utf8');
    assert.doesNotMatch(text, /ws-link-compression|ws-compression-library-and-pack/, `${page} must not link the ws docs`);
  }
  for (const rel of ['ws-link-compression.md', 'ws-link-compression-next.md', 'ws-compression-library-and-pack.md']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'site', 'docs', rel)), `${rel} must be deleted`);
  }
});

// The manifest table used to assert "git mounts have it" for every row. That stopped being true
// when docs/ joined the tree, so the column is computed now.
test('the git-mount column is computed, not a constant 是', () => {
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  assert.match(script, /onGitMount/, 'the git-mount column must be derived per row');
  assert.ok(
    !/<td class="num">是<\/td><\/tr>/.test(script),
    'a hard-coded 是 would claim the git mounts serve docs, which they do not',
  );
});

// The agent-facing query surface is documented where the rest of the API is, so it is discoverable
// rather than folklore.
test('the page documents how an agent queries the tree', () => {
  assert.match(html, /给 agent 的查询接口/, 'the agent query block is missing');
  assert.match(html, /HEAD &lt;基址&gt;\/assets\//, 'existence+size by HEAD should be documented');
});

// The endpoint table used to be hand-copied into index.html, and it had already drifted (it called
// /fonts/** immutable, and omitted /packs/**, /dl/** and api.json itself). It now renders from the
// published contract, so the table cannot disagree with what the sync writes.
test('the endpoint table is rendered from the contract, not hand-copied', () => {
  assert.match(html, /id="api-rows"/, 'the endpoint table needs a host to render into');
  assert.ok(
    !/cdn\/v1\/tree-&lt;令牌&gt;\.json/.test(html),
    'the hand-copied endpoint rows must be gone; listing them twice is how they drifted',
  );
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  assert.match(script, /cdn\/v1\/api\.json/, 'the page must read the contract');
  assert.match(script, /function renderApi/, 'the contract needs a renderer');
  // The frozen tree copy is the row that drifted out of the old table, so the contract must list it.
  const contract = fs.readFileSync(path.join(ROOT, 'src', 'api-contract.mjs'), 'utf8');
  assert.match(contract, /\/cdn\/v1\/tree-<token>\.json/, 'the frozen tree copy must be in the contract');
});

// The downloads are gone (2026-10-29), so the auto-selection that rewrote their href had to go too:
// leaving it behind would probe candidate hosts on every page load for buttons that do not exist.
test('the per-download host auto-selection is removed with the downloads', () => {
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');
  assert.doesNotMatch(script, /preferFastestDownload/, 'the download auto-selection must be gone');
  assert.doesNotMatch(script, /refreshDownloads/, 'the GitHub release polling for downloads must be gone');
});

// The speed test probes each mirror on a path that mirror happens to serve, so an @main git mount
// that answers 404 for every asset measures as fast as a full mirror. It used to take the "最快"
// badge, and the base printed on that card is what a reader copies into SP_ASSET_CDN -- so the
// badge could hand a 404-everything source to the asset base. The asset winner must be chosen
// among asset-usable mirrors, and a no-asset winner must be qualified, never a plain 最快.
test('a mirror that serves no assets can never take the asset badge', () => {
  const script = fs.readFileSync(path.join(ROOT, 'site', 'js', 'cdn.js'), 'utf8');

  // The split is derived from the published coverage, not assumed from a host name.
  assert.match(script, /const servesAssets = /, 'coverage split must be derived');
  assert.match(script, /coverage !== 'partial'/, 'partial coverage is what means "no asset tree"');

  // Two winners: the speed winner keeps the badge, the asset winner is picked among usable mirrors.
  const paint = script.slice(script.indexOf('function paintProbe'), script.indexOf('function wireProbe'));
  assert.match(paint, /find\(servesAssets\)/, 'the asset winner must come from asset-usable mirrors');
  assert.match(paint, /最快 · 不含素材/, 'a no-asset winner must be qualified, not plain 最快');
  assert.match(paint, /素材最快/, 'the fastest asset-usable mirror must be named');

  // The card itself must say the base is not an asset base, not just carry a chip.
  assert.match(script, /card__warn/, 'a partial mirror needs the warning under its base');
  assert.match(script, /不要<\/b>把它当素材基址/, 'the warning must say the base is not an asset base');

  // And the prose must stop claiming every git source carries the assets.
  assert.match(script, /@assets-raw/, 'the explanation must name the branch that carries the assets');
  assert.ok(
    !/git 挂载源（jsDelivr \/ ghfast \/ gitcdn）持有<b>素材部分<\/b>/.test(script),
    'the old blanket claim that every git mount holds the asset part is exactly what was wrong',
  );
});
