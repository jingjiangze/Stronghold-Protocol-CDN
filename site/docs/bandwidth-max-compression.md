# WS 压缩与上行带宽最大化

> 目标：在小上行带宽（以 **10 Mbps** 为算例）的家用盒子上一台服务器能带更多人。
> 全部数字来自本机工作树实测（`C:\Users\16891\android-build\master-play`）与线上探测，不是估算值。
> 日期：2026-10-10 · **WS 链路压缩部分已于 2026-10-12 整体重写，本文件不再维护那一节** ——
> 现行配置与容量一律以 [`ws-link-compression.md`](./ws-link-compression.md) 为准，
> 本文件保留的只有「首载 / 搬素材」这条线（它未变）与整体结论。

---

## 一、结论先行

两件事分开看：**首载**是「新玩家第一次进场吃掉几百 MiB」，**稳态**是「一个席位对局中持续的上行」。
首载靠把素材挪走解决：优化前 **467.9 MiB**（10 Mbps 上占死 6.5 分钟），优化后 **1.48 MiB**（1.2 秒）。

| | 首次进场（新玩家第一次连进来） | 稳态（对局进行中，压缩后） |
|---|---|---|
| 优化前 | **467.9 MiB** | 见 §九（原口径已作废） |
| 优化后 | **1.48 MiB** | **57.5 B/s/席** |
| 10 Mbps 下 | 从「1 人 6.5 分钟」变「1 人 1.2 秒」 | **≈21,000 人** |

也就是说：**首载靠「不让你盒子发字节」（搬素材）解决**，这一条没变，也是本文件继续保留的内容。
**稳态那一半已整体重写**：现行实测是每席位 **57.5 B/s**、10 Mbps 约 **21,000 人**（不是早前的 2,048 B/s / 2,475 人），
且**真瓶颈已经从 WS 帧换成了冷启动的 5.4 MB 客户端代码**（1,573 B/s，比稳态贵 27×）。
完整口径见 [`ws-link-compression.md`](./ws-link-compression.md) 与
[`ws-link-compression-next.md`](./ws-link-compression-next.md)。

> ⚠️ **2026-10-12 作废声明**：本文件早前的稳态口径
> （「稳态 ≈2,048 B/s」「压完 505 B/s」「610 → 2,475 人」「98% 是 `m.public`」）
> **全部作废**，原因有二：
> ① 那组数字是在**机器人座位**上量的 —— 机器人收不到单播，样本里天然没有 `m.private` 与 `b.start`，
> 于是「98% 是 `m.public`」是在一个残缺样本里算出来的；
> ② 线上真实握手里既没有 `server_no_context_takeover`、也没有 `server_max_window_bits=12`，
> 说明「阈值 512 / 关上下文接管 / 窗口 pin 12」那套参数**本身就不在跑**。
> 人类座位 + AI 托管的整局实测给出的是 **105 → 57.5 B/s**，构成是 `b.start` 69% / `m.private` 22% / `m.public` **只剩 3%**。

---

## 二、带宽被谁吃掉了

把服务器出口流量拆成三块，实测：

| 块 | 体积 | 谁发 | 可压性 |
|---|---|---|---|
| **美术素材**（png / 音频 / skel） | **462.6 MiB / 7,969 个文件** | 盒子 | ❌ 已是有损编码产物，gzip 无效 |
| **首载代码**（js / vendor / css / i18n） | **5.33 MiB / 158 个文件** | 盒子 | ✅ gzip l6 → 1.475 MiB（27.7%） |
| **稳态 WS**（b.snap / lobby.list / chat） | 30~35 B/s | 盒子 | ✅ deflate，但基数太小不值得 |

**素材那一块是全部问题的 99%。** 它压不动，只能搬走。

---

## 三、落地措施与实测收益

### 措施 1 — `SP_ASSET_CDN`：把素材整块搬出盒子（收益最大）

```ini
SP_ASSET_CDN=https://weishucdn.jiangjiangze.icu/
```

运行时把 `data/assets.json` 里 7,969 个 `/assets/…` 引用改写成绝对 CDN URL 再回给客户端。

- 线上核验：`GET /data/assets.json` 实测 **1,408,362 字节**，7,969 个文件 / 462.6 MiB **全部**指向 `https://weishucdn.jiangjiangze.icu/assets/…` —— 已生效，无需改动。
- 收益：盒子出口**直接砍掉 462.6 MiB/人**，改由 Cloudflare 边缘承担。
- ⚠️ **`update\PAUSE_AUTOUPDATE` 必须保留**：`sp_update2` 会重写槽脚本并丢掉 `SP_ASSET_CDN`，素材会静默回落到盒子本地（盒子是无素材版），表现为图片全挂 + 上行被打满。

### 措施 2 — 静态代码 gzip level 6（`server/http/files.js`）

已有能力，本轮确认参数与覆盖面：

| 目录 | 文件数 | 原始 | gzip l6 | 剩余 |
|---|---|---|---|---|
| `js` | 132 | 1.89 MiB | 0.667 MiB | 35.3% |
| `vendor` | 7 | 2.82 MiB | 0.629 MiB | 22.3% |
| `css` | 15 | 0.33 MiB | 0.084 MiB | 25.4% |
| `i18n` | 4 | 0.29 MiB | 0.096 MiB | 32.7% |
| **合计** | **158** | **5.33 MiB** | **1.475 MiB** | **27.7%** |

- `GZIP_MIN_BYTES = 512`：小文件不压（压完带 header 反而变大，实测 chat 51 B → 94 B 就是反例）。
- `GzipCache`：8 MiB 以内单文件缓存压缩结果，以上流式压；总上限 96 MiB。
- **`vendor/` 占 54%，且 CF 边缘实测已 HIT** —— 这 2.82 MiB 里大部分连盒子都不用出。

### 措施 3 — `?v=<buildTag>`：让复访归零（本轮新增）

`server/http/static.js` 新增 `versionIndexHtml()`，在回给浏览器的 `index.html` 上给**每一个自有引用**追加 `?v=<buildTag>`（buildTag = `public/index.html` + `public/js` + `public/css` 的 size+mtime 运行时哈希，与 `/healthz.build` 同源）。

命中 `files.js` 的 `IMMUTABLE_CACHE` 分支 → `public, max-age=31536000, immutable`。

- 覆盖 **25/25 处引用**，含 importmap 的 JSON 值（第一版正则只匹配 `href=`/`src=`，漏了 3 处 importmap 条目，已修）。
- 幂等：已带 `?v=` 的引用不会二次打戳。
- `index.html` 自己保持 `no-cache`（ETag 里带 tag），所以新版本能立刻生效，而它引用的资源一年内零请求。
- 线上实测：`max-age=14400` → `max-age=31536000, immutable`，重复请求 4/4 HIT。
- **收益：复访上行 = 0 字节。**

> 为什么 `js` / `css` 故意不进 `LONG_CACHE_DIRS`：靠 `?v=` 走 immutable（一年）比靠 1 天 + 304 更彻底 —— 304 也是一次往返，也占上行。

### 措施 4 — permessage-deflate（**本节已作废，2026-10-12**）

> ⛔ **这一节记录的参数已全部不再使用**，不要照抄。它在追一部被删参数的调优史
> （窗口 12 → 9 → 12），而现行答案是「**故意不声明**」：`on` 档下 `server_max_window_bits`
> 会 pin 住窗口、且实测会致 400 断连；`threshold` 在 `on` 档下是死参数。
> 线上握手实测（见 §九）也证明那套参数从来没有在跑。
>
> **现行配置与三个档位（`off` / `on` / `safe`）、两个「故意不声明」的参数、
> 白名单与 `b.start` 的处理，一律见 [《WS 链路压缩（当前已上线）》](./ws-link-compression.md) §三。**
>
> 下面这条洞察仍然成立、但不再落在这个参数上：**小窗口用更便宜的距离码，对 ~250 B 的战斗帧
> 反而更省**（实测 35.8% vs 36.5%）。它之所以没被采纳，是因为窗口 ≤ 512 B 够不到
> `m.public` 里重复的羁绊 / 状态块 —— 而 `m.public` 在整局实测里只占 **3%**，不再是主战场。

### 措施 5 — `clientCombat: on`（别退回去）

这是**天然的最大带宽优化**，不是我们做的，但必须守住：战斗逻辑在各端浏览器跑，服务端不广播快照。

对比（`b.snap` 24 单位实测）。**快照率现在是两档，按收件人身份分，不按链路质量分**
（2026-10-12 按盒子 `server/sim/constants.js` 核实）：**驱动该场地的球员 20 Hz**
（`SNAPSHOT_EVERY = 3`，2× 真实时间下 60 tick/s ÷ 3）、**只观看的旁观者 / 被淘汰队友 / 全 AI 场 5 Hz**
（`SNAPSHOT_EVERY_IDLE = 12`）。
所以下表两列分别是**球员**与**旁观者**，**不是**「安静 / 抖动」两档：

| | 单帧 | 球员 20 Hz | 10 Mbps 容纳 | 旁观 5 Hz | 10 Mbps 容纳 |
|---|---|---|---|---|---|
| 未压 | 1,058 B | 21,160 B/s = 0.169 Mbps | **59 人** | 5,290 B/s = 0.042 Mbps | **236 人** |
| deflate | 252 B | 5,040 B/s = 0.040 Mbps | **248 人** | 1,260 B/s = 0.010 Mbps | **992 人** |

> 口径：人均 B/s = 单帧 × 帧率，容纳 = ⌊1,250,000 ÷ 人均 B/s⌋。

> ⚠️ **2026-10-12 更正：自适应那一档已经取消。** 早期「默认 10 Hz（`SNAPSHOT_EVERY = 6`）、
> 链路抖动时逐连接升到 20 Hz（`SNAPSHOT_EVERY_FAST = 3`）」的两档制，在
> `server/sim/constants.js` 里已改成 `SNAPSHOT_EVERY_FAST = SNAPSHOT_EVERY`（两个值相等 = 没有第二档）。
> 20 Hz 本身已高于插值缓冲的成本底线（客户端 100 ms 插值缓冲已能覆盖到达抖动），
> 再按链路升档只会重复买到同一件事。
> 因此本表旧版的「10 Hz 默认 → 118 人 / 496 人」两列**已作废**，换成上表的球员 / 旁观两档。
> 同理，更早的"固定 30 Hz"口径（31,744 B/s → 39 / 160 人）**也只是历史压力算例，不是当前容量**。

压完是 **4.2 倍**，但**只要 `clientCombat` 退成 `off`，这两种都比默认路径贵 100 倍以上**。这是本轮唯一有数量级意义的风险点。

> 另注：这只算 `b.snap` 一种消息。同频的 `b.ev` 与 `m.field` 也占上行，**单帧 × 帧率 ≠ 完整 ws 流量**。

### 措施 6 — 背压与节流（已有）

- `snapDropBytes = 1 << 20`：`b.snap` 是唯一可丢帧（`isDroppable`），缓冲超 1 MiB 就跳过 —— 上行被堵时自动降载而不是堆积。
- `heartbeatMs = 30_000`：心跳 30 秒一次，双向约 1 B/s，可忽略。

---

## 四、10 Mbps 上行：优化前后最大容纳人数

**基准**：10 Mbps = 1,250,000 B/s = 1.192 MiB/s（假设可满速占满，实际留 20% 余量更稳）。

### 表 A — 首次进场（一次性，决定「新玩家进来有多痛」）

| | 人均上行 | 10 Mbps 下耗时 | 满速每秒接纳 |
|---|---|---|---|
| **优化前**（素材从盒子发） | 467.92 MiB | **392.5 s ≈ 6.5 分钟** | 0.003 人/s |
| **优化后**（素材走 CDN + gzip l6） | 1.48 MiB | **1.24 s** | 0.81 人/s |
| **复访**（`?v=` immutable） | **0 B** | 0 s | 无限 |
| **提速** | | | **316×** |

优化前是「一个玩家进来就把上行占死 6 分半，期间所有人都卡」—— 这不是并发数问题，是可用性问题。

### 表 B — 稳态（决定「能挂多少人」）

| 场景 | 人均上行 | 人均速率 | 10 Mbps 最大容纳 | 说明 |
|---|---|---|---|---|
| **A. 大厅 / 待机** | ≈40 B/s | ≈320 bps | **31,250 人** | `lobby.list` gz 161 B / 5 s + 心跳 + 偶发聊天 |
> ⚠️ **2026-10-09 用线上日志复核后修正**：上表 B 行（60 B/s）是**建模值**，线上实测是**双峰分布**——
> p50 = 15.2 B/s（与建模一致），但 **p90 = 1,352.7 B/s、p99 = 3,374.4 B/s**；
> **长连接（`rt>5s`，n=1,503）中按速率排前 10% 的那 151 条，占全部 ws 上行的 90.5%**（618.2 / 682.8 MiB）。
> 所以「2 万人」只对中位数成立；**按 p90 算，10 Mbps 实际容纳约 900 人**。
> 详见 §八。
> <br />口径：分母是**全部 `/ws` 请求的上行字节**（682.8 MiB，其中长连接占 682.7 MiB），分位取自同一集合。
> 早期版本并列的 97.9% 与 88.8% 是**两套不同分母**，已统一为上面这一个。
| C. 对局中（服务端模拟，**未压**） | 21,160 B/s | 169 kbps | **59 人** | `SP_COMBAT=server` / AI 接管，球员档 **20 Hz**（`SNAPSHOT_EVERY = 3`） |
| D. 对局中（服务端模拟，**deflate**） | 5,040 B/s | 40 kbps | **248 人** | 同上，开启压缩 |
| C′ / D′. 同上，但收件人是**旁观者** | 5,290 / 1,260 B/s | 42 / 10 kbps | **236 / 约 990 人** | 旁观档 **5 Hz**（`SNAPSHOT_EVERY_IDLE = 12`） |

**读法**：A / B 的数字是「上行先被打满的人数」。A 行（大厅 ~40 B/s）大到没有意义 —— 现实中会先撞 CPU、每进程 fd 上限、`maxConnections`。
上表的 2 万人（A 行）只用来说明大厅态余量有多大，**不等于对局态容量**（B 行才是对局态）。
⚠️ 早先在 B 行写的「对局中实测人均 2,048 B/s、10 Mbps 只够 ~610 人、开压缩后 ~2,475 人」**已作废**（机器人座位样本），
现行对局态口径是 **57.5 B/s / ≈21,000 人**，见 [§九](#九稳态口径本节点名的旧数字全部作废2026-10-12)。

**C → D 的 59 → 248 人是措施 4（战斗帧压缩）的真实价值（约 4.2×）**，但它只在非默认路径（服务端跑战斗 / AI 接管）上成立。
C/D 两行按**盒子源码现行**快照率算：**球员 20 Hz**（`SNAPSHOT_EVERY = 3`）、**旁观者 5 Hz**（`SNAPSHOT_EVERY_IDLE = 12`），
两档按**收件人身份**分，**没有**按链路质量的自适应档（`SNAPSHOT_EVERY_FAST` 已等于 `SNAPSHOT_EVERY`，详见 §三 措施 5 的更正）。
口径：人均 B/s = 单帧 × 帧率，容纳 = ⌊1,250,000 ÷ 人均 B/s⌋ ——
未压 1,058 × 20 = 21,160 → 59 人；deflate 252 × 20 = 5,040 → 248 人；
旁观档 1,058 × 5 = 5,290 → 236 人、252 × 5 = 1,260 → 约 990 人。
早期版本的 30 Hz 口径（31,744 B/s → 39 / 160 人）、「10 Hz 默认 + 抖动升 20 Hz」口径（10,580 B/s → 118 人）
与「15 Hz 基准」口径（15,870 B/s → 78 人）**都只是历史压力算例，不是当前容量**。
且这只算 `b.snap` 一种消息 —— 同频的 `b.ev`、`m.field` 也占上行，**单帧 × 帧率 ≠ 完整 ws 流量**。

### 结论

> 优化前，10 Mbps 上行的实际容量是 **1~2 个新玩家排队进场**（素材占死）；
> 优化后，首载吞吐 **0.81 人/s** 且复访为 **0**（首载部分彻底解决）。
> **稳态**（对局中）现行实测是 **57.5 B/s/席 → ≈21,000 人**；真正的约束是**冷启动 5.4 MB 客户端代码**
> （1,573 B/s，比稳态贵 27×），见 [§九](#九稳态口径本节点名的旧数字全部作废2026-10-12)
> 与 [`ws-link-compression.md`](./ws-link-compression.md)。

---

## 五、已评估但否决的方案

| 方案 | 实测结论 | 为何不采用 |
|---|---|---|
| **brotli 静态压缩** | 再省 295 KiB（1.475 → 1.187 MiB，−19.5%），但压缩耗时 **92,138 ms vs 2,083 ms = 44.2×** | 一次性收益 20%，代价是构建慢 44 倍 + 全站缓存策略改动。**用户已决定保持 gzip l6** |
| **把 5 MB 代码挂 git 镜像源**（jsDelivr / Statically / ghfast） | `public/vendor/` 在 `.gitignore` 第 6 行，`git ls-files public/vendor/` = **0** —— 54% 的载荷根本不在 git 里；且所有 raw 类镜像返回 `text/plain` + `nosniff`，ES module 直接被浏览器拒绝 | 一票否决：源不存在 + MIME 致命 |
| **走 CF 隧道承载静态资源** | 隧道只中继连接，**字节仍从盒子网卡出去**，上行瓶颈原地不动 | 不解决目标问题 |

### 已从「否决」改判的东西：上下文接管（context takeover）

> ⚠️ **2026-10-12 改判。** 这一条原本在上表里，理由是「内存上界不可控、内存测量三次结果互相矛盾，
> 本轮不下结论」。**那次测量连同当时的收益数字（4.1% vs 24.6%）都属于已被作废的那轮口径。**
>
> 现行 `on` 档**故意不声明** `serverNoContextTakeover` —— 即**保留上下文接管**，并重测到
> `m.private` 4.07× → **43.55×**。所以它现在是**线上在用**的配置，不再是「否决项」。
> 参数现状与两个「故意不声明」项见 [《WS 链路压缩（当前已上线）》](./ws-link-compression.md) §三。

---

## 六、验收命令

```bash
# 1. 素材确已离场（应全部指向 CDN，无 /assets/ 相对路径）
curl -s https://weishu.jiangjiangze.icu/data/assets.json | grep -o '"https://[^"]*weishucdn[^"]*"' | wc -l

# 2. 首载代码确带版本号（应见 ?v=<hash>）
curl -sI https://weishu.jiangjiangze.icu/ | head -1
curl -s  https://weishu.jiangjiangze.icu/ | grep -o 'js/[a-z.]*js?v=[a-f0-9]*' | head -3

# 3. 带版本的资源走 immutable（关键指标）
curl -sI "https://weishu.jiangjiangze.icu/js/main.js?v=$(curl -s https://weishu.jiangjiangze.icu/healthz | grep -o '"build":"[^"]*"' | cut -d'"' -f4)" \
  | grep -i cache-control        # 期望 max-age=31536000, immutable
```

---

## 七、2026-10-09 线上复核：稳态是双峰，不是单值

> 📌 **本节及 7.1.1 / 7.1.2 / §八 是 2026-10-09～10 那一轮的历史记录，快照率部分已被后续改动覆盖。**
> 当时把 `SNAPSHOT_EVERY` 从 3 改成 6（20 Hz → 10 Hz）并加了「链路抖动逐连接升 20 Hz」的自适应档；
> 2026-10-12 按盒子 `server/sim/constants.js` 核实，**现在又是 `SNAPSHOT_EVERY = 3`（球员 20 Hz）**，
> 并新增 `SNAPSHOT_EVERY_IDLE = 12`（旁观者 5 Hz），**自适应档已取消**
> （`SNAPSHOT_EVERY_FAST = SNAPSHOT_EVERY`）。现行口径见 §三 措施 5 的更正与
> [`ws-link-compression.md`](./ws-link-compression.md) §一。
> 下面保留是因为**双峰分布的观测方法、p90 由少数长连接决定这个教训仍然成立**，
> 不是因为那些容量数字还成立。

数据源：盒子 `D:\stronghold\nginx\logs\stronghold.access.log`，约 6.1 万条请求，跨 5 天
（`04 Oct 17:00 → 09 Oct 16:42`；`bytes=$body_bytes_sent` 是 **gzip 之后**的字节，可当上行直接读）。

### 7.1 ws 速率分位（`rt>5s` 的连接，n=1,503）

| 分位 | B/s | 10 Mbps 容纳 |
|---|---|---|
| **p50** | **15.2** | 82,237 人 |
| p75 | 97.4 | 12,834 人 |
| **p90** | **1,352.7** | **924 人** |
| p99 | 3,374.4 | 370 人 |

**长连接中按速率排前 10% 的那 151 条，占全部 ws 上行的 90.5%**（618.2 / 682.8 MiB）。
口径：分母是**全部 `/ws` 请求的上行字节**（682.8 MiB，其中长连接占 682.7 MiB），分位取自同一集合；
早期版本并列的 97.9% 与 88.8% 是两套不同分母，已统一为这一个。

> 🔗 **与 §九 的桥梁（2026-10-12 补，别把两组数字当成互相打脸）。**
> 本节的 p90 = **1,352.7 B/s → 约 900 人**，与 §九 的 **57.5 B/s → 约 21,000 人** 相差 23×。
> 两者不冲突，差在三件事，读完再引用任何一个：
>
> 1. **采集窗口早于修复**。本节数据取自 `04 Oct → 09 Oct` 的 nginx 日志，而上面 §7.1.1 末尾那张
>    P0 表（快照率 20 Hz→10 Hz、`SP_WS_COMPRESSION=on`）的两项都标注为「✅ 已落地」。
>    所以这组分位数是**修复前的基线**，不是今天的吞吐。
> 2. **口径不同**。这里算的是**每条连接的平均速率再取分位**，样本里混着大量 45 分钟 ~ 3 小时的超长连接；
>    §九 的 57.5 B/s 是**整局逐字节（人类座位真实会话）**的均值，两者不可互换。
> 3. **它仍然有用**：p90/p99 说明的是**头部用户吃掉了 90.5% 的上行**（151 / 1,503 条），
>    即容量从来由少数长连接决定，而不是由中位数决定。这个**教训保留**，连同 §7.1.1 的 20 Hz 根因。
>    ⚠️ 只是其中的 2,048 / 505 B/s 与「98% 是 `m.public`」已被整局实测推翻，见 [§九](#九稳态口径本节点名的旧数字全部作废2026-10-12)。

### 7.1.1 根因已查明：服务端跑的战斗场以 20 Hz 推 `b.snap`

`server/match/fields.js`：`INTERVAL_MS = 1000/30`、`GAME_SPEED = 2`
→ **每真实秒 60 tick**（不是 30），`SNAPSHOT_EVERY = 3` 时 `_emit` 频率 = **60 / 3 = 20 帧/秒**，
`b.ev` 与 `b.snap` 同频。（源码注释原即写着 "20 Hz at 2× real time"，早期按 30 tick/s 推算的 10 Hz 是错的。）

四类真实战斗的实测字节（单帧 gzip l6，取自 `public/dev/perf`）：

| kind | 单位数 | 单帧 gz | 20 Hz | 10 Hz |
|---|---|---|---|---|
| normal | ~8 | 303 B | 6,052 B/s | 3,013 B/s |
| unite | ~16 | 450 B | 9,006 B/s | 4,505 B/s |
| boss | ~12 | 403 B | 8,053 B/s | 4,020 B/s |
| hidden | ~12 | 404 B | 8,084 B/s | 4,034 B/s |

**实测 p90 区间 1,387 ~ 3,300 B/s，完整落在 20 Hz 列的同量级。**
长连接中按速率排前 10% 的那 151 条占 ws 总上行 **90.5%（618.2 / 682.8 MiB）**，全是 45 分钟 ~ 3 小时的超长连接。
（早期版本此处写 88.8%（600.1 / 675.7 MiB），与 §7.1 的 97.9% 是两套不同分母；现已统一为同一口径的 90.5%。）

**为什么默认 `clientCombat` 没保护住**：它只让**普通战斗场**不流式。
但 ① 玩家离开 → `server takeover`（线上 96 次，两个玩家反复触发）；
② Final Assault / 联防阶段设计上就要服务端参与。这两类场有 watcher 就发快照。

| 优先级 | 做法 | 预期 | 状态 |
|---|---|---|---|
| **P0** | `SNAPSHOT_EVERY` 3 → 6（20 Hz → 10 Hz） | 流式上行**减半** | ✅ 已落地 |
| **P0** | 开 `SP_WS_COMPRESSION=on`（**线上默认 off**） | 约 4× | ✅ 已落地（3001 槽已生效） |
| **P0** | 抖动链路逐连接退回 20 Hz（两套配置并存，服务端自判） | 抖动链路的画质 | ✅ 已落地，见 §7.1.2 |
| P1 | `unitePhase.js:27` 补 `emit: false`（照抄 bossRounds 写法） | 联防不再流式 | 待做 |
| P1 | takeover 后无 watcher 则停推 | 消除「人走了还在推」 | 待做 |
| P2 | 快照只发变化单位（delta） | 只传动过/变过的单位 | 待做 |

**P0 已实测验证**（2026-10-09，`public/dev/perf` 四类 spec 跑真实 `Battle`）：

- 降帧**精确减半**上行：实测 49.8% ~ 50.0%，因为单帧 gzip 后字节几乎不变（99.6% ~ 100.1%）——
  **帧变稀但每帧没有变大**，不是「少发几次但每次更重」。
- 客户端插值**不退化**：10 Hz 下相邻快照的最大单位位移，normal 0.841 / unite 0.446 / boss 0.576 格，
  远低于 `render/interp.js` 的 2.5 格瞬移阈值；hidden 那一例 4.472 格跳变**在 20 Hz 时同样存在**
  （两种帧率数值完全相同），属于该技能自身的位移，与降帧无关。
- `SP_WS_COMPRESSION=on` 端到端握手确认：
  `permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=9`（有界，非默认 15 窗口）。

### 7.1.2 10 Hz 什么时候真的会难看：是链路抖动，不是位移

先把一个反直觉的结论摆前面：**降帧不会让单位「跳」**。同一批 spec 上量相邻快照的单位位移，
normal / unite / boss 的 p99 只有 0.15 ~ 0.44 格，远低于 `render/interp.js` 的 2.5 格瞬移阈值；
唯一超标的 4.472 格是**技能瞬移**，20 Hz 下数值完全相同。所以"10 Hz 明显有问题"这件事，
在位移维度上根本不成立。

真正的机制在客户端的插值缓冲上：`interp.js` 让渲染时钟落后最新快照 `delay` = **100 ms**，
而 10 Hz 的帧间隔**正好也是 100 ms** —— **余量为零**。任何到达抖动都会让渲染时钟跑过最新快照、
只能靠外推（画面靠猜），超过 `maxExtrapolate`（120 ms）就直接冻结。20 Hz 把间隔减半，
同一段缓冲就容得下两帧，抖动被吸收。

拿**真实的 `interp.js`**（`delay=0.1`、`maxExtrapolate=0.12`、`rate=2`，正是流式战斗的实参）
喂带抖动的到达时刻，驱动 60 fps 渲染，统计"渲染时钟已跑过最新快照"的帧占比：

| 链路抖动 | 10 Hz 外推帧 | 20 Hz 外推帧 |
|---|---|---|
| ≤ 20 ms | 0.0% | 0.0% |
| 30 ms | 0.1% | 0.0% |
| 50 ms | **1.5%** | 0.2% |
| 75 ms | **4.2%** | 0.6% |
| 150 ms | 11.2% | 3.6% |

**所以判据是链路抖动**（阈值取 50 ms，正好是 10 Hz 间隔的一半 —— 缓冲装不下这么多）。

**实现**（`SP_SNAP_RATE=auto`，默认）：

- `server/net.js`：对**两类** socket 做 ws ping/pong 探测（2 s 一次）——
  ① **正在被推流**的（最近发过 `b.snap`）；② **坐在房间里**的（准备阶段就积累样本，
  开战第一帧就有判据）。**其余一律不探**，大厅挂机连接不花上行。
  样本进每 socket 的 RTT 环。浏览器按 RFC 6455 自动回 pong —— **不用改客户端、不用改协议**，
  老版本客户端一样有效。心跳那个无载荷 ping 不计入样本。
- `server/match/snapRate.js`：判据 = RTT 的**相邻差均值**（mean |ΔRTT|），
  实测本机到线上约 56 ms。滞后：≥50 ms 升、≤20 ms 降、中间保持；换档要过 5 s 驻留。
- `server/match/match/snapRate.js` + `server/match/fields.js`：**速率按连接，不按场** ——
  某个 watcher 抖动就把**它那一场**提到 20 Hz，安静的连接仍拿 10 Hz。
  一个抖动的人不该让同场其他人也翻倍。
- **两个刹车**：socket 已在排队（`bufferedAmount` ≥ 32 KB）**一律不升级** ——
  加帧只会加深积压；`SP_SNAP_RATE=slow|fast` 可把两套配置任选一套钉死。
- **跳帧不丢事件**：`drainEvents()` 是破坏性的，被跳过那帧的事件按 watcher 暂存、
  随它下一帧一起送达（实测：慢速 watcher 最终收到快速 watcher 收到的每一个事件）。

代价与边界（诚实说明）：每 2 s 一个 ws ping，约几十字节，只对正在推流的连接发；
判定用的是**往返**抖动，而客户端关心的是**单向**（服务端→客户端）抖动，两者相关但不完全等价；
阈值 50 ms 来自上面那张表，`SP_SNAP_JITTER_MS` 可调。升级只在确有抖动时发生，
安静链路仍是 10 Hz，所以带宽收益基本保留。

> 明细见 `C:\DDDD\Agent Work\tunnel-optimize\p90根因.md`。
> 线上部署状态：改动已落盘到两个槽脚本 `update/sp_slot_300{1,2}.cmd`，下一次槽重启即生效。
> ⚠️ 另有两处**与此改动无关**的线上隐患见 §7.6。

### 7.2 逐小时实际上行

| 时刻 | 请求数 | 上行 | 均速 |
|---|---|---|---|
| 05:40 | 6 | 0.015 MiB | 4 B/s |
| 06:40 | 133 | 0.926 MiB | 270 B/s |
| 07:40 | 18 | 0.025 MiB | 7 B/s |
| 08:40 | 1635 | 10.166 MiB | 2,961 B/s |
| 09:40 | 144 | **20.444 MiB** | **5,955 B/s** |
| 10:40 | 1020 | 6.919 MiB | 2,015 B/s |

09:40 那一小时 144 个请求发了 20.4 MiB —— **是少数大响应，不是高频小请求**。

### 7.3 当前最大的可修泄漏：`/data/*.json` 一律 `no-cache`

| 资源 | 原始 | gzip l6 | 线上 |
|---|---|---|---|
| `chess.json` | 1.63 MiB | **0.147 MiB（9%）** | 150 KiB，`no-cache`/DYNAMIC，**每次回源** |
| `backups.json` | 1.80 MiB | 0.136 MiB | 同上 |
| `assets.json` | 1.06 MiB | 0.091 MiB | 同上 |

三者每次合计重发约 **0.37 MiB**（已压）。`files.js:190/193` 对 `.html`/`.json` 一律返回 `no-cache`。
→ 用 `?v=` 或强 ETag 校验即可消掉，是**当前性价比最高的单点**。属代码改动，待主仓冲突解决后做。

### 7.4 BGM 已完全离场（好消息）

日志里 `/media/bgm/*` 累计占比很大（单条 255 MiB），但那是 **R2 上传之前的历史**。
现在实测 `X-Asset-Source: r2` + `X-Served-By: stronghold-assets-worker`，
最近 1 小时 `/media/` 上行 **0.00 MiB**。

### 7.5 那 5 MB 实际只剩 2.51 MiB 在隧道上

`vendor/`（2.82 MiB，占 54%）已被 Worker 路由接管走 R2，实测 `X-Asset-Source: edge` + `HIT`。
真正在隧道上的只有 `js`(1.89) + `css`(0.33) + `i18n`(0.29) = **2.51 MiB**（gzip 后约 0.85 MiB）。

---

### 7.6 顺带发现的两个线上隐患（与本轮改动无关，待修）

1. **nginx `reload` 已失效**：`error.log` 里每次 reload 都是
   `OpenEvent("Global\ngx_reload_11512") failed (5: Access is denied)` —— 主进程 11512 起于 2026-10-04，
   跨会话后 SSH 侧无权发信号。**后果：磁盘上的 `sp_current.conf` 改动加载不进去**，
   nginx 会一直转发给它启动时读到的那个上游。改 conf 前必须先确认 nginx 进程真的重载了。
2. **nginx 静态 root/alias 指向不存在的目录**：`root D:/stronghold/Stronghold-Protocol/public` 与
   `/media/` 的 `alias` 都指向旧目录（实际是 `Stronghold-Protocol-cdn`），两条 `try_files`
   必然落到 `@sp`。目前无功能影响（素材走 weishucdn CDN），但属于悬错配置。

---

## 八、改动清单

| 文件 | 改动 | 状态 |
|---|---|---|
| `server/match/snapRate.js` | **新增**：自适应快照率策略（纯逻辑，可单测） | ✅ 已加 |
| `server/match/match/snapRate.js` | **新增**：接到每场（哪个 watcher 快、这场该按什么间隔发） | ✅ 已加 |
| `server/match/Match.js` | 装配策略；`opts.snapRate` / `SP_SNAP_RATE`、`opts.linkOf`、`SP_SNAP_JITTER_MS` | ✅ 已改 |
| `server/match/fields.js` | `_emit` 按 watcher 的档位投递；跳帧的事件按 watcher 暂存 | ✅ 已改 |
| `server/net.js` | 被推流 socket 的 ws ping/pong 链路探测（`linkProbeMs` 默认 2 s）+ `linkQualityOf()` | ✅ 已改 |
| `server/lobby.js` | 把 `linkOf(playerId)` 注入 Match（session.ws → 链路样本） | ✅ 已改 |
| `server/http/config.js` | `NET_OPTION_KEYS` 加 `linkProbeMs`/`linkWarmMs` | ✅ 已改 |
| `test/match/snap-rate.test.js` | **新增** 19 项（策略表 + 接线实测：抖动 20 Hz / 安静 10 Hz / 慢速 watcher 不丢事件） | ✅ 19/19 pass |
| `server/sim/constants.js` | `SNAPSHOT_EVERY` 3 → 6（20 Hz → 10 Hz）+ 新增 `SNAPSHOT_EVERY_FAST` | ⚠️ **已被后续改动覆盖**：盒子上现在又是 `SNAPSHOT_EVERY = 3`（球员 20 Hz）+ `SNAPSHOT_EVERY_IDLE = 12`（旁观 5 Hz），`SNAPSHOT_EVERY_FAST` 已等于 `SNAPSHOT_EVERY`（自适应取消），见 §七 的说明 |
| `test/match/combat.test.js` | 帧率断言改为从 `TICK`/`GAME_SPEED`/`SNAPSHOT_EVERY` 派生 | ✅ 7/7 pass |
| `update/sp_slot_3001.cmd`（盒） | 加 `set SP_WS_COMPRESSION=on` | ✅ 已落盘，已重启生效 |
| `update/sp_slot_3002.cmd`（盒） | 同上 | ✅ 已落盘，待该槽下次重启 |
| `server/wsCompression.js` | `serverMaxWindowBits` 12 → 9 → 12 → **不再声明** | ⛔ **已作废**：追这部参数史没有意义，见 [§九](#九稳态口径本节点名的旧数字全部作废2026-10-12) |
| `test/ws-compression.test.js` | 跟着改窗口断言（9 → 12 → 不声明） | ⛔ **同上已作废** |
| `server/http/static.js` | 新增 `versionIndexHtml()` + `serveVersionedIndex()`，接线 `index.html` | ✅ 已改 |
| `test/index-version.test.js` | 新增 4 项（25/25 覆盖、幂等、线上 buildTag 一致、immutable 分支） | ✅ 4/4 pass |
| `server/http/files.js` | 仅注释：说明 `js`/`css` 为什么不进 `LONG_CACHE_DIRS` | ✅ 已改 |
| `CHANGELOG.md` | 「未发布 → 带宽」两条 | ✅ 已改 |
| `SP_ASSET_CDN` 部署 | **无需改动**，线上已生效 | ✅ 已核验 |

**验证口径**：`SNAPSHOT_EVERY` 改动拿 `public/dev/perf` 四类真实 spec 跑 `Battle`，
逐帧比较「每 3 tick 采样」与「每 6 tick 采样」—— 上行 49.8%~50.0%，单位位移最大 0.841 格（阈值 2.5）。
`SP_WS_COMPRESSION=on` 拿真实进程做 ws 握手，确认协商出有界 `permessage-deflate`
（现行判据与 Node 片段见 `ws-link-compression.md` §八）。
自适应快照率拿**真实 `interp.js`** 喂抖动到达时刻定阈值（§7.1.2 的表），
再用 `test/match/snap-rate.test.js` 在真实 match 上实测「抖动连接 20 Hz、安静连接 10 Hz、慢速 watcher 事件不丢」。

**回归基线**：全量测试 5849 项中 8 项失败，全部是「缺美术素材」相关
（`assets.json` / Spine / atlas / 语言包的本地文件缺失）与 1 项 perf 抖动；
**用 `git stash` 对照跑同一批文件，基线同样失败**，与本轮改动无关（盒子上跑的本来就是无素材版）。

---

## 九、稳态口径：本节点名的旧数字全部作废（2026-10-12）

> ⛔ **本节不再承载 WS 稳态容量。** 它原先写的「98% 是 `m.public`」「2,048 → 505 B/s」「610 → 2,475 人」
> 已于 2026-10-12 被整局实测推翻，相关正文已从本文件移除，以免被当成事实继续引用。
> **现行口径只有一份**，见 [`ws-link-compression.md`](./ws-link-compression.md)。

### 为什么那组数字不能用

1. **样本本身是残缺的**：那次测量跑在**机器人座位**上。`messaging.js` 的 `sendTo()` 首行就
   `if (!ps || ps.isBot || ps.left) return false` —— 机器人收不到任何单播，所以 `m.private` 与
   `b.start` **根本不在样本里**。「98% 是 `m.public`」是在一个只剩 `m.public` 的集合里算出来的百分比。
2. **那套参数线上没在跑**：对公网 WS 做真实 Upgrade 握手，服务端回的是
   `permessage-deflate; client_no_context_takeover` —— 既没有 `server_no_context_takeover`、
   也没有 `server_max_window_bits=12`。所以「阈值 512 / 关上下文接管 / 窗口 pin 12」是旧配置，
   不是今天的线上配置。

### 现行数字（整局逐字节实测，人类座位 + AI 托管）

| | 值 |
|---|---|
| 每席位稳态 | **57.5 B/s**（压 `b.start` 前 105 B/s，A/B 实测 125.3 → 57.5 B/s，−54.1%） |
| 10 Mbps 容纳 | **≈21,000 人**（留 20% 余量约 17,000） |
| 构成 | `b.start` **69%** / `m.private` 22% / `m.public` **只剩 3%** |
| 真瓶颈 | **冷启动 5.4 MB** 客户端代码 = **1,573 B/s**，比稳态贵 **27×** |

省带宽的优先级因此重排为：① 把客户端静态交给 CDN（现在盒子自己发、CF 实测 `MISS`）
→ ② `b.start` 进白名单（已做）→ ③ 隐藏标签页停推 → ④ 才轮到改拉模式。

### 继续读哪一份

- 今天在跑的配置（三档 `off/on/safe`、两个「故意不声明」的参数、白名单 + `b.start`、广播漏压的真 bug）：
  [`ws-link-compression.md`](./ws-link-compression.md)
- 待执行的三步与各自的准入条件、验收判据、退路：
  [`ws-link-compression-next.md`](./ws-link-compression-next.md)
- 零依赖库与工坊兼容包（MIT · 28 项测试）：[`ws-compression-library-and-pack.md`](./ws-compression-library-and-pack.md)

## 十、把「整场不变的字段」请出热帧（2026-10-10，re-apk 线 / PR #157）

> ⚠️ **2026-10-12 更正本节的前提。** 原文依据「`m.public` 是唯一的大头」与「permessage-deflate
> 用的是 `serverNoContextTakeover`（每帧独立压）」，这两条**都已不成立**：
> - 整局实测里 `m.public` 只占 **3%**（`b.start` 69% / `m.private` 22%，见 §九）；
> - 线上 `on` 档**故意不声明** `serverNoContextTakeover`，即**保留上下文接管**
>   （`m.private` 实测 4.07× → 43.55×，见 `ws-link-compression.md` §三）。
>
> 所以本节要从「主战场」下调为**一步边际优化**。下面的收益数字仍然成立，
> 但它的量级应按新的占比理解，不要按旧前提去外推。

它内部有一批**开局即定、之后不再变**的字段（`lastRound` / `modeId` /
`difficulty` / `stageId` / `factions` / `disabledBonds` / `drawnDisabledBonds` / `bannedChess` / `bossId` /
`hiddenBossId`）—— 把它们从热帧里请出去，是热帧去常量那一步的具体落点。

### 10.1 实测

| | 每帧 |
|---|---|
| 完整帧（基线） | **5,653 B**（带 `full: true`） |
| 紧凑帧（热帧） | **4,799 B** |
| **每帧省** | **15.1%** |

五个 case 实测这些字段 distinct 全为 1（coop NORMAL/HARD/ABYSS、solo、协同共竞变体）。

### 10.2 怎么搬：基线 + 合并（**重连是重中之重**）

- 热帧变**紧凑帧**（`views.js publicView({full:false})`），常量只在**基线**（`full: true`）里走一次。
- `start()`：在阶段推进之后、flush 之前，给每个**在线真人席位**发一份基线 —— 保证任何紧凑帧之前客户端手里已有常量。
- `_resync()`：加入 / **重连** / 观战席中途加入本来就发完整视图，现在带 `full: true`。
- 客户端 **`main.js` 从「整份替换」改为「合并」**：见 `full: true` 就**丢弃镜像**重来，否则合并 ——
  紧凑帧再也擦不掉基线给的常量。
- **结算屏重放**保留完整帧（`ctx.lastPublicFull`），否则重连后会被重放一帧没有 `difficulty` 的视图。

### 10.3 兜底（照抄快照率那套的六要素）

| 快照率（§7.1.2）的要素 | 本文的对应物 |
|---|---|
| `SP_SNAP_RATE=auto/slow/fast` pin | 能力位（**每 socket**，`hello.pub`） |
| 每连接决策 | 每 socket 的 `pubCap`，**每次 hello 重新求值** |
| 守恒守卫（慢 tick ⊂ 快 tick） | **基线一定先到**：`start()` 与 `_resync()` 都发 |
| 无链路源 → plain 10 Hz | **未声明能力 → 一律发完整帧**（老客户端 / 第三方 / 部署前打开的旧 JS） |

**`hello.version` 仍强校验**（`server/net.js`），所以能力位是**新增的可选字段**，不是版本号。

### 10.4 还没做（按顺序）

1. **`players[].bonds` 按收件人定制**（只发"屏幕上"那 1~2 个球员，其余剥掉）：单独一项约再省 **24% wire**；
   需要服务端按收件人出帧 + 点开非屏幕玩家时走一次 `g.bonds` 按需请求。
2. **delta**（只发变化字段）：在裁剪之上再约 **1.24×**（建模合计 1.65× × 1.24× = **2.05×**；
   与 `bandwidth.html` 里那个「③+④ 合计 deflate 2.98× / raw 6.05×」不是同一个量 ——
   后者是整局逐字节**实测**的 deflate 压缩比，前者只是「裁剪 × delta」两项建模相乘，别互相替代）。
3. 上游 **PR #91** 的只读状态接口（给外部观察者，**不动**对局内广播）。


