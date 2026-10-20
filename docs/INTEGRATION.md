# 接入说明

CDN 基址 `<CDN>` = `https://speedcdn.jiangjiangze.icu/`（规范门牌、order 第一位；同桶 `weishucdn.jiangjiangze.icu` 亦可；实际最优先门牌以 `origins.json` 的 `order` 为准）

素材本身是**上游清单里的同一批文件**，只是换了个更快的边缘、并且完整（逐文件校验过）。所以接入方式都很轻。

## 1. 游戏服（Node）

服务端已有 `SP_ASSET_CDN` 开关（`server/http/static.js`）：设成绝对基址后，它把 `data/{assets,local-assets,emotes}.json` 响应里的 `/assets/…` 改写成绝对 CDN URL，磁盘上的清单不动。

```bash
SP_ASSET_CDN=https://weishucdn.jiangjiangze.icu/ npm start
```

回退：不设这个变量即回到本地素材。

## 2. 纯静态 / 网页端

直接取清单，里面已经是绝对 URL（还带 `?v=<tag>`，可以放心长缓存）：

```js
const manifest = await (await fetch(`${CDN}/data/assets.json`)).json();
// manifest.chars.char_003_kalts.avatar → "https://…/assets/char/avatar/char_003_kalts.png?v=v0.2.1"
```

不要自己拼路径：清单是唯一真源。

## 3. 要校验或做二级镜像的站点

```js
const index = await (await fetch(`${CDN}/cdn/v1/index.json`)).json();
// index.files["assets/char/avatar/char_003_kalts.png"] → { size, sha256 }
```

逐个比对 `size` + `sha256` 即可确认自己的副本与 CDN 一致；`index.tag` 是它对应的上游版本。

## 4. 要展示"当前素材版本"的站点（下载站 / 大厅页 / 状态页）

```js
const art = await (await fetch(`${CDN}/cdn/v1/art.json`)).json();
// art.upstream.tag → "v0.2.1"
// art.verified.missing → 0        （0 表示清单里每个引用都已在 CDN 上解析成功）
// art.tree.files / art.tree.bytes → 覆盖规模
```

`art` 块的字段名与 re 线 `site/manifest-re.json` 的 `art` 块一致（`base` / `version` / `format` / `mirrors` / `packs`），同一套解析代码可以同时吃两条轴。

## 5. 要读官方文档 / wiki 数据的

```js
// 键就是上游包内路径，和 /assets/** 同构
const playing = await (await fetch(`${CDN}/docs/PLAYING.md`)).text();
const ops = await (await fetch(`${CDN}/docs/research/03-operators.json`)).json();
```

`docs/**` 来自上游发布包，原样镜像：`PLAYING.md`（玩家手册）、`DEPLOY.md`（部署）、
`docs/research/*.json`（干员 / 敌人 / 地图 / 素材四份数据集）。上游游戏服务器**没有** `/docs/` 路由，
所以这是这些文件唯一走 CDN 的入口。**`.md` 以 `text/plain; charset=utf-8` 发送**，浏览器会内联显示
而不是下载；`charset` 是必须的——不带的话中文会被按 Latin-1 解码成乱码。要原始文件请用 `curl -O`。

## 6. mod 作者：把素材指向本站

先说结论，免得白做：**这个引擎里只有两处能接受外部绝对 URL**，其余素材一律必须内嵌在包内。
判据核于引擎 0.18.3（上游 0.2.5 / MOD API 1），文件与行号都在下面。

> 面向 mod 作者的完整版（含防重复查询流程、上传通道、交付闸门与一页速查）在
> [`docs/MOD-AUTHORS.md`](MOD-AUTHORS.md)，并已作为纯文本发到 CDN：
> `<CDN>/packs/mod-assets/README.txt`（`.md` 不在上传白名单里）。
> 权威键索引：`<CDN>/packs/mod-assets/index.json`。现存的 1,033 个别名键（≈195.8 MiB 同字节副本）
> **暂时全部保留**，但新包只许指索引里的 canonical 键。

### 6.1 能吃绝对 URL 的两个字段

**① `pack.json` 的 `voices` / `voiceLangs` 条目 —— 只有音频**

```json
"voices": {
  "char_4231_clemnt": {
    "start": [
      { "url": "https://weishucdn.jiangjiangze.icu/assets/audio/voice/jp/char_4231_clemnt/cn_019.mp3",
        "sha256": "<该 mp3 的 64 位小写 sha256>",
        "file": "voice/jp/char_4231_clemnt/cn_019.mp3" }
    ]
  }
}
```

- 形状闭集 `VOICE_CDN_FIELDS = ['url','sha256','file']`（`shared/workshop.js:219`），多一个键就整包拒。
- `url` 必须 `https://` 开头且 `new URL().protocol === 'https:'`、有主机名、不带凭据（`:1879-1886`）；扩展名必须在 `.mp3 .ogg .wav .m4a` 里（`:223`）；`sha256` 64 位小写十六进制；`file` 是包内相对路径（客户端最终看到的仍是 `/workshop-assets/<包id>/<file>`，**没有新路由**）。
- **取字节的是服务端、在装载时**：落到 `<状态目录>/voice-cdn/<sha256>`，超时 20 s、单条上限 `VOICE_CDN_MAX_BYTES = 24 MiB`（`server/voiceCdn.js:34-36`），大小超了 `VOICE_CDN_TOO_LARGE`、哈希不符 `VOICE_CDN_DIGEST_MISMATCH` 并且「什么都没缓存、也什么都不提供」。声明了它就必须写 `license`（`VOICE_CDN_NEEDS_LICENSE`）。
- `skins[].voices` **不吃这个形状**（另有一条手写解析，只收字符串路径，`shared/workshop.js:2111-2113`）。

**② `assets.mirrors[]` —— 只镜像本包自己的容器，不省字节**

```json
"assets": {
  "container": "packs/my-resources.spresources",
  "manifest": "resource-manifest.json",
  "serverPolicy": "serve",
  "verify": "sha256",
  "mirrors": [{ "id": "weishucdn", "base": "https://weishucdn.jiangjiangze.icu/packs/<我的组>/", "sha256": "<容器的 sha256>" }]
}
```

- `base` 必须绝对 `https`、**以 `/` 结尾**、≤512 字节、不许带 query/fragment/凭据（`shared/workshop.js:642-649`）；拼法是 `<base><容器在包内的文件名>`（只取文件名，`public/js/resources/host.js:227-230`），所以镜像上的键必须是**扁平的一个文件**。
- `sha256` 必须等于装载期从**包内那份容器**实算出来的摘要；对不上的那条镜像被**停用并点名**（`server/workshop.js:455-480`），不是拒包。⇒ **容器字节仍然必须在 zip 里**：mirrors 只是把玩家的下载流量从发包的那台机器挪走，不能让包变空。
- 最多 4 条 mirrors；声明了就必须要 `license`。取字节的**始终是客户端**（服务端一次都不回源），失败自动回落包自己的 `/workshop-resources/…` 地址。
- 运行时要真正按镜像择优，还需要一个 `client.panels` 模块导出 `sources(ctx)`，它**只能重排已声明的 id**，喂主机名或 URL 会被 `CLIENT_SOURCES_BAD_ORDER` 整条作废（`public/js/resources/sources.js:104,118`）。

### 6.2 指不过去的东西（别再试）

| 字段 | 为什么不行 | 证据 |
|---|---|---|
| `art.{chars,enemies,tokens,skills,profSub,bonds,bands}`、`skins[].art`、`bondIcons`、`itemIcons` | 值一律被 `toUrl` 前缀成 `/workshop-assets/<包id>/<路径>`；写 `https://…` 会漏过路径校验（scheme 测试 `/^[A-Za-z]:/` 只吃单字母）但请求时拼出一个名为 `https:` 的目录 ⇒ 404，不出源 | `shared/workshop.js:3629`、`shared/workshop.js:274-276`、`server/http/static.js:458-467` |
| Spine（`skel` / `atlas` / `textures`） | 加载器要求 `skel` **必须以 `/` 开头**，绝对 URL 永远进不去；`spineEntry` 也没有 lookup 钩子可挂 | `public/js/assets.js:213`、`:156-179` |
| `i18n`、`notices`、`routes`、`forms`、`client/server` 模块路径 | 全部要求包内相对路径（模块与 `.js/.html` 更是明确拒绝外部源；路由只发 `.json`） | `shared/workshop.js:1412 / 1390 / 1265-1276 / 670-683` |
| 自定义外观（想让立绘直接从 CDN 取） | 唯一能吐任意 URL 的是外观提供者 `appearance(ctx)`，**一进程只许一个**，且已被上线的 `skin-picker` 注册（后注册者 `CLIENT_APPEARANCE_TAKEN`），而它自己也只读合并后的 `/workshop-assets/` 地址 | `public/js/ui/extensions.js:596-621`、`public/js/ui/portraitChain.js:162-167` |

⇒ **美术（头像 / 立绘 / Spine / 图集）只能内嵌进包**；本站对它的用处是：把**打好的包存档**托管在 `/packs/<组>/<包id>.zip`，让维护方与玩家按 sha256 自取，绕开上传站的入口带宽。

### 6.3 尺寸与去重的规矩

- 同名不同字节 = **分歧**，不是更新。判据只用两样：`sha256` 与 PNG 实际像素（`IHDR` 的宽高），不看文件名也不看谁新。
- 本站要发上游不提供的字节（例如把一张 216×216 的低清贴图换成 316×316 的高清版），唯一通道是 `sources.json` 的 `overrides` + 仓库内 `pin/<path>` 的字节：`{path, size, sha256, why}` 三样都会被逐字节核对，不符就中断发布。生效点在 `src/sources.mjs:applyOverrides()`——它跑在索引序列化**之前**，所以缓存令牌、验收门禁、`tree.json`、字节抽样描述的都是真正提供的内容；`art.json` 的 `overrides` 会公开列出双方尺寸与 `why`。
- 额外来源（别人的整棵素材树）走 `sources.json` 的 `sources`，**ADDITIVELY**：只写主树没有的路径，同路径不同字节一律报告而不覆盖。
- **贴图与它的 `.atlas` 必须成对换**：atlas 记的是 region 坐标与页尺寸，一半新一半旧会直接画歪。

### 6.4 当前托管在这里的 mod 产物

基址 `<CDN>` = `https://speedcdn.jiangjiangze.icu`（规范门牌、order 第一位；同桶 `https://weishucdn.jiangjiangze.icu` 亦可；`weishucdn2` 即 r2-alt 已于 2026-10-20 删域、retired，不再可用；**`downcdn.jiangjiangze.icu` 是门户站点，任何子路径都回 `200 text/html`，不要拿它验字节**）。

| 对象 | 用途 |
|---|---|
| `<CDN>/packs/sp-forge-2026-10-13/index.json` | 交接清单：逐包 url / sha256 / 字节 / 条目数 / 引擎校验结果 / 不兼容清单 |
| `<CDN>/packs/sp-forge-2026-10-13/clemnt-addition.zip` | 克莱门莎完整包（棋子 + 驻守 + 三条盟约归属 + 立绘与中日语音） |
| `<CDN>/packs/sp-forge-2026-10-13/makoto-voice.zip` | 结城理 14 条日语语音 |
| `<CDN>/packs/sp-forge-2026-10-13/i18n-online-gaps.zip` | 引擎缺失的 56 条界面文案 |
| `<CDN>/packs/sp-forge-2026-10-13/cosmetics-01.zip … cosmetics-07.zip` | 272 套时装美术（2,175 个文件，解后 350.6 MiB），分片上限来自引擎读侧 `shared/zip.js` 的 64 MiB / 4096 条 |
| `<CDN>/assets/spine/enemy/enemy_10138_xdsnow/enemy_10138_xdsnow.png`（72,530 B / 316×316）与同目录 `.atlas`（1,853 B） | 6.3 那条高清 override 的实际字节：上游 0.2.5 提供的是 26,989 B / 216×216 |

每个包的 `pack.json` 与 `assets/` 都在引擎 0.18.3 的干净 workshop 根里单独装载过，`0 error(s)`；解到工坊根时目录名必须等于包 id（`<工坊根>/<包 id>/pack.json`）。

## 缓存约定

| 内容 | 头 |
|---|---|
| 素材 / 字体（带 `?v=<令牌>`） | `public, max-age=31536000, immutable` |
| 素材 / 字体（裸路径，无令牌） | `public, max-age=3600` |
| 文档 `/docs/**` | `public, max-age=3600`（浏览器也是 1 小时——文档没有令牌可依，且每次发版都可能变） |
| 清单与 `cdn/v1/*.json` | `public, max-age=300` |
| 按令牌冻结的副本（`cdn/v1/*-<令牌>.json`、`packs/**`） | `public, max-age=31536000, immutable` |

逐路径的准确值以 `<CDN>/cdn/v1/api.json` 的 `endpoints[].cache` 为准；上表是归类，不是清单。

素材 URL 带 `?v=<上游 tag>`：上游改了同名文件时 tag 会变，URL 随之改变，所以不需要等 CDN 缓存过期，也不需要 purge。

## CORS

CDN 对全部路径返回 `Access-Control-Allow-Origin: *` 以及 `Access-Control-Expose-Headers: Content-Length, Content-Range, ETag`，支持 `HEAD` 与 `Range`。客户端用 `img.crossOrigin='anonymous'` 取图不会污染 canvas（WebGL 贴图正常）。
