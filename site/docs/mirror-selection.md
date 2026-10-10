# 多源自动选源：客户端按自身链路挑最快镜像（2026-10-10）

> 续《镜像站》。那一篇只说「有哪些源、各源分发什么」。`pick.js` 把「用哪个镜像」从**写死的域名**变成
> **运行时决策**：部署机在一个网络、玩家在另一个网络，两边对「谁最快」没有共同答案。本篇记这套机制、
> 资格过滤、客户端集成与验收。日期：2026-10-10 · 全部来自仓库源码与线上实测，不是估算。

---

## 一、一句话结论

- 素材清单（`data/assets.json` 等）里的 URL 指向**主源**；客户端/站点用 `pick.js` 给每个镜像**测速**，
  选最快的那个，再用 `rebaseManifest()` 把清单里的基址整体换掉——**换源只改一次清单，不动客户端代码**。
- 资格过滤：客户端逐条排除 `coverage:"partial"`（git 挂载源，源里没装全素材树）、`assetEligible:false`、
  `proxied:true` 三类源；后两类当前线上没有源设，是写死在客户端的防御性安全闸。
- 客户端（Android re-apk）：每台设备**自己**挑源，6 小时 TTL，跨启动缓存；任何失败都回落到编译期常量
  （旧行为），**不会把设备指向清单没列的主机**（fail-closed 白名单）。

---

## 二、服务端给的两份数据

| 文件 | 内容 | 缓存（线上实测） |
|---|---|---|
| `/cdn/v1/mirrors.json` | 镜像清单（`flat[]`：id / kind / root / base / 可选 coverage / probe / note；另含 packs / upstream / token） | `public, max-age=300`（CORS `*`） |
| `/cdn/v1/pick.js` | 零依赖 ES 模块：`pickFastest()` 测速返回最快源；`rebaseManifest()` 换源 | `public, max-age=14400`（4h，CORS `*`） |

> ⚠️ **不存在** `/cdn/v1/docs.json` 这种接口：docs 走的是 `docs/**` 静态树（只在 R2 / Pages，git 挂载源 404），
> 不是 `/cdn/v1/` 下的独立契约文件。接口清单本身就是 `/cdn/v1/api.json`。

---

## 三、测速怎么做（pick.js）

`pickFastest(mirrors, { path, attempts=2, timeoutMs=6000 })`：

1. **每个镜像并发测**，各取 2 次、取最快一次（冷连接不作为判决）。
2. **探针路径用镜像自己发布的 `probe`**，不是调用方默认路径——因为 R2/Pages 源有 `/cdn/v1/` 树，而 git 挂载源
   对 `/cdn/v1/*` 返回 502、对 `/robots.txt` 404。若不读 `mirror.probe`，所有 git 源都会被误判为坏源（这就是旧 bug）。
3. **200 不够**：还比对 `content-length` 与实际收到的字节，短读 / 空体当作坏源——避免「状态码正常、首块正常、
   很久以后才暴露」的最坏失败。
4. 返回 `{ best, ranked }`，按时延排序。

`rebaseManifest(text, { from, to })`：把清单文本里主源基址**整体替换**成选中源的基址（一次字符串替换，不含逐文件改写）。

---

## 4. 资格过滤（哪些源不测）

客户端（`ArtSource.java` 第 209–211 行）**逐条排除**三类源，从 `mirrors.json` 的 `flat[]` 里读：

| 排除条件 | 含义 | 当前线上是否真的有 |
|---|---|---|
| `assetEligible == false` | 发布方显式声明「此源不适合给素材」 | **防御性**：当前没有任何源设这个值，默认当 `true` |
| `coverage == "partial"` | 源里没装全素材树，测了也是 404 | **真实存在**：git 挂载源（`@main` 分支）会带这个标记 |
| `proxied == true` | 每字节都过 Worker 中转，免费计划预算付不起 | **防御性**：当前没有任何源设这个值，默认 `false` |

> 所以「当前线上真正被过滤掉的」只有 `coverage:"partial"` 的 git 挂载源。其它两条是**写死在客户端的安全闸**——
> 万一将来某源声明自己不胜任，客户端不会把它选上，不需要改客户端或发版。
>
> 注意一个细节：`src/origins.mjs` 里 git 源的 `base` 指向 `<root>/`，`coverage` 默认 `"partial"`。
> 素材树已于 2026-10-09 提交到本仓 `assets-raw` 孤儿分支，所以**指向那个分支的 git 源可以是全量**；
> 而 `root` 仍落在 `@main` 的那条，因为素材在另一个分支，仍是 `partial`。客户端不看分支名，只看 `coverage` 字段，
> 所以「谁能当素材源」完全由发布方在 `origins.json` 里声明、由 `sync.mjs` 如实带进 `mirrors.json`。

另外：客户端挑源时**只认白名单里的 host**（`weishucdn` / `weishucdn2` / `spages` / `gitcdn` / `cdn.jsdelivr.net` /
`ghfast.top` / `dl.jiangjiangze.icu` / `jingjiangze.github.io`），列表在构建期写死，**不读网络**——
被篡改的 `mirrors.json` 无法把设备指到新主机。

---

## 五、客户端集成（Android re-apk）

`ArtSource.java` + `ArtCdn.java`（commit `f135be4e`，分支 `feat/free-mirror-selection`）：

- `ArtSource.refresh()`：单独线程拉 `mirrors.json` → 对每个候选发一个**封顶 32 KB** 的小探针（不是下载）→
  选最快；结果（id / base / 时间戳）写 `SharedPreferences`，6 小时 TTL，**跨启动缓存**。
- **不阻塞启动**：挑源线程跑着，页面先用编译期常量 `Line.ASSETS_CDN_PREFIX`，挑好了再切。
- `ArtCdn.cdnUrlFor(rel)`：**唯一的取素材钩子**，把 `/assets/<rel>` 映射到选中源的 `ASSET_PREFIX`；
  `MainActivity` 先查本地树 / APK，都没有才回退到该源**同域**取（跨域图会污染 canvas）。
- **fail-safe by construction**：任何失败路径（无网络 / 列表解析失败 / 没人应答 / 答案不在白名单）
  都让 `base()` 留在编译期常量——挑成了就对，挑不成则**行为与此功能不存在时完全一致**。

---

## 六、验收

```bash
# 1. 接口清单里有 pick.js 与 mirrors.json（应见这两个端点）
curl -s https://weishucdn.jiangjiangze.icu/cdn/v1/api.json | grep -oE '"/cdn/v1/(pick\.js|mirrors\.json)"'

# 2. 站点的测速按钮真在数据上跑（打开 https://downcdn.jiangjiangze.icu/#mirrors 点「开始测速」）
#    应看到每个源一条时延，最快的排在前面；git 挂载源若标 partial 不应被当坏源

# 3. 客户端：真机装 re-apk 后，首次联网挑源，之后 6 小时内不再测；
#    离线 / 测速全失败则不挑（回落主源，功能透明）
```

---

## 七、状态词

- `BASELINE`：pick.js（`src/pick.js`）、mirrors.json（`src/origins.mjs` + `src/sync.mjs`）、客户端 `ArtSource`/`ArtCdn`。
- `IMPLEMENTED`：服务端测速 + 资格过滤 + 客户端按设备挑源 + 6h TTL + fail-closed 白名单。
- `PASS`：CDN 套件 203/0；客户端工具 629/0；`gradle compileDebugJavaWithJavac` BUILD SUCCESSFUL；
  `pickFastest` 在 Node 下对线上 `mirrors.json` 跑通（按 `mirror.probe` 测速、content-length 校验）。
- `PENDING`：re-apk 线 PR #1 真机选源验收（arm64 模拟器限制下，素材取回无法观测）。
