# 审计：ModelScope / OpenI / hanabi 三源接入现有 CDN

日期：2026-10-11（实测时间 2026-10-10 18:00 UTC）
状态词：`BASELINE` / `PASS` / `FAIL` / `PENDING` / `[ASSUMED]`，每条结论附证据。

---

## 0. 结论摘要（先读这里）

这三个源来自 **Stardust fork 自己的素材分发**（`deploy/stardust/MATERIAL-SOURCES.md`），
不是为我的 `assets-raw` 树建的。实测后三者的处置分别是：

| 源 | 处置 | 一句话理由 |
|---|---|---|
| **ModelScope** `Stardust/arknight-assets` | **接入，但只作为「构建期取源」+ 受限运行时镜像** | 对 fork 独有文件 100% 可取；对我的共有树美术 86%、音频 0% |
| **OpenI** `openi.pcl.ac.cn` | **不接入** | 公开路径 404；字节要经 fork 的私有 resolver（302 到签名 OBS），我不能依赖别人的解析器 |
| **hanabi** `ark-asset.hanabi-ai.cn:25442` | **不接入** | 三次实测全部 `HTTP 000`（5.1s / 5.2s / 0.13s），非标准端口，DNS 解析正常但 TCP/TLS 不通 |

**最重要的一条**：ModelScope 对我的树**不是一个完整镜像**（音频 0%），所以绝不能标成
`assetEligible: true` 就完事。它真正的价值在别处——见 §3。

---

## 1. 源的真实身份：它是 fork 的树，不是我的树

`BASELINE`：我的 `assets-raw` 分支 12,243 个素材文件（618 MiB）；fork 树 15,980 个。

两者集合关系（路径规范化后对比，`assets/assets/**` 的双层路径是下载器 bug、已修正）：

```
共有        10,643   （其中 mp3 6,053 / 美术 4,590）
我独有       1,600   （全是 assets/local/** —— 我的自托管本地化 UI 素材，fork 没有）
fork 独有    5,337   （mp3 2,847 + 美术/骨架 2,490）
```

`PASS`：我独有的 1,600 个清一色是 `assets/local/ui/outer`(659)、`battle`(389)、`common`(160)、
`module`(137)…… 这与「本地自托管素材」的既有结论一致，说明对比本身是对的，不是路径错位。

---

## 2. ModelScope 对我的树：美术 86%，音频 0%

### 2.1 覆盖率（分层抽样，每个 release 逐个回退）

| 类别 | 命中/抽样 | 结论 |
|---|---|---|
| 共有美术（png/skel/atlas/obj/webp） | **43/50 = 86.0%** | 部分 |
| 共有音频（mp3） | **0/20 = 0%** | 完全没有 |
| **fork 独有美术（2,490）** | **40/40 = 100%** | 全集可取 |

`FAIL`（对「完整镜像」这一假设）：数据集里**没有任何 mp3**。逐一验证过：

```
MISS assets/audio/bgm/m_bat_abyssalhunters_intro.mp3
MISS assets/audio/voice/cn/char_1031_slent2/cn_022.mp3
MISS assets/audio/sfx/player/p_atk/p_atk_drgndfmr_n.mp3
MISS assets/audio/voice/jp/char_291_aglina/cn_026.mp3
404  assets/audio/bgm/            （目录本身不存在）
```

这不是抽样误差：fork 树有 8,900 个 mp3，数据集一个都没有。`MATERIAL-SOURCES.md` 也写明
分工是「只镜像公开 **assets美术、模型、Spine和音频**」——但实测没有音频，因此该句与实际
发布内容不符（可能指其私有 resolver 链路，而非这个公开数据集）。

我自己的树里 mp3 占 **188 MiB / 618 MiB = 30.4%**。所以：
**若把 ModelScope 当作我素材树的完整镜像，30% 的字节会 404。**

### 2.2 字节一致性（`PASS`）

命中的文件与我的树**逐字节相同**，12 例抽样 9 例 `SAME`，3 例 `MISS` 且这 3 例都属于
「我独有」（`assets/skill/skchr_cerber_2.png` 等 fork 没有的文件）：

```
SAME len ms=67231   mine=67231  assets/band/band_amedic.png
SAME len ms=439911  mine=439911 assets/spine/op/char_4146_nymph/front/char_4146_nymph.skel
```

结论：数据集是 fork 树的忠实副本，不做二次加工（未压缩/未转码）。

### 2.3 传输能力（`PASS`）

```
GET  → 200，最终落在 cdn-lfs-cn-1.modelscope.cn
ACAO: *            （带 Origin 头实测仍为 *）
Accept-Ranges: bytes → Range 请求实测 206，content-range: bytes 0-1023/439911
ETag / Last-Modified 有；Cache-Control 无；Expires 无
```

**两个必须写进代码的坑**：

1. **`auth_key` TTL 只有 5 秒**。302 目标 URL 形如
   `...?auth_key=1791655256-...`，实测 `expiry - now = 5s`。
   → **签名 URL 不可硬编码、不可缓存、不可入库**。只能请求 `resolve` 路径让它现签。
2. **`Vary` 缺失**。响应有 `ACAO: *` 但没有 `Vary: Origin`。在共享缓存（公司/运营商代理）下
   一个源的响应可能被串给另一个源。对本场景影响有限（只有我们一个 Origin），但记录下来。

### 2.4 性能与稳定性（`PASS`）

```
24 次顺序请求（含 302，冷）  ok=24 fail=0  total=2096ms
24 次并发（10 并发）          ok=24 fail=0  total=435ms
25 次连续打同一路径            ok=25 fail=0  { '200': 25 }   ← 无限频/风控
439 KB 骨架单文件三次        122ms / 94ms / 61ms
```

国内直连很快，且连续请求不触发限流。

---

## 3. 它真正的价值：补我缺的 2,476 个皮肤文件

`PASS`（这是本次审计最有价值的发现）：

fork 独有的 2,490 个美术文件中，**2,476 个是 `assets/skins/**`**（271 套皮肤），
其余 14 个是新干员/分支图标/技能图标。这批文件：

- 在 ModelScope 上 **40/40 = 100% 可取**（命中分布：skin release 18 + voices release 21 + delta 1）
- **1,523 MiB / 2,476 个文件全部已在本地磁盘**（`_stardust-deploy/src/public/assets/skins/`）
- 我的 `assets-raw` 分支**一个皮肤都没有**（`git ls-tree | grep -c skins` = 0）

也就是说：这批素材我已经拿到了，缺的只是「进我的 CDN」。

**已核验 `PASS`（2026-10-11 复测）**：按 `data/assets.json` 的 skins 表逐一比对，
**2,476 / 2,476 全部在磁盘就位，缺 0** —— 包括那例 fork 工具里写死的「仅走 OpenI」例外
`char_340_shwaz_snow_1/illustration.png`。

> 更正：本审计初稿曾报告「下载器把文件写到了 `assets/assets/skins/` 多一层」，
> 那是**我的校验脚本自己多拼了一层 `assets/`** 造成的假象。磁盘布局本来就是对的，
> 无需挪动。真实状态以本节这次复测为准。

---

## 4. 为什么不作为「运行时默认素材源」

`BASELINE`：现有 `origins.json` + `capabilitiesOf()` 会为每个源推导能力字段。

若把 ModelScope 加进 `extraOrigins`，`capabilitiesOf()` 会因为没写 `coverage`
而推导出 `assetEligible: true`（源码：`const full = origin?.coverage !== 'partial'`）。
**这是错的**——它对音频 0% 覆盖，客户端选中它之后 30% 的素材字节会 404。

三个可选形态，取第一和第三个：

| 形态 | 判断 |
|---|---|
| A. 运行时镜像（写进 `origins.json`） | **否决**：音频 0%；且 5 秒 `auth_key` 意味着每次请求都要 302，客户端多一跳、且不可缓存 |
| B. 完全不接 | **否决**：2,476 个皮肤是实打实的缺口 |
| **C. 构建期取源 → 入库 → 由现有 git 挂载源服务** | **采纳** |

**形态 C 为什么更好**：入库后，皮肤会随 `assets-raw` 分支一起被
`jsdelivr-assets` / `ghfast-assets` / `gitcdn-own` 自动服务——这三个源已经是
`assetEligible: true` 且实测字节正确。等于**用一次构建换来三个已有源的覆盖**，
而且不用新增任何运行时依赖、不受 5 秒签名 TTL 影响、不引入第三方域名作为玩家可见依赖。

**第三方依赖风险**：ModelScope 数据集是第三方公开资产，所有者可随时删除或改 revision。
构建期取源是一次性动作（文件入库后即自持），所以这个风险被限制在「构建那一次」，
不会传导到玩家运行时。这是选 C 而非 A 的第二个理由。

---

## 5. 与现有链路的冲突检查

`BASELINE`：能力字段（`assetEligible`/`direct`/`faultDomain`）**只在
`feat/free-mirror-selection` 分支**，main 分支的 `src/sync.mjs` grep 不到
`assetEligible`/`capabilitiesOf` —— 但线上 `mirrors.json` 里 8 个源全都带这些字段。

`[ASSUMED]`：线上清单是从该特性分支发布的（记忆「改完 CDN 发布产物要走 sync
interface-only 重发」与此一致）。`sync.yml` 的 `actions/checkout@v4` 不带 ref，
默认取仓库默认分支 = `main`，所以**下次定时 sync 会用 main 的代码重发，能力字段会消失**。
这一条我没有直接验证发布历史，标为待验证。

`PENDING`：因此本次改动基于 `feat/free-mirror-selection` 建分支，不直接改 main。

`BASELINE`：共享工作树 `stronghold-cdn/repo` 有另一个会话的未提交改动
（`site/_headers`、`site/index.html`、`src/site-data.mjs` 等 11 个文件）。
本次工作全部在独立 worktree `_ms-wt` 进行。

---

## 6. 执行项

1. ~~修路径 bug~~ —— **不需要**：经复测，2,476 个皮肤文件路径本来就是对的（见 §3 更正）。
2. ~~补 OpenI 例外~~ —— **已完成**：`char_340_shwaz_snow_1/illustration.png` 已在磁盘（缺 0）。
3. **入库**：把这批 skin 文件提交到 `assets-raw` 分支，由现有 git 挂载源自动服务。
4. **明确不接入**：OpenI / hanabi 不写进 `origins.json`（理由见 §0 与 §7）。
5. **审计文档**入仓，说明为什么 ModelScope 不作为运行时默认源。

`PENDING`（不在本次范围，写明）：
- 皮肤入库后 `assets-raw` 从 618 MiB → 约 2.1 GiB，需确认 jsDelivr 对超大仓的限制
  （既有记录：jsDelivr 建议活跃文件数 ≤ 1 万，当前 12,265，入库后会到约 14,741）
- 是否需要一个「skin 子集」独立分支以免拖慢 git 挂载源
- §5 那条「main 缺能力字段」的发布链核实

---

## 7. 另两个源为什么不接（实测依据）

### 7.1 hanabi 静态回退源 —— `FAIL`

`ark-asset.hanabi-ai.cn:25442`（fork 的静态回退源）三次实测：

```
https://ark-asset.hanabi-ai.cn:25442/releases/v013-hangzhou-.../assets/...  HTTP 000  t=5.224s
https://ark-asset.hanabi-ai.cn:25442/releases/v013-hangzhou-.../assets/...  HTTP 000  t=0.133s
https://ark-asset.hanabi-ai.cn:25442/                                       HTTP 000  t=5.271s
```

DNS 能解析（`36.103.203.216`），但 TCP/TLS 连不上；`http://` 明文访问返回 400。
非标准端口 25442 大概率被运营商/本机网络策略拦。
**且它是 fork 自有的运维主机，本来就不是给第三方用的公开镜像。** 不接入。

### 7.2 OpenI —— `FAIL` + 架构上不可依赖

- 站点可达（`https://openi.pcl.ac.cn` → 200），但公开数据集路径 404：
  `https://openi.pcl.ac.cn/Stardust/arknight-assets` → **404**。
- fork 的 resolver（`deploy/stardust/openi-resolver/server.mjs`）是**他们自己的服务**：
  它持有清单、做路径白名单、返回 302 到签名 OBS URL。公开下载「无需 Token」，
  但**解析入口本身是别人的主机**。

两个否决理由：

1. **依赖别人的解析器** = 我的玩家素材可用性挂着第三方一个自部署服务的存活。
   这比起「ModelScope 官方数据集」这种平台级服务脆弱得多。
2. fork 的 `MATERIAL-SOURCES.md` 明确写了批准清单是**封闭白名单**
   （「最多三个明确审核、固定且去重的 mirror 目录」「未知路径的 `nil` 仍拒绝」）——
   它是为 fork 自己的素材集设计的，不会为我的路径服务。

唯一那条 OpenI 例外（`char_340_shwaz_snow_1/illustration.png`）**已经拿到**
（从 ModelScope 侧取到，见 §3 复测），所以没有为了它去接 OpenI 的理由。
