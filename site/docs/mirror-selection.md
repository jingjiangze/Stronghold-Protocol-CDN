# 多源自动选源：客户端按自身链路挑最快镜像（2026-10-10，2026-10-10 更新）

> 续《镜像站》。那一篇只说「有哪些源、各源分发什么」。`pick.js` 把「用哪个镜像」从**写死的域名**变成
> 运行时决策：部署机在一个网络、玩家在另一个网络，两边对「谁最快」没有共同答案。本篇记这套机制、
> 资格过滤、客户端集成与验收。日期：2026-10-10 · 全部来自仓库源码与线上实测，不是估算。

---

## 一、一句话结论

- 素材清单（`data/assets.json` 等）里的 URL 指向**主源**；选源有两套实现，互相独立：
  - **站点**用 `pick.js`（ES 模块）给每个镜像**测速**、选最快、再 `rebaseManifest()` 换源。
  - **客户端（Android re-apk）** 用内嵌的 Java 逻辑（`ArtSource`/`ArtCdn`，见 §五）**自己**挑源——**不读 `pick.js`**。
- 资格过滤：客户端逐条排除 `coverage:"partial"`（git 挂载源，源里没装全素材树）、`assetEligible:false`、
  `proxied:true`、以及 `enabled:false`（`origins.json` 的 `disabled` 软开关）四类源；后三类当前线上只有
  jsDelivr 两条进了 `disabled`，其余是写死在客户端的防御性安全闸。
- 客户端：每台设备**自己**挑源，小文件类与大文件类**分开选**，6 小时 TTL，跨启动缓存；任何失败都回落到编译期常量
  （旧行为），**不会把设备指向清单没列的主机**（fail-closed 白名单）。

---

## 二、服务端给的两份数据

| 文件 | 内容 | 缓存（线上实测） |
|---|---|---|
| `/cdn/v1/mirrors.json` | 镜像清单（`flat[]`：id / kind / root / base / 可选 coverage / probe / note / enabled；另含 packs / upstream / token） | `public, max-age=300`（CORS `*`） |
| `/cdn/v1/pick.js` | 零依赖 ES 模块：`pickFastest()` 测速返回最快源；`rebaseManifest()` 换源 | `public, max-age=14400`（4h，CORS `*`） |

> ⚠️ **不存在** `/cdn/v1/docs.json` 这种接口：docs 走的是 `docs/**` 静态树（只在 R2 / Pages，git 挂载源 404），
> 不是 `/cdn/v1/` 下的独立契约文件。接口清单本身就是 `/cdn/v1/api.json`。

---

## 三、测速怎么做（pick.js，站点侧）

`pickFastest(mirrors, { path, attempts=2, timeoutMs=6000 })`：

1. **每个镜像并发测**，各取 2 次、取最快一次（冷连接不作为判决）。
2. **探针路径用镜像自己发布的 `probe`**，不是调用方默认路径——因为 R2/Pages 源有 `/cdn/v1/` 树，而 git 挂载源
   对 `/cdn/v1/*` 返回 502、对 `/robots.txt` 404。若不读 `mirror.probe`，所有 git 源都会被误判为坏源（这就是旧 bug）。
3. **200 不够**：还比对 `content-length` 与实际收到的字节，短读 / 空体当作坏源——避免「状态码正常、首块正常、
   很久以后才暴露」的最坏失败。
4. 返回 `{ best, ranked }`，按时延排序。

`rebaseManifest(text, { from, to })`：把清单文本里主源基址**整体替换**成选中源的基址（一次字符串替换，不含逐文件改写）。

> ⚠️ **`pick.js` 仍是旧逻辑（`src/pick.js` 本轮未改）**：上面这套「32 KiB 探针 + 按 `mirror.probe` 取最快」是
> commit `6e38598a` 之前的行为，而**它正是把 `jsdelivr-assets` 误判成最快的元凶**（详见
> `docs/audit/asset-slowness-root-cause.md`）。**F1/F2/F3 只落在了 Java 客户端**（§五）；站点页面与任何 JS 消费方
> 仍按旧的「探针吞吐」排序，`cdn/v1/pick.js` 是已上线的旧实现。把它也改成「真实路径 + 必须优于原站的余量」是下一个
> 待办（见 §七 `PENDING`）。当前 `jsdelivr` / `jsdelivr-assets` 已被 `disabled` 软开关剔除（§四），所以站点侧即便
> 用旧逻辑也不会再把设备指到最慢源。

---

## 四、资格过滤（哪些源不测）

客户端（`ArtSource.pick()` 的资格循环）逐条排除四类源，从 `mirrors.json` 的 `flat[]` 里读：

| 排除条件 | 含义 | 当前线上是否真的有 |
|---|---|---|
| `enabled == false` | 发布方软开关关掉（来自 `origins.json` 的 `disabled`） | **真实存在**：`jsdelivr` / `jsdelivr-assets`（2026-10-10 止血，实测在真实素材上最慢且会超时） |
| `assetEligible == false` | 发布方显式声明「此源不适合给素材」 | **防御性**：当前没有任何源设这个值，默认当 `true` |
| `coverage == "partial"` | 源里没装全素材树，测了也是 404 | **真实存在**：git 挂载源（`@main` 分支）会带这个标记 |
| `proxied == true` | 每字节都过 Worker 中转，免费计划预算付不起 | **防御性**：当前没有任何源设这个值，默认 `false` |

> 当前线上真正被过滤掉的，是 `enabled:false` 的 jsDelivr 两条 + `coverage:"partial"` 的 git 挂载源（`@main`）。
> 其余两条是**写死在客户端的安全闸**——万一将来某源声明自己不胜任，客户端不会把它选上，不需要改客户端或发版。
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

`ArtSource.java` + `ArtCdn.java`（**commit `6e38598a`**，分支 `feat/free-mirror-selection`；实测驱动的三处修正）：

- **按类分开选源**：`ArtSource.baseFor(path)` 用前缀 / 扩展名分流——`assets/audio/`、`assets/local/map/`，
  以及 `.mp3/.ogg/.m4a/.wav/.mp4/.webm` 走**吞吐胜出源**（大文件类）；其余走**延迟胜出源**（小文件类）。
  分类用前缀/扩展名、不用尺寸表，因为客户端必须在请求前就决定，而它没有未取过文件的尺寸。
  缓存为 `BASE_SMALL` / `BASE_LARGE` 两个独立基址（`SharedPreferences`，6h TTL，跨启动）。
- **F1 按真实素材路径测**：不再用 256 KiB 热探针。客户端在清单里挑**真实存在的素材路径**各测一组——
  小文件类用 `SMALL_PATHS`（spine atlas / 头像 png / 字体 woff2），大文件类用 `LARGE_PATHS`（一张 3.2 MB 地图 png）。
  小文件类取 **TTFB 中位数**（12k 个小文件，往返主导），大文件类取**总耗时**（字节主导）。
- **F2 必须显著优于原站才切走**：原站 `Line.ASSETS_CDN_PREFIX`（编译期 `weishucdn`）也在同样的真实路径上被测一遍，
  做成「同口径」对照；胜出源需在分数上比原站好出 `MARGIN=20%` 才接管，否则留在原站。
  理由：原站直持字节、中间没有按需回源，判错的代价不对称——宁可留在原站，也不为「看着快一点」的镜像冒险。
- **F3 失败降级**：任一真实文件失败（超时 / 短读 / 截断）即该源**本次会话弃用**（`Sample.failed` 直接判输）。
- `ArtSource.refresh()`：单独后台线程拉 `mirrors.json` → 按类测量 → 写 `SharedPreferences`，6h TTL，**跨启动缓存**。
  **不阻塞启动**：挑源线程跑着，页面先用编译期常量，挑好了再切。
- `ArtCdn.cdnUrlFor(rel)`：**唯一的取素材钩子**，按 `baseFor(rel)` 把 `/assets/<rel>` 映射到选中源的基址；
  `MainActivity` 先查本地树 / APK，都没有才回退到该源**同域**取（跨域图会污染 canvas）。
- **fail-safe by construction**：任何失败路径（无网络 / 列表解析失败 / 没人应答 / 答案不在白名单 / 测量全输）
  都让 `baseFor` 落在编译期常量——挑成了就对，挑不成则**行为与此功能不存在时完全一致**。

> 客户端**不依赖 `pick.js`**：它的选源逻辑是自带的 Java 实现（上述 F1/F2/F3），与站点侧 `pick.js` 的探针逻辑
> 是两套互不相干的代码。所以「把 `pick.js` 改成真实路径」只影响站点/JS 消费方，不影响已装 APK（见 §七 `PENDING`）。

---

## 六、验收

```bash
# 1. 接口清单里有 pick.js 与 mirrors.json（应见这两个端点）
curl -s https://weishucdn.jiangjiangze.icu/cdn/v1/api.json | grep -oE '"/cdn/v1/(pick\.js|mirrors\.json)"'

# 2. 站点的测速按钮真在数据上跑（打开 https://downcdn.jiangjiangze.icu/#mirrors 点「开始测速」）
#    应看到每个源一条时延，最快的排在前面；git 挂载源若标 partial 不应被当坏源

# 3. 客户端：真机装 re-apk 后，首次联网挑源，之后 6 小时内不再测；
#    离线 / 测速全失败则不挑（回落主源，功能透明）

# 4. 客户端按类选源验收（commit 6e38598a，AVD medium_phone）：
#    装机启动后读 SharedPreferences / strings：
#      smallBase = https://weishucdn.jiangjiangze.icu/assets/
#      largeBase = https://weishucdn.jiangjiangze.icu/assets/
#      smallId / largeId 均为空
#    → 两类都留在原站：模拟器链路上没有任何镜像能以 ≥20% 优势击败原站，正是期望行为
#      （改前设备选中的是最慢的 jsdelivr-assets，现已不出现）。
#    注：「某镜像确实快出一档、被切走」这条分支在模拟器验收里没被真实触发（那需要某镜像确实快），
#        该分支只在单测 / 代码层验证过。
```

---

## 七、状态词

- `BASELINE`：pick.js（`src/pick.js`，**仍旧**）、mirrors.json（`src/origins.mjs` + `src/sync.mjs`）、
  客户端 `ArtSource`/`ArtCdn`（commit `6e38598a`）。
- `IMPLEMENTED`：**客户端**测速 + 资格过滤（含 `disabled` 软开关）+ 按类分开选源 + F1 真实路径 / F2 余量 / F3 失败降级
  + 6h TTL + fail-closed 白名单（commit `6e38598a`）；jsDelivr 两条 `disabled` 软开关（commit `424e8c0`）。
- `PASS`：客户端 `gradle compileDebugJavaWithJavac` BUILD SUCCESSFUL；re-apk 装机、AVD 验收通过（两类均落原站、
  smallId/largeId 空，不再落到 jsdelivr-assets）。
- `PENDING`：
  - **`src/pick.js` 仍是旧探针逻辑**，要把 F1/F2 也落到站点/JS 侧（客户端已验证的设计：真实路径 + 优于原站余量）。
  - **F4 服务器侧选源 + 按类清单改写未做**：按类分流目前只在我们的 APK 内生效（走 `ArtCdn.cdnUrlFor` 单一钩子）；
    网页端与上游原版客户端仍拿到单一基址。要做成全客户端生效，得改服务端清单改写（`static.js` 的
    `ART_PATHS_IN_JSON` 扩展成按类映射到不同基址）——那是上游冲突面，需单独评估。
  - `424e8c0` / `6e38598a` 当前在 `feat/free-mirror-selection` 分支，**尚未合入 `origin/main`**；
    `disabled` 已通过仓库自己的 `sync.yml`（`write=true interface_only=true`，run `38056783234` = success）重发
    `mirrors.json` 生效。已缓存选源的设备最长 6h 后才会切走（`ArtSource` TTL）。
  - 本机代理对 `weishucdn` 持续 TLS 握手失败（curl 一次都未成功），「线上已生效」依据为工作流成功，非本机独立复核字节。
