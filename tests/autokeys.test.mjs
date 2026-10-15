// 手动上传「按文件名 + 后缀自动定位」的规则测试。
//
// 用例文件名不是编的：全部取自 2026-10-16 实测的线上 tree.json（21,476 键），
// 每个「匹配成功」的用例都要落回它在线上真实所在的目录。规则改了而桶没改，
// 这些用例会红 —— 这正是想要的手感（对照 = 把 bgm 特判删掉，m_ 用例会立刻失败）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 模块是 window/globalThis 上的 IIFE（浏览器里没有 import），在 node 里手动加载一次。
const source = fs.readFileSync(path.join(ROOT, 'site', 'js', 'autokeys.js'), 'utf8');
new Function(source)();
const { autoTargetKey, stagingKeyFor } = globalThis.SP_AUTO_KEYS;

test('audio names land back in the directory the live bucket actually uses', () => {
  // 线上实测（tree.json）：m_* 全在 assets/audio/bgm，a_/b_/e_/g_/p_ 在 sfx 的对应子树
  assert.equal(autoTargetKey('m_bat_ancestor_loop.mp3'), 'assets/audio/bgm/m_bat_ancestor_loop.mp3');
  assert.equal(autoTargetKey('m_sys_act1autochess_intro.mp3'), 'assets/audio/bgm/m_sys_act1autochess_intro.mp3');
  assert.equal(autoTargetKey('a_bat_carcrush.mp3'), 'assets/audio/sfx/ambience/a_bat/a_bat_carcrush.mp3');
  assert.equal(autoTargetKey('b_char_atkboost.mp3'), 'assets/audio/sfx/battle/b_char/b_char_atkboost.mp3');
  assert.equal(autoTargetKey('b_ui_lose.mp3'), 'assets/audio/sfx/battle/b_ui/b_ui_lose.mp3');
  assert.equal(autoTargetKey('e_atk_arrow_h.mp3'), 'assets/audio/sfx/enemy/e_atk/e_atk_arrow_h.mp3');
  assert.equal(autoTargetKey('g_ui_btn_h.mp3'), 'assets/audio/sfx/general/g_ui/g_ui_btn_h.mp3');
  assert.equal(autoTargetKey('p_skill_ancientdrgnborn.mp3'), 'assets/audio/sfx/player/p_skill/p_skill_ancientdrgnborn.mp3');
});

test('font files are flat under fonts/ like the live bucket', () => {
  // 线上 fonts/ 只有 7 个键、全是平铺文件名
  assert.equal(autoTargetKey('bender-light.woff2'), 'fonts/bender-light.woff2');
  assert.equal(autoTargetKey('bender-regular.otf'), 'fonts/bender-regular.otf');
  assert.equal(autoTargetKey('bender-light.ttf'), 'fonts/bender-light.ttf');
});

test('names that cannot locate a directory fall to staging, not to a guess', () => {
  // 图片在三棵树下同名（avatar.png 在 skins/char 等一堆目录里都有）——定不了位
  assert.equal(autoTargetKey('avatar.png'), null);
  assert.equal(autoTargetKey('portrait.webp'), null);
  assert.equal(autoTargetKey('illustration.jpg'), null);
  // spine 成对文件不知道属于哪个角色目录
  assert.equal(autoTargetKey('skill.effect.atlas'), null);
  assert.equal(autoTargetKey('skill.effect.skel'), null);
  // 清单/元数据：本来就该等审计
  assert.equal(autoTargetKey('index.json'), null);
  assert.equal(autoTargetKey('manifest.json'), null);
  // 自定义音效没有前缀段（线上 xielage-freeze.mp3 在 sfx/custom，名字对不上任何前缀规则）
  assert.equal(autoTargetKey('xielage-freeze.mp3'), null);
  // 没扩展名 / 只有一层的怪名字
  assert.equal(autoTargetKey('LICENSE'), null);
  assert.equal(autoTargetKey('.gitignore'), null);
});

test('the staging fallback keeps the subpath under packs/<source>/', () => {
  assert.equal(stagingKeyFor('mod-makoto-p3r', 'avatar.png'), 'packs/mod-makoto-p3r/avatar.png');
  assert.equal(stagingKeyFor('mod-makoto-p3r', 'gui/button.png'), 'packs/mod-makoto-p3r/gui/button.png');
});

test('names outside the convention fall to staging instead of a case-folded guess', () => {
  // 桶内前缀段全小写；B_CHAR_ 这种名字不参与匹配，直接进暂存区让人看 —— 不自动归一化，
  // 因为归一化出来的键可能和已有键只差大小写，那是「同字节多键」的老毛病。
  assert.equal(autoTargetKey('B_CHAR_HIT.MP3'), null);
  // scene.bin.txt 的扩展名是 txt（最后一个点说了算），素材树没有这种约定 → 匹配不到
  assert.equal(autoTargetKey('scene.bin.txt'), null);
});

test('a matched name ignores the local subfolders: the name itself carries the locator', () => {
  // 目录上传里带自己的子目录（v1.2/），但线上素材树里 e_skill_cast.mp3 就住在 enemy/e_skill/，
  // 本地文件夹是上传者自己的组织方式，不是桶的契约 —— 推导键只取文件名本身。
  assert.equal(autoTargetKey('v1.2/e_skill_cast.mp3'), 'assets/audio/sfx/enemy/e_skill/e_skill_cast.mp3');
  // 匹配不到时子路径要保住：进 packs/<来源>/ 的相对结构不变
  assert.equal(stagingKeyFor('mod-x', 'v1.2/readme.md'), 'packs/mod-x/v1.2/readme.md');
});
