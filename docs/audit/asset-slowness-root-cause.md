# 审计：素材「非常慢」的根因 = 选源指标错，不是 git 源慢

- 日期：2026-10-10
- 触发：玩家反馈战斗内**部分素材加载非常慢**（不是加载不出来）；期望「git 镜像源应该很快」
- 关联：`feat/free-mirror-selection`（PR #1）—— 客户端选源上线后出现，必须优先排除是我引入的回归

## 0. 结论（先给答案）

**根因是选源用的指标不对，不是 git 镜像源慢。**

真实负载是 **~12k 个小文件**（延迟受限：每个文件一次往返），而选源探针测的是**一个 256 KiB 的
热文件**（吞吐受限）。两者的最优解不是同一个源：

- 探针维度：`jsdelivr-assets` 看着最快 → 设备选中它。
- 真实素材维度：`jsdelivr-assets` **最慢，且会掉请求**。

所以「git 源快不快」这个问题本身问错了对象——`ghfast-assets` 确实快（比 R2 还快），
`jsdelivr@assets-raw` 很慢。同一个门类里两个源差了 2 倍以上。

## 1. 实测证据（2026-10-10，同一批真实素材路径，本机）

路径：spine op/enemy skel/atlas/png、char avatar、fonts、local/map 共 8 条；每条加随机 query 破缓存。

| 源 | TTFB 中位 | 总耗时中位 | 200 | 失败 |
|---|---|---|---|---|
| `r2`（weishucdn，原站） | 926 ms | 1666 ms | 8/8 | 0 |
| **`jsdelivr-assets`** | **1479 ms** | 1758 ms | 7/8 | **1 超时** |
| **`ghfast-assets`** | **654 ms** | **873 ms** | 8/8 | 0 |

明细里另有两个信号：
- r2 首条 `char_1016_agoat2.skel` TTFB **5685 ms**（冷连接），第 4 条回到 446 ms → **首连代价显著**，
  选源必须覆盖"冷启动"，不能只测一次。
- 3.2 MB 的 `TX_autochessi_D.png`：r2 **16.6 s**、jsdelivr 7.1 s、ghfast 1.7 s —— 大文件与
  小文件的最优源也不一致（大文件受吞吐支配）。

## 2. 机理

| 项 | R2 / Pages | git 挂载（jsDelivr） | git 挂载（ghfast→raw） |
|---|---|---|---|
| 字节来源 | 自家桶，**本来就有** | **按需回源 GitHub** | 回源 raw.githubusercontent |
| 冷文件 | 首字节即到 | 首次请求要等它回源+缓存 → 慢，且可能限流/超时 | 回源快，且该链路对国内更友好 |
| 文件数敏感性 | 无（每文件都一样快） | 12k 文件超出其"活跃文件 ≤1 万"建议值 | 无明确建议值 |

→ **不能把任何 git 源当默认**；也不能只用探针文件给它打分。

## 3. 要执行的修复（客户端已实现 F1–F3，站点侧 `pick.js` / F4 待办，见 §5）

### F1 打分改为「按真实素材路径测 + 每请求延迟为主」
- `src/pick.js`：`pickStaged()` 增加 `samplePaths`（由调用方从自己的清单里取若干小素材路径，
  例如 spine/atlas/png/字体各取 1–2 条），逐源在这些**真实路径**上取 **TTFB 中位数**为主指标，
  吞吐仅作并列时的次指标（新函数 `rankByLatency()` / `medianTtfb()`）。
- 理由：负载是延迟受限；探针文件对延迟不具代表性（已在 §1 量化）。

### F2 「必须显著优于原站才切走」
- 胜出源需在 TTFB 上比 **R2 原站**好出 `margin`（建议 ≥20%）才允许切换；否则**留在 R2**。
- 理由：R2 是字节的原站，没有回源不确定性；让 git 源只在"确实更快"时才接管，可把回归风险
  降到最小。这条同时解释了用户看到的现象：设备当前切到了**更慢**的 jsdelivr。

### F3 失败即降级（源健康）
- 一次超时/截断 → 该源本次会话降级；连续失败则在 TTL 内不再选它。
- 证据：jsdelivr 在 8 条里就掉了 1 条；真实 12k 文件规模下这会变成成片的慢/空白。

### F4 服务器侧选源（用户要求：「让服务器取 cdn 链接后自动选取最优源」）
服务器侧相比客户端有一个**决定性优势**：**它手上有完整清单，可以先验证"这个源是否完整、是否够快"再下发**。

设计：
1. 盒子（或任何部署方）跑一个 picker：读 `cdn/v1/mirrors.json` → 过滤 `assetEligible/enabled/!proxied`
   → 用**自己 manifest 里抽出的真实路径**按 F1/F2 打分 → 得到胜出源。
2. 写回 `SP_ASSET_CDN=<胜出源>/`（服务端启动读一次），清单里所有 `/assets/**` 随之指向它。
3. 结果与依据（每个源的 TTFB 中位、失败数）**发布**到接口（如 `cdn/v1/pick-report.json` 或
   `network.json` 旁），让客户端可以直接复用服务端的测量结果，而不必各自己测一遍。
4. 客户端保留 F1/F2 的本地测量作为**覆盖**（玩家链路 ≠ 服务器链路），并以"不劣于服务端推荐"为门槛。

> 注意：服务器链路 ≠ 玩家链路，所以 F4 **不能替代**客户端测量，但它是**完整性**与**默认值**的正确位置，
> 也是用户要的「一个入口 + 自动选最优」。

## 4. 立即止血（不改代码也能做）

把盒子 `sp_slot_3002.cmd` 的 `SP_ASSET_CDN` 从 `weishucdn` 改回……**不用改**：
当前它的值就是 `https://weishucdn.jiangjiangze.icu/`（安全）。
真正导致"慢"的是**客户端选源**把请求切到了 `jsdelivr-assets`。
所以在 F1/F2 落地前，最直接的止血是**把 `jsdelivr` 与 `jsdelivr-assets` 放进 `origins.json` 的
`disabled`**（软开关：仍发布、仍可见，但选源器不会用），选源只会落在 r2/pages/ghfast 上。

## 5. 本轮状态（2026-10-10 更新）

### 已做
- 根因定位与量化（§1）、机理（§2）、修复设计（§3）。
- **§4 止血已生效**：`origins.json` 把 `jsdelivr` / `jsdelivr-assets` 放进 `disabled`（软开关）——
  commit **`424e8c0`**（分支 `feat/free-mirror-selection`）。`disabled` 已通过仓库自己的
  `sync.yml`（`write=true interface_only=true`，run **`38056783234` = success**）重发 `mirrors.json` 生效。
  本机代理对 `weishucdn` 持续 TLS 握手失败（curl 一次都没成功），"已生效"依据是工作流成功，非本机独立复核字节；
  已缓存选源的设备最长 6h 后才会切走（`ArtSource` TTL）。
- **F1 + F2 + F3 在 Java 客户端已实现并真机验收**：commit **`6e38598a`**（客户端仓 `feat/free-mirror-selection`，
  Android re-apk）。按实现：
  - `ArtSource.baseFor(path)` 按类分流（audio / local/map / 大媒体扩展名走吞吐胜出源，其余走延迟胜出源）。
  - F1：在**真实素材路径**上测，`SMALL_PATHS`（spine atlas / 头像 png / 字体）取 **TTFB 中位数**，
    `LARGE_PATHS`（3.2 MB 地图 png）取**总耗时**；不再用 256 KiB 热探针。
  - F2：`MARGIN=20%`，原站也在同样真实路径上被测做同口径对照，胜出源须好出 20% 才接管，否则留原站。
  - F3：任一真实文件失败即本次会话弃用该源（`Sample.failed`）。
  - 验收：AVD `medium_phone` 装机，`smallBase`/`largeBase` 均为 `https://weishucdn.jiangjiangze.icu/assets/`、
    `smallId`/`largeId` 空——两类都落在原站，不再选中 `jsdelivr-assets`（改前设备选中的正是最慢的它）。
    「镜像快出一档被切走」分支在模拟器里没被真实触发（需某镜像确实快），只在单测/代码层验证过。

### 未做（不掩饰）
- **站点侧 `src/pick.js` 仍是旧探针逻辑**：F1/F2 只落在了 Java 客户端。站点页面与任何 JS 消费方仍按旧的
  「32 KiB 探针 + 取最快」排序——`cdn/v1/pick.js` 是已上线的旧实现。把它也改成「真实路径 + 优于原站余量」是下一个待办。
  （因为 `jsdelivr` 两条已被 `disabled`，站点侧即便用旧逻辑也不会再把设备指到最慢源。）
- **F4 服务器侧选源 + 按类清单改写没有做**：按类分流目前只在我们 APK 内生效（走 `ArtCdn.cdnUrlFor` 单一钩子）；
  网页端与上游原版客户端仍拿到单一基址。要做成全客户端生效，得改服务端清单改写（`static.js` 的
  `ART_PATHS_IN_JSON` 扩展成按类映射到不同基址）——那是上游冲突面，需单独评估。
- **`424e8c0` / `6e38598a` 尚未合入 `origin/main`**：当前在 `feat/free-mirror-selection` 分支；`disabled` 已通过
  手动 `sync.yml` 重发 `mirrors.json` 生效，但分支本身待合并。

### 修订后的执行顺序
**§4 disabled（已做）→ 客户端 F1+F2+F3（已做，6e38598a）→ 站点 `pick.js` F1+F2（待做）→ F4 服务器侧 + 报告发布（待做）**。
