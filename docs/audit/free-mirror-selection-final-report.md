# 最终报告：免费多源加速 + 客户端自动选源

- 日期：2026-10-10
- 状态词按根 `AGENTS.md`：`BASELINE` / `IMPLEMENTED` / `PASS` / `PENDING`

## 0. 状态总览

| 阶段 | 状态 | 证据 |
|---|---|---|
| 0 基线审计 | `PASS` | `docs/audit/free-mirror-selection-baseline.md`，commit `3974342` |
| 1 镜像实测 | `PASS` | `docs/audit/free-mirror-verification.json` + `tools/verify-mirrors.mjs`，commit `ba91be8` |
| 2 清单能力字段 | `PASS` | commit `a364f5d`，`tests/origins.test.mjs` +6 |
| 3 选源器 | `PASS` | commit `5012b9d`，`tests/pick-eligibility.test.mjs` 12 条 |
| 4 客户端接入 | 编译 `PASS` + **选源半程真机 `PASS`**；素材供给半程 `PENDING`（见 §11） | commit `f135be4e`，`gradle :app:compileDebugJavaWithJavac`/`assembleDebug` BUILD SUCCESSFUL；设备 prefs 证据见 §11 |
| 5 缓存/源健康/成本 | 部分 `IMPLEMENTED`（6h 缓存、防抖、字节预算、失败回退常量）；**持续失败降级 `PENDING`** | 见 §5 |
| 6 测试与门禁 | `PASS`（CDN 侧）；客户端集成门禁 `PENDING` | 见 §6 |

**核心结论**：选源能力 `IMPLEMENTED` 早已存在（`cdn/v1/pick.js`），缺的是**接入**；本任务把接入补上，并修掉两个会直接导致「模型加载不出来」的缺陷（`@main` 源被选出）。

## 1. 修改文件清单

### CDN 仓（`Stronghold-Protocol-CDN`，分支 `feat/free-mirror-selection`，PR #1）
| 文件 | 变更原因 |
|---|---|
| `docs/audit/free-mirror-selection-baseline.md` | 阶段 0 只读审计 |
| `docs/audit/free-mirror-verification.json` | 阶段 1 机读实测结果 |
| `tools/verify-mirrors.mjs` | 阶段 1 实测脚本（新增） |
| `src/origins.mjs` | 能力字段推导 `capabilitiesOf()`；`disabled` 软开关 |
| `src/sync.mjs` | 清单输出能力字段；发布前「无素材可用源则拒绝发布」门禁 |
| `origins.json` | 新增 `disabled: []` |
| `src/pick.js` | 资格过滤、逐次重试、分阶段测速、缓存、防抖、去 `AbortSignal.timeout` 依赖 |
| `tests/origins.test.mjs` | +6 条能力字段测试 |
| `tests/pick-eligibility.test.mjs` | 新增 12 条 |

### 客户端仓（`stronghold-master-play`，分支 `feat/free-mirror-selection`）
| 文件 | 变更原因 |
|---|---|
| `android/.../ArtSource.java` | 新增：本机会话选源（读 mirrors.json → 过滤 → 探针 → 取胜出）+ 6h 缓存 + 失败回退常量 |
| `android/.../ArtCdn.java` | `cdnUrlFor()` 基址改为 `ArtSource.base()`；允许主机表加入镜像主机 |
| `android/.../MainActivity.java` | `onCreate` 接线：先采纳缓存，再后台重测（异步、非启动依赖） |

**上游冲突面**：`android/**` 是我方线（上游无 Android），`src/**`+`origins.json` 是 CDN 仓自有；**未触碰**上游 `server/**`、`public/**`、玩法/首页/大厅/经济。

## 2. 数据流与调用链

```
origins.json ──► src/origins.mjs(capabilitiesOf) ──► src/sync.mjs ──► cdn/v1/{mirrors,art}.json + cdn/v1/pick.js
                                                                          │
客户端：MainActivity.onCreate ──► ArtSource.loadCached()  ──► 采纳 6h 内缓存选源
                          └──► ArtSource.refresh()（后台）──► 读 mirrors.json → 过滤 → 探针 → 缓存胜出源
                                                                          │
页面/预取请求 /assets/<rel> ──► MainActivity 拦截 ──► ArtCdn.cdnUrlFor() ──► ArtSource.base() + <rel>
                                                                          │
                                            直连 https://<胜出源>/assets/<rel>（不经 Worker）
```

## 3. 各镜像真实覆盖与实测（阶段 1）

| id | kind | 判定 | 依据 |
|---|---|---|---|
| r2 / r2-alt | r2 | `eligible` | 代表性 6 路径 200、解压后字节 sha256 全一致；**同桶** → 同一 `faultDomain=r2-bucket` |
| jsdelivr-assets / ghfast-assets | git | `eligible` | 同上；压缩传输已按解压后字节判定 |
| pages | pages | `eligible` | 同上 |
| **jsdelivr / ghfast-raw（@main）** | git | **`ineligible`** | 6 条素材路径 **全 404**（134 B / 14 B 的 HTML 错误页） |
| gitcdn-own | git | `relay` | 字节正确，但 Worker 中继，**不得作默认直连候选** |

判据是**解压后字节的 sha256 + 长度**，不是 HEAD 的 `content-length`（后者对压缩源是压缩后长度）。

## 4. 玩家端测速参数与请求量

| 项 | 值 |
|---|---|
| 初筛 | ≤5 源 × 32 KiB（客户端读满即取消，不需要 Range） |
| 复测 | 前 2 源 × 2 次 × 64 KiB |
| 单次/总时限 | 6 s / 20 s |
| 单次重测流量 | ≤ 5×32 + 2×2×64 = **416 KiB** |
| 缓存 | 6 h（`resolveSource`/`ArtSource` 各一份，键 `sp.mirror.pick` / `sp-art-source`） |
| 2000 用户各重测一次 | ≈ **812.5 MiB**（探针传输预算，非 Worker 流量，也非素材下载量） |
| 遥测 | **无**：不新增任何上报；结果只存本地 |

## 5. 素材请求绕过 Worker 的证据

- 选源器默认 `allowRelay:false`（`pick.js`）与 `ArtSource` 显式跳过 `proxied:true`，因此**默认候选不含任何 Worker 中继**。
- `ArtCdn.cdnUrlFor()` 生成的是 `https://<镜像主机>/assets/<rel>` 的**直连绝对 URL**；阶段 1 实测这些 URL 直接返回 200/384,453 B（`ACAO:*`、Range 206），不经过 Worker。
- `/dl/` 短链仍为 302，未改成字节代理（本任务未触碰）。

## 6. 自动换源与回退测试

| 场景 | 结果 |
|---|---|
| 单源失败不阻断其他源 | `PASS`（`pick-eligibility`：one dead mirror does not stop the others） |
| 首次尝试抖动不丢弃该源 | `PASS`（retry 测试；旧实现此处会丢源） |
| 不能供素材的源永不胜出 | `PASS`（`@main` 源根本不进入候选） |
| 截断 200 / 空 200 判坏 | `PASS`（沿用并保留原 `mirror-and-bytes` 断言） |
| 全源失败 → 回退编译期常量 | `IMPLEMENTED`（`ArtSource.base()` 在任何失败路径返回 `Line.ASSETS_CDN_PREFIX`）；**真机 `PENDING`** |
| 缓存过期/源已下线 → 重测 | `PASS`（`resolveSource` 两条） |
| 字节预算 | `PASS`（staged 测试断言 ≤ 上限） |

## 7. 回归

| 项 | 结果 |
|---|---|
| CDN 测试 | 198 pass / 6 fail —— 6 条属**另一并发会话**的 `tests/admin-page.test.mjs`（未跟踪文件），与本任务无关 |
| 客户端测试 | 639 测，629 pass，0 fail（10 skip） |
| Android 编译 | `BUILD SUCCESSFUL`（含新增 `ArtSource`） |
| 热更新 / 服务器配置 / 公告 | 未触碰（未改 `Updater`/`ServerConfig`/`server-config.js`） |

## 8. 免费额度与瓶颈

| 服务 | 约束 | 影响 |
|---|---|---|
| Workers | 免费 10 万请求/日 | 本方案 Worker 只在 `/m/<id>` 做 302（**尚未实现**，见 PENDING）；素材**不经** Worker |
| R2 | 10 GB 存储 + 1000 万 Class B/月 | 主源；素材命中 R2 属 Class B |
| Pages | 软带宽 ~100 GB/月 | 只作镜像之一，非默认 |
| jsDelivr | 建议活跃文件 ≤1 万，本仓 12,261 | **超出建议值** → 只作候选，不作默认 |

## 9. 提交、分支、PR

| 仓 | 分支 | commits | PR |
|---|---|---|---|
| Stronghold-Protocol-CDN | `feat/free-mirror-selection` | `3974342` `ba91be8` `a364f5d` `5012b9d` | **#1** https://github.com/jingjiangze/Stronghold-Protocol-CDN/pull/1 |
| stronghold-master-play | `feat/free-mirror-selection` | `f135be4e` | 未开（按计划「验证通过后再开」；真机验收 PENDING） |

## 10. 未通过项 / 风险 / 回滚

- `PENDING` **素材供给半程的真机观察**（阶段 4 的剩余要求）：选源本身已在真机 `PASS`（§11），但「素材 URL 用胜出源、直连镜像」需要 arm64 环境或流水线包才能观察——本机 x86_64 AVD 跑不了 arm64 Node 载荷，页面不加载就没有逐文件 `/assets/**` 请求。首选源禁用后换源同理。
- `PENDING` **`/m/<id>` 单域网关**：本任务未实现（审计文档 §4 建议 302+缓存，避免 Worker 承担素材转发）。当前形态是**客户端直连各镜像**，已满足"不新增服务器、不让 Worker 转发素材"。
- `PENDING` **持续失败的短期降级**：目前失败即回退常量，未实现"降级 N 分钟后重试"。
- 风险：CF Workers/Pages 免费额度需按实际套餐核（基线文档 §7）。
- 回滚：CDN 侧 revert `feat/free-mirror-selection`（未合并即无影响）；客户端 revert `f135be4e`，或把 `ArtSource.refresh()` 调用摘掉即完全恢复旧行为（`base()` 回退常量）。

## 11. 真机（模拟器）验收结果（2026-10-10 补）

环境：AVD `medium_phone`（API 35，**x86_64**）+ `assembleDebug` 出的 17 MB APK（webroot 由
`build-webroot.mjs --no-assets` 生成，stamp `b9ffe0cc10e8fe55d32f1414`）。完整记录见客户端仓
`docs/audit/pr1-device-acceptance.md`（commit `d8518ed9`）。

| 验收项 | 状态 | 证据 |
|---|---|---|
| 启动执行选源逻辑 | **PASS** | 设备写出 `shared_prefs/sp-art-source.xml` |
| 过滤掉不能供素材的源 | **PASS** | 选中 `jsdelivr-assets`（assets-raw），**未**选中 `jsdelivr`（@main，对 assets/** 全 404） |
| 按本机链路选最快 | **PASS** | 选中 `id=jsdelivr-assets`，与硬编码的 `weishucdn` 不同 → 真实测量而非默认值 |
| 结果持久化并被复用 | **PASS** | 同文件含 `at` 时间戳；二次启动复用 |
| **素材 URL 使用胜出源** | **PENDING** | 该 APK 缺 Node 宿主载荷（`server.log`: `Cannot run program "./libnode.so"`），页面不加载 → 无逐文件 `/assets/**` 请求可观察；且载荷是 arm64 而本机 AVD 是 x86_64 |
| 首选源禁用后自动换源 | **PENDING** | 同上 |

- 「走域名可以做到自动最快镜像」这一前置条件：**PASS**（真机证据）。
- 端到端需 **arm64 设备/模拟器**，或用发布流水线（T4）出的包。
- 验收用临时签名密钥已删除；构建期改动的 `shell-ui-version.txt` 已还原。

## 12. P1/P2（docs 作为一等 CDN 源）——已执行

审计见 `docs/audit/official-docs-wiki-as-cdn-source.md`（PR #2）。审计里 P3（文案）先落地，P1/P2 于本轮补齐：

| 项 | 内容 | 状态 |
|---|---|---|
| **P2** `docsEligible` | `src/origins.mjs` 的 `capabilitiesOf()` 新增该字段（只有持发布树的源为 true：r2 / r2-alt / pages；git 挂载源 false），`sync` 随清单发布 | `PASS`（`tests/origins.test.mjs` 2 条） |
| **P1** `cdn/v1/docs.json` | 新增 `src/docs-source.mjs`：把发布索引按 `docs/` 过滤成索引（每文件 path/size/sha256 + 发布 token + upstream tag + 取最新说明），`publishArt` 发布 | `PASS`（`tests/docs-source.test.mjs` 6 条） |
| 契约 | `src/api-contract.mjs` 增加 `/cdn/v1/docs.json` 条目；`/cdn/v1/pick.js` 条目补上「只挑能供素材的源」 | `IMPLEMENTED`（随下次 sync 生效） |

**注意**：P1/P2 是**发布侧**改动——`cdn/v1/docs.json` 要等下一次 `sync` 运行才会出现在线上；
`docsEligible` 同理随下次清单发布生效。在此之前线上接口里没有这两个字段（页面与选源器对旧清单的
行为不变：`docsEligible` 缺省视为可用，`docs.json` 尚未存在）。

`PENDING`：`cdn/v1/index.json` 是否已含 `docs/` 的 sha256 未核实（本机代理拉 1.77 MB 反复超时）
—— P1 无论该问题答案如何都成立（它是索引的 docs 视图 + token，比拉全表更省）。

