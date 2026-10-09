# 接入说明

CDN 基址 `<CDN>` = `https://weishucdn.jiangjiangze.icu/`

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
所以这是这些文件唯一走 CDN 的入口。**`.md` 以 `text/plain` 发送**，浏览器会内联显示而不是下载
（`text/markdown` 在 `nosniff` 下会被当未知类型下载）；要原始文件请用 `curl -O`。

## 缓存约定

| 内容 | 头 |
|---|---|
| 素材 / 字体（带 `?v=<令牌>`） | `public, max-age=31536000, immutable` |
| 素材 / 字体 / 文档（裸路径，无令牌） | `public, max-age=3600` |
| 清单与 `cdn/v1/*.json` | `public, max-age=300` |
| 按令牌冻结的副本（`cdn/v1/*-<令牌>.json`、`packs/**`） | `public, max-age=31536000, immutable` |

逐路径的准确值以 `<CDN>/cdn/v1/api.json` 的 `endpoints[].cache` 为准；上表是归类，不是清单。

素材 URL 带 `?v=<上游 tag>`：上游改了同名文件时 tag 会变，URL 随之改变，所以不需要等 CDN 缓存过期，也不需要 purge。

## CORS

CDN 对全部路径返回 `Access-Control-Allow-Origin: *` 以及 `Access-Control-Expose-Headers: Content-Length, Content-Range, ETag`，支持 `HEAD` 与 `Range`。客户端用 `img.crossOrigin='anonymous'` 取图不会污染 canvas（WebGL 贴图正常）。
