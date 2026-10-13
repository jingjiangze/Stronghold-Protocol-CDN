# 给 mod 作者：素材与包存档放哪、怎么指（v1 · 2026-10-13）

> 适用引擎：Stronghold Protocol **Forge 0.18.3**（上游 0.2.5，`MOD_API_VERSION = 1`）。
> 本页同时发在 CDN 上可直接取：`https://weishucdn.jiangjiangze.icu/packs/mod-assets/README.txt`（`.md` 不在上传白名单里，所以线上那份是纯文本同文）。
> 接口总表：`<CDN>/cdn/v1/api.json`（`schema: 2`）。接入通用说明：本仓 `docs/INTEGRATION.md`。

## 0. 一分钟结论

| 你想做的事 | 行不行 | 怎么做 |
|---|---|---|
| 让**语音**从 CDN 取，包里不带 mp3 | ✅ 可以 | `pack.json` 的 `voices` / `voiceLangs` 条目写成 `{url, sha256, file}`（见 §3） |
| 让**美术**（头像 / 立绘 / Spine / 图集）从 CDN 取，包里不嵌字节 | ❌ 做不到 | 引擎会把它改写成 `/workshop-assets/<包id>/<路径>`，指外部主机就是 404（§4 有行号） |
| 把**打好的包**托管在 CDN，让站外玩家自取 | ✅ 可以 | 传成 `packs/<你的组>/<包id>.zip`（§5） |
| 大素材包一次传 300 MB | ❌ 会被截 | 引擎读侧硬上限：解后总和 64 MiB / 4096 条 / 单条 32 MiB ⇒ 分片，每片解后 ≤52 MiB |
| 直接指别人已经传过的同一张图 | ✅ 应该这么做 | 先查权威键索引（§2），命中就指 canonical 键，**别再传一份** |

基址只有一个：`https://weishucdn.jiangjiangze.icu`（同桶第二入口 `https://weishucdn2.jiangjiangze.icu`，响应头逐字一致）。
**`downcdn.jiangjiangze.icu` 是门户站点**：它任何子路径都回 `200 text/html`，不要拿它验字节，也不要写进 mod。

## 1. 路径规则

```
素材/文件 URL = <CDN>/<key>?v=<art.token>
  <key>       = 桶内键名，必须落在 assets/ fonts/ packs/ 三个前缀之一
  <art.token> = GET <CDN>/cdn/v1/art.json 的 art.token（形如 v0.2.5-40eabacd）
```

- **一定带 `?v=`**。对象以 `Cache-Control: immutable` 提供，同名覆盖后边缘仍可能长时间吐旧字节（今天就踩过：主域名裸路径 `HIT` 旧的低清贴图，第二入口 `DYNAMIC` 已是新的高清版）。令牌变了 URL 就变，所以永远拿得到当前版本，也不需要 purge。
- 允许扩展名：`png jpg jpeg webp gif atlas skel json txt mp3 ogg wav m4a woff woff2 ttf otf zip bin data xml`。
- 键名不许 `..`、`//`、反斜杠、控制字符、超 1024 字节。

## 2. 上传之前先查一次哈希（防重复）

```bash
sha256sum my-art.png
curl -s https://weishucdn.jiangjiangze.icu/packs/mod-assets/index.json | jq --arg s <上面的哈希> '.["'\"$s\"'\"] // empty'
```

索引结构（一份 sha256 只有一个权威键）：

```jsonc
{ "sha256…": { "key": "assets/skins/…/x.skel", "size": 1697045, "ns": "stardust-skins",
               "aliases": [ { "key": "assets/local/sp-four-…/x.skel", "ns": "sp-four-02a466edd43d" } ] } }
```

- **命中** ⇒ 直接指 `key`（canonical），不要上传第二份。`aliases` 是历史遗留的同字节副本，**暂时保留不删**（它们可能被别人的服务器钉着），但**新包一律不许再指 alias**。
- **未命中** ⇒ 按 §5 传上来，传完索引会随下一次发布刷新。
- canonical 的选法：上游镜像件 > 避开 `assets/local/<组>/**` 这种整包转储 > 路径短者。也就是说：看到 `assets/local/...` 别当成家。

## 3. 唯一能吃外部 URL 的两个字段

### 3.1 `voices` / `voiceLangs`（语音，服务端取字节）

```jsonc
{
  "id": "my-op-voice",
  "license": "代码 GPL-3.0-or-later；音频 © 原版权方（含官方素材），仅供非商业学习与个人娱乐",
  "api": ">=1 <2",
  "voices": {                                   // 默认语 = 日语
    "char_4231_clemnt": {
      "start": [ { "url": "https://weishucdn.jiangjiangze.icu/assets/audio/voice/jp/char_4231_clemnt/cn_019.mp3?v=v0.2.5-40eabacd",
                   "sha256": "<64 位小写>",
                   "file": "voice/jp/char_4231_clemnt/cn_019.mp3" } ]
    }
  },
  "voiceLangs": { "cn": { "char_4231_clemnt": { "start": [ /* 同形 */ ] } } }
}
```

规则（都在 `shared/workshop.js`）：三键闭集 `['url','sha256','file']`（`:219`，多一个键整包拒 `VOICE_CDN_UNKNOWN_FIELD`）；`url` 必须 `https:` 且有主机名、不带凭据（`:1879-1886`）；扩展名限 `.mp3 .ogg .wav .m4a`（`:223`）；`sha256` 64 位小写；`file` 是包内相对路径（`:1891`）。**取字节的是服务端**、在装载时，超时 20 s、单条 ≤24 MiB（`server/voiceCdn.js:34-36`），落 `<状态目录>/voice-cdn/<sha256>` 并二次核对哈希，不符就 `VOICE_CDN_DIGEST_MISMATCH`（“什么都没缓存、也什么都不提供”）。声明了它就必须写顶层 `license`。玩家侧看到的 URL 仍是 `/workshop-assets/<包id>/<file>`，没有新路由。
**注意**：`skins[].voices` 不吃这个形状，只收字符串路径（`:2111-2113`）；`voiceLangs` 里不许出现 `jp`（默认语，会 `VOICE_LANG_DEFAULT`）。

### 3.2 `assets.mirrors`（只镜像本包容器，不省字节）

```jsonc
"assets": {
  "container": "packs/my-resources.spresources",
  "manifest": "resource-manifest.json",
  "serverPolicy": "serve", "verify": "sha256",
  "mirrors": [{ "id": "weishucdn", "base": "https://weishucdn.jiangjiangze.icu/packs/<我的组>/", "sha256": "<容器自身的 sha256>" }]
}
```

- `base` 必须绝对 `https`、**以 `/` 结尾**、≤512 字节、不带 query/fragment/凭据；拼法是 `<base><容器在包内的文件名>`（**只取文件名**，`public/js/resources/host.js:227-230`）⇒ 镜像上那个文件必须是扁平的一个对象。
- `sha256` 必须等于装载期从**包内那份容器**实算出来的摘要；对不上的那条 mirror 被**停用并点名**（`server/workshop.js:455-480`）。**容器字节仍然必须在 zip 里**：mirrors 只把玩家的下载流量从你的服务器挪走，不能让包变空。
- 最多 4 条；声明了就必须要 `license`；取字节的是客户端，服务端一次都不回源；镜像挂了自动回落包自己的 `/workshop-resources/…` 并点名。

## 4. 明确指不过去的东西（别再试）

| 字段 | 为什么 | 证据（引擎 0.18.3） |
|---|---|---|
| `art.{chars,enemies,tokens,skills,profSub,bonds,bands}`、`skins[].art`、`bondIcons`、`itemIcons` | 值一律被 `toUrl` 前缀成 `/workshop-assets/<包id>/<路径>`；写 `https://…` 能过路径校验（scheme 测试 `/^[A-Za-z]:/` 只吃单字母）但会拼出一个叫 `https:` 的目录 ⇒ 404 | `shared/workshop.js:3629`、`:274-276`、`server/http/static.js:458-467` |
| Spine（`skel`/`atlas`/`textures`） | `validSpine` 要求 `skel` **以 `/` 开头**；`spineEntry` 无 lookup 钩子 | `public/js/assets.js:213`、`:156-179` |
| `i18n`、`notices`、`routes`、`forms`、`client/server` 模块路径 | 只收包内相对路径；`routes` 只发 `.json`；`.js/.html` 在素材路由上被明确拒绝 | `shared/workshop.js:1412 / 1390 / 1265-1276 / 670-683`、`server/http/workshop.js:323-333` |
| 「自定义外观直接从 CDN 取立绘」 | 唯一能吐任意 URL 的 `appearance(ctx)` **一进程只许一个**，槽位已被上线的 `skin-picker` 占住（后注册者 `CLIENT_APPEARANCE_TAKEN`），且它自己只读合并后的 `/workshop-assets/` 地址 | `public/js/ui/extensions.js:596-621`、`public/js/ui/portraitChain.js:162-167` |

## 5. 把包存档 / 外部素材放上来

上传后台：网页 <https://downcdn.jiangjiangze.icu/admin>，命令行 `node tools/agent-upload.mjs`（本仓）。

```bash
node tools/agent-upload.mjs \
  --file=dist/my-pack.zip \
  --to=packs/my-group/my-pack.zip \
  --source=my-group \
  --what="说明：这是什么包、素材来源、版权" \
  --dispatch --wait
```

- 链路是 `begin → presigned PUT → commit → 发布轮逐字节核对 sha256 → 登记 hosted.json（进 git）`。**只增不覆盖、不删别人的东西**；口令 = Pages secret `ADMIN_UPLOAD_KEY`（本机放 `~/.cdn_admin_key`，绝不进 git）。
- 上线后键名与摘要会进 `<CDN>/cdn/v1/hosted-index.json`，谁传的进 `<CDN>/cdn/v1/upload-log.json`。
- 上传的是 zip 存档时：zip 里 `pack.json` 必须在**根**（否则站外工具读不到包 id 与作者）；解到工坊根后要长成 `<工坊根>/<包 id>/pack.json`。
- **默认键是 `packs/<source>/<文件名>`**。以前默认丢进 `assets/local/<文件名>`，10-13 的桶内对账显示这正是一批「整包转储」挤进上游 `local` 命名空间的来源（`assets/local/<组>/**` 共 1,570 键 / 253.2 MiB）。要进素材树就显式写 `--to=assets/…`，并按 §2 先查过哈希。

### 5.1 几百件以上用批量版

```bash
node tools/agent-upload-batch.mjs --manifest=list.json --source=my-group \
     --what="说明" --concurrency=8 --resume=ledger.json --kick
# 或：--dir=stage --to=assets/char/portrait/ --strip=public/
```

| | 单文件版 | 批量版 |
|---|---|---|
| 实测 | **6.3–7.8 秒/件**（≈0.16 件/秒） | **271 件 / 31.4 MiB / 295 秒**（≈0.92 件/秒、107 KB/s） |
| 管理面 | 每件新建 TLS，且 `fetch` 8 秒不成就 spawn `curl`（每件 2 次） | 一条 keep-alive 连接池复用；`begin/PUT/commit` 平均 1.3 s / 2.0 s / 3.1 s（瓶颈在 Pages Function，不在桶） |
| 传输 | 一件一进程、串行 | N 路并发流水（默认 6，建议 8），只哈希一次，`--resume` 记账续传 |
| 发布轮 | 每传一件 dispatch 一次 | 全程只在 `--kick` 时叫一轮 |
| 撞已有键 | 每件吃一个 409 | **先 HEAD 现网预检再传**：本轮 546 件里 275 件现网已有 ⇒ 37 秒全跳过、0 失败 |

> 预检为什么必须做：`cdn/v1/index.json` 与 `cdn/v1/hosted-index.json` 都**滞后于桶**（别人刚传的、还在暂存区的都不在里面）。只按清单判「缺不缺」，546 件里会误判 275 件。

## 6. 尺寸与高清政策

- 同名不同字节 = **分歧**，不是更新。判据只用两样：`sha256` + 图片实际像素（PNG `IHDR` 宽高）。不看文件名、不看谁上传得晚。
- **贴图与它的 `.atlas` 必须同代成对**：atlas 记的是 region 坐标与页尺寸，一半新一半旧直接画歪。实例：`assets/spine/enemy/enemy_10138_xdsnow/` 的 216×216 / 26,989 B 低清对，已被 316×316 / 72,530 B 高清对成对替换，双方尺寸与理由公开在 `<CDN>/cdn/v1/art.json` 的 `overrides` 里。
- 要发「上游没有、本站有意提供」的字节，走本仓 `sources.json` 的 `overrides` + `pin/<path>`（`{path,size,sha256,why}` 三样逐字节核对，不符就中断发布），不要另开一条覆盖口。
- 皮肤这类「一个皮肤多份分辨率」的情况：本项目现有 273 套时装，线上构建那份是每套 8 个文件（头像 + 立绘 + 正背面 skel/atlas/png，约 1.3 MB），另有只带 ~60 KB 低清头像的构建 ⇒ **指 canonical 那份高清的**，别再传低清副本。

## 7. 交出去的包怎么算合格

1. 本地过引擎闸门：`node tools/workshop-validate.mjs <工坊根>/<包 id>`，要 `0 error(s)`（干净根、单独装载）。
2. `pack.json` 只用 `PACK_FIELDS` 的 35 个键，多一个键整包拒（`PACK_UNKNOWN_FIELD`）。
3. 素材全在包内 `assets/` 下，声明里写相对它的路径（不写 `assets/` 前缀）。
4. 每包带 `PROVENANCE.md`（原作者 / 许可 / 兼容改写者 / 来源 / 改了什么 / 自带素材逐条清点）。
5. 含游戏素材就在自述与站上备注写「**含官方素材**」+ 版权归鹰角网络 / Yostar + 仅非商业；不声明任何官方身份、不写「官方导出 / official」。
6. 会改对局结果的包要写 `combat: true` 并在说明里讲清楚。

## 8. 现状与暂时约定（2026-10-13）

- 桶：29,892 个对象 / **5,265.8 MiB**；有哈希可查的键 21,521（上游 12,675 + 托管 8,849）。
- 同字节多键 **908 组、别名键 1,033 个 ≈ 195.8 MiB**（集中在 `assets/skins/**` ↔ `assets/local/sp-four-…/**`、`sp-fusion-mod-assets` ↔ 上游等）。**这些别名暂时全部保留**（可能被别人的服务器钉着），因此：新包只指 canonical；哪一天要收敛，会先按组通知再动。
- 只读路由：`<CDN>/packs/mod-assets/index.json`（权威键索引）、`<CDN>/cdn/v1/api.json`（接口表）、`<CDN>/cdn/v1/tree.json`（目录树，可直接浏览有什么）。

## 9. 一页速查

```
基址          https://weishucdn.jiangjiangze.icu     （第二入口 weishucdn2，同桶）
令牌          GET /cdn/v1/art.json → art.token      URL 一律带 ?v=<token>
有什么        GET /cdn/v1/tree.json                  GET /cdn/v1/index.json（上游键+sha256）
托管件摘要    GET /cdn/v1/hosted-index.json          GET /cdn/v1/upload-log.json（谁传的）
防重复        GET /packs/mod-assets/index.json       sha256 → canonical key + aliases
接口          GET /cdn/v1/api.json                   （schema 2，19 条端点）
换源/测速      GET /cdn/v1/pick.js                    GET /cdn/v1/network.json
```
