# 基线审计：免费多源加速 + 客户端自动选源（阶段 0）

- 日期：2026-10-10
- 范围：`jingjiangze/Stronghold-Protocol-CDN`（`main` @ 29feeac）+ 客户端 `jingjiangze/stronghold-master-play`（`origin/re-apk` @ ce8e5601）
- 本文件只读审计，不含业务改动。状态词：`BASELINE` / `IMPLEMENTED`（代码存在≠已接入）/ `PASS` / `PENDING`

---

## 1. 结论摘要（先纠正一个易误判）

**选源能力 `IMPLEMENTED`，但接入 `PENDING`。** 仓库里已存在：客户端选源器 `src/pick.js`（发布为 `cdn/v1/pick.js`）、单域多后端中继 `worker/git-mount-relay.worker.mjs`、清单来源配置 `origins.json`、镜像清单发布 `src/sync.mjs`、验收门禁 `src/verify-remote.mjs` / `src/verify-bytes.mjs`。
**但游戏运行时没有调用任何选源逻辑**：客户端只有一个编译期常量 `Line.ASSETS_CDN_PREFIX` 指向 `weishucdn`，素材 URL 由 `ArtCdn.cdnUrlFor()` 用该常量拼出。因此"函数存在"**不等于**自动选源已实现。

---

## 2. CDN 侧数据流（BASELINE，含证据）

```
origins.json ──(readExtraOrigins / gitOrigins)──► src/origins.mjs
                                                   │
deployment targets: r2 (weishucdn) / Pages ────────┤
                                                   ▼
                                     src/sync.mjs 组装 flat 镜像清单
                                     （src/sync.mjs:825-831）
                                                   │
                     ┌─────────────────────────────┼──────────────────────────┐
                     ▼                             ▼                          ▼
        cdn/v1/mirrors.json              cdn/v1/art.json               cdn/v1/pick.js
        （flat[]: id/kind/root/base/     （packs + mirrors 全量）      （PICK_SOURCE，
          probe?/coverage?）                                          src/pick.js 逐字）
                     │
                     ▼
        downcdn 站点测速页（site/js/cdn.js，已修：partial 源不得拿素材徽章）
```

| 项 | 位置 | 事实 |
|---|---|---|
| 来源配置唯一源 | `origins.json` | `extraOrigins`（r2-alt）+ `gitOrigins`（jsdelivr / ghfast-raw / jsdelivr-assets / ghfast-assets / gitcdn-own）+ `retired:["statically"]` |
| 配置读取 | `src/origins.mjs` | https + 公网校验；`base = <root>/assets/`；`coverage` 只在 git 源上出现 |
| 清单发布 | `src/sync.mjs:825-831` | 每条 origin 输出 `{id,kind,root,base,...(probe),...(coverage)}` —— **已有 `probe`/`coverage`，没有 `assetEligible`/`fontEligible`/`enabled`/`supportsRange`** |
| 客户端选源器 | `src/pick.js`（→ `cdn/v1/pick.js`，3,837 B 已上线） | 导出 `pickFastest` / `measureMirrors` / `rebaseManifest`；`Promise.allSettled` 已做到单源失败不阻断其他源；校验 `content-length` 与实际字节，短读判为坏源 |
| 打包通道 | `cdn/v1/art.json` `packs[]` | 每包约 96 MB，`urls[]` = R2 + GitHub + ghfast + gh-proxy（**已含社区镜像前缀**） |
| 单域多后端中继 | `worker/git-mount-relay.worker.mjs`（`gitcdn.jiangjiangze.icu`） | 固定后端表（jsdelivr→ghfast）+ 按路径选分支（main / assets-raw）+ **代理并前置缓存**；明示"非开放代理" |
| 尺寸门禁 | `src/verify-remote.mjs` | 每个清单 URL 必须可解析；处理 CF 的 `HEAD content-length:0` 假象（改用 `bytes=0-0` 读 `content-range`） |
| 字节门禁 | `src/verify-bytes.mjs` | 确定性抽样 sha256 对比发布包索引，排除被转码顶替 |
| 站点测速 | `site/js/cdn.js` | 探针 `mirror.probe || /cdn/v1/probe.bin`；**已修**：partial 源不得拿"最快"素材徽章 |

### 2.1 候选源清单（线上 `cdn/v1/mirrors.json`，8 条）

| id | kind | root | coverage | 素材可用 |
|---|---|---|---|---|
| r2 | r2 | `weishucdn.jiangjiangze.icu` | — | ✅ |
| r2-alt | r2 | `weishucdn2.jiangjiangze.icu` | — | ✅（同桶第二域名，**非独立故障域**） |
| jsdelivr | git | `...@main` | partial | ❌ `assets/**` 404 |
| ghfast-raw | git | `.../main` | partial | ❌ `assets/**` 404 |
| jsdelivr-assets | git | `...@assets-raw` | full | ✅ |
| ghfast-assets | git | `.../assets-raw` | full | ✅ |
| gitcdn-own | git | `gitcdn.jiangjiangze.icu` | full | ✅（Worker 代理，**不算直连镜像**） |
| pages | pages | `spages.jiangjiangze.icu` | — | ✅ |

> 实测（2026-10-10）：`assets/spine/op/char_1016_agoat2/front/char_1016_agoat2.skel` → r2/pages/gitcdn/jsdelivr-assets/ghfast-assets **200 / 384,453 B**，`ACAO: *`；`jsdelivr@main` **404/134 B**、`ghfast@main` **404/14 B**。

---

## 3. 客户端调用链（BASELINE，含证据）

```
APK 壳（Java）
  Line.java:22   CDN = "https://weishucdn.jiangjiangze.icu"      ← 编译期常量（唯一写死点）
  Line.java:28   ASSETS_CDN_PREFIX = CDN + "/assets/"
        │
        ├─ ArtCdn.java:150-157  cdnUrlFor("/assets/<rel>") → <ASSETS_CDN_PREFIX><rel>   ← 唯一 URL 构造点
        ├─ MainActivity.java:2075-2085  服务 /data/assets.json|local-assets.json 时把
        │                               ASSETS_CDN_PREFIX 反写成 "/assets/"（页面看到同源路径）
        └─ Updater.java:1465-1470      热更后把清单里的 "/assets/ 改写成 ASSETS_CDN_PREFIX
        │
页面侧（同源，走 Java 拦截器）
  public/js/assets.js            清单 URL 助手（含 validSpine：接受 "/" 或 http(s)）
  extras/.../art-prefetch.js     走 /data/assets.json，逐条 GET /assets/**（拦截器作答）
  extras/.../preload-center.js   同上（核心/全量两档）
  extras/server/sp-assets.mjs    /assets/** 策略叠加层（默认 OFF）；决策链第 5 层用单一 cdnBase
```

| 事实 | 证据 |
|---|---|
| 素材 CDN 基址是**编译期常量**，全局仅一处 | `_reapk-wt/android/.../Line.java:22,28` |
| CDN URL 构造**唯一入口** | `ArtCdn.java:150-157` `cdnUrlFor()` |
| 清单绝对地址的生成/消费 | `Updater.java:1465-1470`（生成）；`MainActivity.java:2075-2085`（消费/反写） |
| 页面不自己拼 CDN 域名 | `assets.js` 只做 `/assets/…` 同源路径；跨域由 Java 拦截器解析 |
| 服务器下发配置 | 走 `/.well-known/stronghold-client.json`（`server-config.js`），**与素材链无关**，不得误改 |
| 已有"策略可热更"的落点 | `sp-assets.mjs`（overlay API 1，默认 OFF，可 A/B）——**素材策略已经能在热更层改** |

**结论：客户端侧只需一个接入钩子** —— 让 `ArtCdn.cdnUrlFor()` 的基址从常量变为"本次会话选出的源"，其余（清单反写、缓存命名空间、预取）都不需要动。

---

## 4. 与上游的冲突面

| 位置 | 是否上游文件 | 冲突风险 | 建议 |
|---|---|---|---|
| `src/pick.js`、`origins.json`、`src/sync.mjs` | CDN 仓（非上游） | 无 | 直接改 |
| `Line.java`、`ArtCdn.java`、`Updater.java`、`MainActivity.java` | 客户端仓 `android/`（**我方新增，上游无 Android**） | 无（上游不含 Android 线） | 可改 |
| `public/js/assets.js`、`server/http/static.js` | **上游文件** | 高 | 不改；用 `extras/` 叠加层或 Java 层解决 |
| `extras/server/sp-assets.mjs` | 我方叠加层 | 无 | 优先在此落策略 |

> 记忆与证据一致：Android 产品线不向上游提交（`stronghold-upstream-product-line-pr.md`），所以 `android/**` 与 `tools/apk/**` 是安全的改动面；**上游 `server/**`、`public/**` 是冲突面，优先旁路**。

---

## 5. 现存风险（必须修，否则接入即复发）

| # | 风险 | 证据 | 影响 |
|---|---|---|---|
| R1 | `src/pick.js` **无 coverage/资格过滤** | `src/pick.js` 全文件无 `coverage`/`partial` 字样 | 直接喂 `list.flat` 会选出 `jsdelivr@main`（探针在 main 里存在 → 测得出速度）→ **每个模型 404** |
| R2 | 站点示例同样无过滤 | `site/index.html:538` `await pickFastest(list.flat)` | 文档在教人踩坑 |
| R3 | `gitcdn-own` 是 Worker 代理，被当作普通 git 源 | `worker/git-mount-relay.worker.mjs` 头部（"our cache in front" = 代理） | 若把它选为素材源，素材流量过 Worker → 违反免费额度约束 |
| R4 | `r2` 与 `r2-alt` 同桶不同域名 | `origins.json` `r2-alt.note` | 选源时误当两个独立故障域 → 假冗余 |
| R5 | 清单 schema 无能力字段 | `src/sync.mjs:825-831` 仅 `probe`/`coverage` | 客户端无法声明式判断"这个源能不能供素材/字体/Range" |
| R6 | 清单绝对地址是刻意设计 | `server/http/static.js` `SP_ASSET_CDN` 注释 | **不能**改成相对路径（上游原版无该开关，会全 404） |

---

## 6. 准备修改的位置（阶段 2–5 的落点）

| 阶段 | 文件 | 动作 |
|---|---|---|
| 2 | `origins.json` / `src/origins.mjs` / `src/sync.mjs` | 加能力字段 `assetEligible`/`fontEligible`/`supportsRange`/`enabled`/`proxied`（**由 kind+coverage 推导**，不手填） |
| 3 | `src/pick.js` | 加 `requireAssets` 资格过滤；分阶段测速（初筛 32 KiB → 复测 64 KiB×2）；结果缓存 6h；保留"相近则维持现选" |
| 3 | `site/index.html:538` | 示例改为过滤后再 pick |
| 4 | `android/.../ArtCdn.java` | `cdnUrlFor()` 基址由"会话选源结果"提供；无结果回退 `Line.ASSETS_CDN_PREFIX` |
| 4 | `android/.../`（新增小类） | 读 `cdn/v1/mirrors.json` + `pick.js` 的等价逻辑（Java 版或经页面桥） |
| 5 | `extras/server/sp-assets.mjs` | `cdnBase` 由选源结果驱动（影子模式先 A/B） |
| 6 | `tests/*` | 资格过滤 / 失败隔离 / 超时 / 回退 / URL 重写 / 查询与版本保留 |

---

## 7. 未决与假设

- `PENDING` **CF Workers 免费额度**：需按实际套餐核实每日请求/CPU 上限；本审计未读套餐配置。
- `PENDING` **Pages 软带宽**：清单称 GitHub Pages 约 100 GB/月软限制，需实测当前消耗。
- `PENDING` **jsDelivr 大素材树稳定性**：12,261 文件超出其"活跃文件 ≤1 万"的建议值，需阶段 1 实测抽样通过率。
- `[ASSUMED]` 客户端选源可复用 `pick.js` 的**算法**（Java 重写或经 WebView 桥调用），不新增第二套算法。
- 本阶段未做任何业务代码改动、未提交、未发布。
