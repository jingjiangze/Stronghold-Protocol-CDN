// 手动上传的「按文件名 + 后缀自动定位」规则。只在这里放一份，admin.js 与测试都从这里取。
//
// 2026-10-16 用户口径：手动发布不再选目录，只选文件；能按名字对上素材树就直接对上，
// 对不上的先进暂存区（落 packs/<来源>/，服务端 formatVerdict 判 hold，审计后放行才上线）。
//
// 规则来自 2026-10-16 对线上 tree.json（21,476 键）的实测：素材树里「名字的前缀段 =
// 所在目录名」是硬约定 —— m_bat_* 全在 bgm、b_char_* 全在 battle/b_char、e_atk_* 全在
// enemy/e_atk、p_skill_* 全在 player/p_skill。图片（avatar.png/portrait.png）在七八个
// 目录里同名，光看名字定不了位，所以图片类一律算「匹配不到」→ 暂存区等放行。
// 判据权威在服务端（src/upload.mjs 的 formatVerdict）：这里只决定键名写哪儿，
// 键名是否合法、算不算静态素材，服务端逐条再判，两边不一致也不会误上线。

/* AUTO-KEYS-BEGIN */
(function (global) {
  'use strict';

  const FONT_EXT = new Set(['woff', 'woff2', 'ttf', 'otf']);

  // mp3 的首字母段 → sfx 下的分组目录。'm' 特判：背景音乐是平的一层。
  const SFX_GROUP = { a: 'ambience', b: 'battle', e: 'enemy', g: 'general', p: 'player' };

  /**
   * 由文件名推导目标键。**返回 null = 匹配不到**，调用方落 packs/<来源>/<路径>。
   *
   * 只取文件名本身：本地子目录（v1.2/、my-stuff/）是上传者自己的组织方式，
   * 桶的落点由名字前缀段决定，名字就是全部信息。
   * 前缀匹配**区分大小写**：桶内前缀段全小写，B_CHAR_ 这种名字不参与自动归一化 ——
   * 归一化可能造出与已有键只差大小写的重复键（同字节多键的老毛病），宁可它落暂存区给人看。
   * @param {string} relName 已经 sanitize 过的相对路径（目录上传时带子路径）
   */
  function autoTargetKey(relName) {
    const name = String(relName || '').split('/').pop();
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (!ext) return null;
    if (FONT_EXT.has(ext)) return `fonts/${name}`;
    if (ext === 'mp3') {
      if (name.startsWith('m_')) return `assets/audio/bgm/${name}`;
      const group = SFX_GROUP[name[0]];
      if (group && name[1] === '_') {
        const seg = name.split('_').slice(0, 2).join('_'); // e.g. b_char / e_atk
        return `assets/audio/sfx/${group}/${seg}/${name}`;
      }
      return null; // xielage-freeze.mp3 这类自定义音效：匹配不到
    }
    return null; // 图片/骨骼/清单等：光看名字定不了位，先进暂存区
  }

  /** 兜底落点：与 CLI 的 defaultKeyFor 同一命名空间，服务端 formatVerdict 判 hold。 */
  function stagingKeyFor(source, relName) {
    return `packs/${source}/${String(relName || '')}`;
  }

  global.SP_AUTO_KEYS = { autoTargetKey, stagingKeyFor };
})(typeof window !== 'undefined' ? window : globalThis);
/* AUTO-KEYS-END */
