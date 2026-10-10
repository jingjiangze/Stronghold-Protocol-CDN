# 审计：把官方文档与 wiki 数据做成 CDN 下载源

- 日期：2026-10-10
- 范围：`Stronghold-Protocol-CDN`（`origin/main` @ 9fb6b06）+ 页面 `downcdn.jiangjiangze.icu`
- 状态词：`BASELINE` / `IMPLEMENTED` / `PASS` / `PENDING`

## 0. 先分清两个「docs」，否则会改错对象

| | 内容 | 谁写的 | 发布在哪 | 谁在索引它 |
|---|---|---|---|---|
| **A. `site/docs/**`** | 我们的文档：`agent-upload.md`、bandwidth、WS 链路压缩两份… | **我们** | `downcdn.jiangjiangze.icu/docs/**`（Pages 站） | **已有**：`src/docs-index.mjs` → `data/docs.json`（并发会话已合并 main，commit `94c421b`/`0e77b4c`） |
| **B. 上游包内 `docs/**`** | `PLAYING.md`、`DEPLOY.md`、`research/*.json` 四份 wiki 数据 | **官方** | `<CDN>/docs/**`（weishucdn / R2 + Pages） | **无索引**（页面靠 `tree.json` 现渲染，api.json 只写了路由） |

本审计的对象是 **B**（用户贴的那一段「官方文档与 wiki 数据」）。A 的「取最新」机制已经在 main 上，不要重复造。

## 1. BASELINE（已取证）

| 事实 | 证据 |
|---|---|
| B 的键 = 上游包内路径 | `site/index.html` docs 段；`src/api-contract.mjs:94`（`path: '/docs/**'`） |
| 内容 6 个文件 | `PLAYING.md` 77 KB、`DEPLOY.md` 33 KB、`research/03-operators.json` 1.5 MB、`05-enemies.json` 410 KB、`05-maps.json` 196 KB、`07-assets.json` 1023 KB |
| `.md` 以 `text/plain; charset=utf-8` 发送 | `api-contract.mjs:95-97`（不带 charset 中文会被按 Latin-1 解码） |
| 缓存：浏览器 1 h；边缘 裸路径 1 h / 带 `?v=` 令牌 1 年 | `api-contract.mjs:96`；实测 `/docs/PLAYING.md?v=v0.2.3-c992aeae` → `Cache-Control: public, max-age=3600`（浏览器指令；边缘 TTL 由 CF 缓存规则给，故两者不矛盾） |
| **只在 R2 / Pages**，git 挂载源对它 404 | 页面清单表最后一列 `否（仅 R2/Pages）`；`site/js/cdn.js` 的 `onGitMount()` 把 `docs` 排除 |
| **不进打包通道**（有意决定） | `src/packs.mjs`：`PACK_EXCLUDED_PREFIXES = [DOCS_PREFIX]`，理由「就几个文件、几 MB、通常要单独读，打成 3 MB 的包没人要」 |
| 版本令牌在接口里 | `cdn/v1/art.json` / `mirrors.json` 的 `token`（页面状态行已显示「缓存令牌」） |
| 上游不提供 `/docs/` 路由 | 页面文案 + 与 `server/http/static.js` 的挂载表一致（只挂 public/data/shared/sim/media/packs） |

## 2. 问题：B 现在是「能取到」，但不是「一等下载源」

用户的目标是让官方素材与 wiki 数据**作为 CDN 下载源**可用。素材树早已是一等（`mirrors.json` + `pick.js` + 能力字段，见本仓阶段 1–3 的 PR）。B 的差距是**可发现性 / 可校验性 / 可版本化**三件事：

| # | 差距 | 后果 |
|---|---|---|
| G1 | **没有机器可读的 docs 索引** | 代理要枚举 B，只能拉 85 KB 的 `tree.json` 再从 `dirs.docs` 里挑，且拿不到「这份文件多大 / 哈希多少 / 属于哪个发布」 |
| G2 | **没有显式声明「谁能供 docs」** | git 挂载源对 `/docs/**` 返回 404 这件事，只写在页面 JS 的 `onGitMount()` 里，不在数据里 → 任何选源器都可能把 docs 请求指到 git 源 |
| G3 | **没有一条「可证明是最新」的 URL** | 读者输入的 `/docs/PLAYING.md` 无令牌；浏览器侧固定 `max-age=3600`。代理不主动比对令牌就会拿到最多 1 h 旧的版本，书签更可能任意旧 |
| G4 | 上游发布后 docs 变了，URL 不变 | 与 G3 同源；`sync.mjs:268-269` 的注释已点明「docs 没有令牌在 URL 里，而它们随上游发布变化」 |

**不是差距**：B 不进打包通道（`packs.mjs` 的理由成立，几 MB 的文件单独取更合理）；B 不进 git（它是**派生数据**，随上游发布整体更换，进仓只会让每个发布都 churn 一遍二进制 JSON）。

## 3. 方案对照

| 方案 | 解决 | 成本 | 裁决 |
|---|---|---|---|
| **P1. 发布 docs 索引 `cdn/v1/docs.json`**（每文件 `path/size/sha256/updatedAt` + 发布 `token`） | G1、G3 | 小：sync 时多写一个几 KB 的 JSON | **推荐** |
| **P2. 在清单里显式声明 `docsEligible`**（r2/pages true；git 源 false） | G2 | 小：并入本仓阶段 2 的能力字段体系 | **推荐**（与本仓 PR #1 的能力字段同源） |
| **P3. api.json 与页面写明「取最新」规则**（读 `token` → `/docs/<path>?v=<token>`） | G3、G4 | 极小（文案） | **本次执行** |
| **P4. 把 docs 也镜像到 git 挂载源**（提交进仓） | 多源覆盖 | 大：~3.5 MB 派生 JSON 每次发布整体换一遍；且上游一改就要重提 | 否决 |
| **P5. docs 进打包通道** | 批量下载 | 中：多一个 ~3 MB 的包 | 否决（`packs.mjs` 已有证据充分的相反决定） |
| **P6. 给 docs 一个版本化路径 `/docs/<token>/...`** | G3 | 中：发布路径与缓存键都要改 | 暂缓；`?v=` 令牌已达到同样效果，且不破坏现有键 |

## 4. 推荐形态（P1 + P2 + P3）

```
接口：GET <CDN>/cdn/v1/docs.json        （短缓存，随发布更新）
{
  "schema": 1,
  "token": "<发布令牌，与 art.json 同一个>",
  "upstream": { "tag": "v0.2.3", "publishedAt": "..." },
  "docs": [
    { "path": "docs/PLAYING.md", "size": 78901, "sha256": "…", "updatedAt": "…" },
    …
  ]
}

取最新（代理照做即可）：
  1) GET <CDN>/cdn/v1/docs.json  或  /cdn/v1/art.json  → 取 token
  2) GET <CDN>/docs/<path>?v=<token>                    → 边缘按令牌不可变（1 年）
  3) 校验 sha256（索引里给了）再使用
令牌一变 = 上游发了新版本 = 该重新取；不比对令牌就可能读到最多 1 h 旧的浏览器缓存。
```

## 5. 本次执行范围

- **只做 P3**（用户点名的「修改网页描述」）：`site/index.html` 的 docs 段 + `src/api-contract.mjs` 的 `/docs/**` 条目，写明令牌规则与「唯一的源是 R2/Pages」。
- **P1/P2 未做**（`PENDING`）：P2 应与本仓 PR #1 的能力字段一起落地（`docsEligible` 并入 `capabilitiesOf()`）；P1 是新增发布产物，需按仓库发布流程加测试与门禁。

## 6. 未决 / 待核

- `PENDING` **`cdn/v1/index.json` 是否已含 `docs/` 的 sha256**：本轮因本机代理拉 1.77 MB 超时未能核实。若已含，P1 可以退化为「索引的 docs 视图」，不必新增数据源；若不含，P1 需要从发布包单独取哈希。
- `PENDING` `tree.json` 是否稳定列出 `docs/`（`sync.mjs:559` 注释称会列出，本轮未在线上复核）。
- `PENDING` 上游 `research/*.json` 的**用途**：它们看起来是上游自己的研究/数据导出，是否被任何客户端消费未核；若无人消费，「作为下载源」的收益主要是给人/代理取用，而非游戏运行必需。
