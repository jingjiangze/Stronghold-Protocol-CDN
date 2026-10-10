# WS 压缩与上行带宽最大化

> 目标：在小上行带宽（以 **10 Mbps** 为算例）的家用盒子上一台服务器能带更多人。
> 全部数字来自本机工作树实测（`C:\Users\16891\android-build\master-play`）与线上探测，不是估算值。
> 日期：2026-10-10（WS 链路压缩部分另见 `ws-link-compression.md` / `ws-link-compression-next.md`）

---

## 一、结论先行

两件事分开看：**首载**是「新玩家第一次进场吃掉几百 MiB」，**稳态**是「一个席位对局中持续的上行」。
首载靠把素材挪走解决；**稳态实测人均 2,048 B/s，几乎全是 `m.public`**（早前那句「只要 60 B/s」漏了它）。
压掉它之后人均降到 **505 B/s**，10 Mbps 从 610 人抬到 **2,475 人**。

| | 稳态（对局进行中，默认配置） | 首次进场（新玩家第一次连进来） |
|---|---|---|
| 优化前人均上行 | ≈2,048 B/s | **467.9 MiB** |
| 优化后人均上行 | **≈505 B/s**（压缩后） | **1.48 MiB** |
| 10 Mbps 下 | **610 人 → 2,475 人** | 从「1 人 6.5 分钟」变「1 人 1.2 秒」 |

也就是说：**首载靠「不让你盒子发字节」（搬素材）解决，稳态靠「把 `m.public` 压小」解决**，两块都要做。
本轮 90% 的首载收益来自搬素材（几百倍），稳态 4× 收益来自 WS 链路压缩（见 §九）。

> ⚠️ **2026-10-10 修正**：上一版把「稳态 ≈60 B/s」当建模值、得出「上行不是稳态瓶颈」—— 实测稳态是
> **≈2,048 B/s/人**（差 30 倍，根因是漏了占 98% 的 `m.public`），所以「上行不是稳态瓶颈」这句**不成立**：
> 默认配置下 10 Mbps 稳态只够 **~610 人**。WS 链路压缩（白名单 + 窗口 12、广播漏压的真 bug）把容量抬到 **~2,475 人**，
> 修正过程与 10 Mbps × 2000 的审计见 **§九**。

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

### 措施 4 — permessage-deflate `serverMaxWindowBits` 12 → 9 → **回到 12**（2026-10-10）

`server/wsCompression.js`：

```js
serverMaxWindowBits: 12,         // 4 KiB 滑动窗口（本轮定稿）
serverNoContextTakeover: true,   // 保内存上界
clientNoContextTakeover: true,
threshold: 512,                  // 小帧不压
concurrencyLimit: 8,
zlibDeflateOptions: { level: 6, memLevel: 5 },
```

- 上一轮把它从 12 调到 9（小窗口用更便宜的距离码，对 ~250 B 的战斗帧实测**反而更省**：35.8% vs 36.5%）。
- **2026-10-10 调回 12**：因为真正的大头是 `m.public`（~4.6 KB），512 B 窗口够不到它重复的羁绊 / 状态块 ——
  实测 **wb9 = 3.36×、wb12 = 4.94×**（见 §9.3）。
- ⚠️ **这个功能默认 `off`**：只有 `SP_WS_COMPRESSION=on` 时才压。默认路径（`clientCombat=on`）不发 `b.snap`，
  但 `m.public` **每次都发** —— 所以它现在才是这个开关的主战场（见 §九）。

### 措施 5 — `clientCombat: on`（别退回去）

这是**天然的最大带宽优化**，不是我们做的，但必须守住：战斗逻辑在各端浏览器跑，服务端不广播快照。

对比（`b.snap` 24 单位实测）。**快照率现在是两档并存**：默认 **15 Hz**（`SNAPSHOT_EVERY = 4`，60 tick/s ÷ 4），
链路抖动时**按 watcher（每条连接）**自适应升到 **20 Hz**（`SNAPSHOT_EVERY_FAST = 3`）。
两档由每个 watcher 自己的流逝 tick 计数独立驱动，**互不嵌套**（4 与 3 不整除）。所以下表两档都列 ——
早期版本那个"固定 30 Hz"口径（31,744 B/s → 39 / 160 人）**只是历史压力算例，不是当前容量**：

| | 单帧 | 15 Hz（默认） | 10 Mbps 容纳 | 20 Hz（抖动链路） | 10 Mbps 容纳 |
|---|---|---|---|---|---|
| 未压 | 1,058 B | 15.5 KiB/s = 0.127 Mbps | **78 人** | 20.7 KiB/s = 0.169 Mbps | **59 人** |
| deflate w9 | 252 B | 3.7 KiB/s = 0.030 Mbps | **330 人** | 4.9 KiB/s = 0.040 Mbps | **248 人** |

口径：每秒字节 = 单帧 × 帧率，容纳 = ⌊1,250,000 ÷ 每秒字节⌋（1,058 × 15 = 15,870 → 78；252 × 15 = 3,780 → 330）。
相对旧 10 Hz 口径默认档恰好 ×1.5（+50%），只作用于 `b.snap`。压完是 **4.2 倍**，但**只要 `clientCombat` 退成 `off`，这两种都比默认路径贵 100 倍以上**。这是本轮唯一有数量级意义的风险点。

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
| C. 对局中（服务端模拟，**未压**） | 15,870 B/s | ≈127 kbps | **78 人** | `SP_COMBAT=server` / AI 接管，默认 **15 Hz**（`SNAPSHOT_EVERY = 4`） |
| D. 对局中（服务端模拟，**deflate w9**） | 3,780 B/s | ≈30 kbps | **330 人** | 同上，开启压缩 |
| C′ / D′. 同上，链路抖动升到 **20 Hz** | 21,160 / 5,040 B/s | 169 / 40 kbps | **59 / 248 人** | 按 watcher 自适应升档（仅抖动链路；20 Hz 两格与单帧值均未变） |

**读法**：A / B 的数字是「上行先被打满的人数」。A 行（大厅 ~40 B/s）大到没有意义 —— 现实中会先撞 CPU、每进程 fd 上限、`maxConnections`。
但 **B 行（对局中）的稳态容量由 `m.public` 决定，不是 CPU**：实测人均 2,048 B/s，10 Mbps 只够 ~610 人（见 §九，开压缩后 ~2,475 人）。
上表的 2 万人（A 行）只用来说明大厅态余量有多大，**不等于对局态容量**。

**C → D 的 78 → 330 人是措施 4（战斗帧压缩）的真实价值（约 4.2×）**，但它只在非默认路径（服务端跑战斗 / AI 接管）上成立。
C/D 两行按**当前**快照率算：默认 **15 Hz**（`SNAPSHOT_EVERY = 4`），抖动链路按 watcher 升到 **20 Hz**（`SNAPSHOT_EVERY_FAST = 3`）。
口径：人均 B/s = 单帧 × 帧率，容纳 = ⌊1,250,000 ÷ 人均 B/s⌋（未压 1,058 × 15 = 15,870 → 78 人；w9 252 × 15 = 3,780 → 330 人）。
基准档 10 → 15 Hz 只影响 `b.snap`，服务端跑战斗这两行较旧口径恰好 ×1.5（+50%）。
早期版本的 30 Hz 口径（31,744 B/s → 39 / 160 人）**只是历史压力算例，不是当前容量**。
且这只算 `b.snap` 一种消息 —— 同频的 `b.ev`、`m.field` 也占上行，**单帧 × 帧率 ≠ 完整 ws 流量**。

### 结论

> 优化前，10 Mbps 上行的实际容量是 **1~2 个新玩家排队进场**（素材占死）；
> 优化后，首载吞吐 **0.81 人/s** 且复访为 **0**（首载部分彻底解决）。
> **稳态**（对局中）则是另一回事：默认配置下 10 Mbps 只够 **~610 人**，开了 `m.public` 压缩后 **~2,475 人**（见 §九），
> 离「CPU 决定（万级）」还差得远 —— 容量天花板在 WS 链路，不在硬件。

---

## 五、已评估但否决的方案

| 方案 | 实测结论 | 为何不采用 |
|---|---|---|
| **brotli 静态压缩** | 再省 295 KiB（1.475 → 1.187 MiB，−19.5%），但压缩耗时 **92,138 ms vs 2,083 ms = 44.2×** | 一次性收益 20%，代价是构建慢 44 倍 + 全站缓存策略改动。**用户已决定保持 gzip l6** |
| **上下文接管（context takeover）** | 实测 4.1% vs 24.6% —— 收益显著 | 内存上界不可控（每连接保留 LZ77 历史）。**内存测量三次结果互相矛盾，本轮不下结论**，要定需重测 |
| **把 5 MB 代码挂 git 镜像源**（jsDelivr / Statically / ghfast） | `public/vendor/` 在 `.gitignore` 第 6 行，`git ls-files public/vendor/` = **0** —— 54% 的载荷根本不在 git 里；且所有 raw 类镜像返回 `text/plain` + `nosniff`，ES module 直接被浏览器拒绝 | 一票否决：源不存在 + MIME 致命 |
| **走 CF 隧道承载静态资源** | 隧道只中继连接，**字节仍从盒子网卡出去**，上行瓶颈原地不动 | 不解决目标问题 |

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

> 口径说明：本节写于 2026-10-09，当时快照基准档是 **10 Hz**（动态 20 Hz）。后续一轮把基准档升到 **15 Hz**
> （`SNAPSHOT_EVERY = 4`，动态 20 Hz = `SNAPSHOT_EVERY_FAST = 3`），并改为**每个 watcher 独立计数**；
> 本节保留为当时的定档依据，文中"10 Hz"均指当时基准。

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

### 7.1.1 根因已查明：服务端跑的战斗场以 20 Hz 推 `b.snap`

`server/match/fields.js`：`INTERVAL_MS = 1000/30`、`GAME_SPEED = 2`
→ **每真实秒 60 tick**（不是 30），当时 `SNAPSHOT_EVERY = 3`（现名 `SNAPSHOT_EVERY_FAST`）时 `_emit` 频率 = **60 / 3 = 20 帧/秒**，
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

### 7.1.2 当时基准 10 Hz 什么时候真的会难看：是链路抖动，不是位移

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

**所以判据是链路抖动**（阈值取 50 ms，`SP_SNAP_JITTER_MS` 可调；该阈值定于基准 10 Hz 时期，推导见下表）。

**实现**（`SP_SNAP_RATE=auto`，默认）：

- `server/net.js`：对**两类** socket 做 ws ping/pong 探测（2 s 一次）——
  ① **正在被推流**的（最近发过 `b.snap`）；② **坐在房间里**的（准备阶段就积累样本，
  开战第一帧就有判据）。**其余一律不探**，大厅挂机连接不花上行。
  样本进每 socket 的 RTT 环。浏览器按 RFC 6455 自动回 pong —— **不用改客户端、不用改协议**，
  老版本客户端一样有效。心跳那个无载荷 ping 不计入样本。
- `server/match/snapRate.js`：判据 = RTT 的**相邻差均值**（mean |ΔRTT|），
  实测本机到线上约 56 ms。滞后：≥50 ms 升、≤20 ms 降、中间保持；换档要过 5 s 驻留。
- `server/match/match/snapRate.js` + `server/match/fields.js`：**速率按 watcher，不按场** ——
  每个 watcher 有自己的流逝 tick 计数；某个 watcher 抖动只把**它自己**提到 20 Hz，
  同场的安静 watcher 仍拿基准档（当时 10 Hz，现 15 Hz）。一个抖动的人不该让同场其他人也翻倍。
- **两个刹车**：socket 已在排队（`bufferedAmount` ≥ 32 KB）**一律不升级** ——
  加帧只会加深积压；`SP_SNAP_RATE=slow|fast` 可把两套配置任选一套钉死。
- **跳帧不丢事件**：`drainEvents()` 是破坏性的，被跳过那帧的事件按 watcher 暂存、
  随它下一帧一起送达（实测：慢速 watcher 最终收到快速 watcher 收到的每一个事件）。

代价与边界（诚实说明）：每 2 s 一个 ws ping，约几十字节，只对正在推流的连接发；
判定用的是**往返**抖动，而客户端关心的是**单向**（服务端→客户端）抖动，两者相关但不完全等价；
阈值 50 ms 来自上面那张表，`SP_SNAP_JITTER_MS` 可调。升级只在确有抖动时发生，
安静链路仍是基准档（当时 10 Hz，现 15 Hz），所以带宽收益基本保留。

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

> 口径说明：本清单是 2026-10-09 那一轮的改动记录（当时基准档 10 Hz）。其后一轮把基准档升到 **15 Hz**
> （`SNAPSHOT_EVERY = 4`）、动态档 20 Hz 保持（`SNAPSHOT_EVERY_FAST = 3`），并改为按 watcher 独立计数；
> 清单里的 `SNAPSHOT_EVERY 3 → 6` 是那一轮的事实，不是当前值。

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
| `server/sim/constants.js` | `SNAPSHOT_EVERY` 3 → 6（20 Hz → 10 Hz）+ 新增 `SNAPSHOT_EVERY_FAST` | ✅ 已改，已验证上行减半 |
| `test/match/combat.test.js` | 帧率断言改为从 `TICK`/`GAME_SPEED`/`SNAPSHOT_EVERY` 派生 | ✅ 7/7 pass |
| `update/sp_slot_3001.cmd`（盒） | 加 `set SP_WS_COMPRESSION=on` | ✅ 已落盘，已重启生效 |
| `update/sp_slot_3002.cmd`（盒） | 同上 | ✅ 已落盘，待该槽下次重启 |
| `server/wsCompression.js` | `serverMaxWindowBits` 12 → 9 | ✅ 已改，5/5 测试通过（**2026-10-10 又调回 12，见 §9.8**） |
| `test/ws-compression.test.js` | 同步断言为 9 | ✅ 5/5 pass（**同上，已改回 12**） |
| `server/http/static.js` | 新增 `versionIndexHtml()` + `serveVersionedIndex()`，接线 `index.html` | ✅ 已改 |
| `test/index-version.test.js` | 新增 4 项（25/25 覆盖、幂等、线上 buildTag 一致、immutable 分支） | ✅ 4/4 pass |
| `server/http/files.js` | 仅注释：说明 `js`/`css` 为什么不进 `LONG_CACHE_DIRS` | ✅ 已改 |
| `CHANGELOG.md` | 「未发布 → 带宽」两条 | ✅ 已改 |
| `SP_ASSET_CDN` 部署 | **无需改动**，线上已生效 | ✅ 已核验 |

**验证口径**：`SNAPSHOT_EVERY` 改动拿 `public/dev/perf` 四类真实 spec 跑 `Battle`，
逐帧比较「每 3 tick 采样」与「每 6 tick 采样」—— 上行 49.8%~50.0%，单位位移最大 0.841 格（阈值 2.5）。
`SP_WS_COMPRESSION=on` 拿真实进程做 ws 握手，确认协商出有界 `permessage-deflate`。
自适应快照率拿**真实 `interp.js`** 喂抖动到达时刻定阈值（§7.1.2 的表），
再用 `test/match/snap-rate.test.js` 在真实 match 上实测「抖动连接 20 Hz、安静连接 10 Hz、慢速 watcher 事件不丢」。

**回归基线**：全量测试 5849 项中 8 项失败，全部是「缺美术素材」相关
（`assets.json` / Spine / atlas / 语言包的本地文件缺失）与 1 项 perf 抖动；
**用 `git stash` 对照跑同一批文件，基线同样失败**，与本轮改动无关（盒子上跑的本来就是无素材版）。

---

## 九、m.public 才是稳态的全部（2026-10-10）

WS 链路这块单独拆成了两份文档：
[《WS 链路压缩（当前已上线）》](./ws-link-compression.md) 写今天在跑的东西（白名单 + 窗口 12、广播漏压的真 bug、观战/AI 节流、热帧去常量 + 基线/兜底）；
[《WS 链路压缩（下一轮）》](./ws-link-compression-next.md) 是待执行的三步
（bonds 按收件人定制 ≈24% wire、delta 合计 2.05×、上游 PR #91 那 9%）与各自的准入条件、验收判据、退路。本节是给站点访客的自包含摘要。

快照率本轮从 10 Hz 调成 **15 Hz 基准 / 20 Hz 动态** —— 但**默认路径（`clientCombat=on`）根本不发 `b.snap`**：
调频只动这一条流，本节与 §9.5 的每席位 / 容量数字（505 B/s、2,475 人）**不受本轮调频影响**。
复测为证（生产默认、拦截每一帧出站消息）：每席位每场共 600.0 KiB、稳态 4,651.4 B/s（未压），
拆分 `m.public` 147.44 KiB / `m.ticker` 2.54 KiB / `b.pool` 0.03 KiB —— 里面没有一帧 `b.snap`。
真正占满上行的，是另一条流：`m.public`（对局的公开状态广播）。

### 9.1 实测：一个席位收到的字节里 98% 是 m.public

用生产 `Match` 引擎跑真实 4 人 co-op 对局，拦截每一帧出站消息：

| 消息 | 占比 | 帧大小 | 频率 |
|---|---|---|---|
| **`m.public`** | **≈98%** | 4,610 B（后期最大 6,647 B） | 对局内 ~0.76 帧/s |
| `m.ticker` | ~2% | 178 B | 偶发（且不可压：105%） |
| `b.snap` / `b.ev` | **0** | — | 默认 `clientCombat` 无观战者时不发 |
| WS ping（心跳） | ~0 | 2 B | 30 s / 次 |

**每席位实测 ≈2,048 B/s（未压）**，几乎全是 `m.public`。
⚠️ 上一版 §四表 B 的「稳态人均 ≈60 B/s」是**建模值，漏了 `m.public`**；§七线上日志的
**p90 = 1,352.7 B/s** 才是真相 —— 两者差 30 倍，根因就在这里。

`m.public` 内部：`players[]` 占整帧 **59–81%**，而 `players[].bonds`（羁绊表）一个字段就占 `players[]` 的 **78%** ——
**每帧重发一份几乎不变的羁绊表**。

### 9.2 找到的真 bug：广播路径从来没压过

`m.public` 走的是**广播**（`Lobby.broadcastRoom → sendRaw`），而压缩白名单
**只在 `send()`（单播）里被查询** —— 广播那条路径从来没传 `compress` 标志。
所以无论白名单怎么写，`m.public` **永远不会被压缩**，白名单对它等于死代码。

修法：`broadcastRoom` 按 `isCompressibleType` 传 `compress`；两条重放路径
（`pendingResult` / `runResync`，发的也是 `m.public` / `m.result`）同样压。

### 9.3 白名单加 `m.public` / `m.private` / `m.result`，窗口 9 → 12

`m.public` 有 ~4.6 KB，512 B 的窗口够不到它重复的羁绊 / 状态块，所以把**这条流的窗口调回去**（注意：措施 4 里那个「9」是为 ~250 B 战斗帧调的，**`m.public` 用的是 12**，两者不是同一个窗口值）：

| `serverMaxWindowBits` | `m.public` deflate 后 |
|---|---|
| 9（上一轮为 ~250 B 战斗帧调的） | 29.8%（**3.36×**） |
| **12** | **20.3%（4.94×）** |

浏览器 WebSocket 自动解压，**对客户端完全透明** —— 不用改客户端、不用改协议、老版本客户端一样有效。

### 9.4 观战 / AI 节流

`server/match/fields.js` 的 `_emit`：**不是本场球员的 watcher** 在**自己的档位**上每 2 帧才收一次 `b.snap`（即它自己的间隔翻倍），
本场球员照收每一帧。覆盖两类，都是「全速位置更新买不到任何东西」的场合：

- **纯观战者** —— 被淘汰的队友、观战席，其客户端本来就在快照之间插值；
- **没人打的场** —— 每个球员都是 AI 的场（全 AI 场），它的 watcher 全是非球员。

`b.ev` 永不丢（它带的是伤害数字 / 阵亡，观战 UI 仍要读）。
这与 §7.1.2 的**链路自适应速率**合成：非球员拿到的是**它自己档位的一半** —— 基准 **7.5 Hz**、动态 **10 Hz**（旧模型 5 / 10）。

### 9.5 10 Mbps 到底能不能带 2000 人

**实测每席位稳态 ≈2,048 B/s（未压）→ 505 B/s（压缩后，占 24.7%）。** 10 Mbps = 1,250,000 B/s：

| | 每席位上行 | 10 Mbps 容纳 | 2000 人 |
|---|---|---|---|
| 未压 | 2,048 B/s | **610 人** | ✗ 差 3.3× |
| **压缩后（本轮）** | **505 B/s** | **2,475 人** | ✓ 余量 ~24% |

**结论：本轮之前，10 Mbps 只能带 ~610 人，远达不到 2000；开上 `m.public` 压缩后是 ~2,475 人，
2000 人「能」跑，但余量只有约 24%** —— 是「刚好够」，不是「宽裕」。
（10 Mbps 留 20% 余量的习惯口径下，安全值 ≈1,980 人，正好卡在 2000 线上。）

⚠️ 前提：`SP_WS_COMPRESSION=on` 必须真的在**生效槽**上。盒子的更新器会**重写槽脚本**，
把手工加的那行抹掉 —— 已修 `tools/box/sp_update_zip.ps1`，让它每次都写这一行；否则切槽后压缩静默失效，
容量掉回 610。

### 9.6 下一个瓶颈与优化方向

压完之后，`m.public` 仍是**唯一**的大头（98%）。它的 JSON 高度重复，所以下一步是**增量（delta）**：

| 做法 | 实测倍数 |
|---|---|
| 顶层字段 delta | 1.4× |
| `players[]` 逐人 diff | **5.2×** |
| 顶层 delta + deflate wb9 | **4.8×**（588 → 122 KiB / 场） |

delta 之后每席位可望降到 **~130–170 B/s** → 10 Mbps 容纳 **~7,000–9,000 人**，2000 人变成「很宽裕」。
代价：要同时改**客户端合并逻辑**（服务端只发变化字段，客户端维护本地镜像），风险高于本轮，
建议单开一轮 + golden 验收。

### 9.7 再进一步：「客户端本地推演 + 服务端只发事件」会砍掉哪些可见内容

这是 §9.6 的极端版（服务端连 `m.public` 全量都不发，只发离散事件）。它会**看得见地**砍掉 / 劣化：

1. **队友的实时棋盘与羁绊**。现在 `players[].bonds / boardCount / shopLevel / lp / status` 是服务端权威下发的；
   事件化后每个客户端要自己回放队友动作 —— **任何 RNG / 时序分叉都显示成错的棋盘 / 羁绊 / LP**。
2. **敌人预览与波次**（`m.private.nextEnemies`、侦察 `m.field`）。来自服务端波次 RNG；客户端拿不到种子就**复现不出**，预览缺失或错。
3. **Boss 血池 / 团队 LP / 联防计数**。服务端算的共享权威值，事件化后靠本地累加，**分叉即错**。
4. **隐藏信息**。别的玩家的商店 / 手牌服务端**故意不发**；要本地推演就得发 → 要么**泄露**（外挂面），要么推不出来。
5. **结算结果 `m.result`**。服务端判定的；事件化让客户端自算 = **可伪造胜负 / 伤害**，所以这一块**必须保留服务端权威，砍不掉**。
6. **倒计时 / deadline** 与 **断线重连**。现在重连靠重放一份 `m.public` 全量状态；事件化后要重放整条事件日志，**重连成本回来了**。

**结论**：服务端不能放弃对结果 / 伤害的权威（否则就是外挂），所以「只发事件」砍得掉的是
**队友状态保真度**与**敌人预览**，砍不掉权威层。真正能落地的是「服务端发**增量 / 事件**、客户端维护本地镜像」——
正是 §9.6 的 delta。

### 9.8 本轮改动与验收

| 文件 | 改动 |
|---|---|
| `server/lobby.js` | `broadcastRoom` 传 `compress`；两条重放路径同样压（**真 bug 修复**） |
| `server/wsCompression.js` | 白名单加 `m.public` / `m.private` / `m.result`；`serverMaxWindowBits` 9 → 12 |
| `server/match/fields.js` | `_emit` 的观战 / AI 节流（非本场球员的 watcher 间隔翻倍，事件不丢） |
| `tools/box/sp_update_zip.ps1` | 生成的槽脚本补 `set SP_WS_COMPRESSION=on`（否则切槽后压缩失效） |
| `test/ws-compression.test.js` · `test/match/spectator.test.js` | 新增广播压缩断言 + 观战节流断言 |

**回归**：`test/match/*` + `test/ws-compression` = **789 项，787 通过，2 skipped，0 失败**。

**复现**：`node _bw-rate.mjs 45`（实时速率）、`node _cap.mjs 60`（未压 / 压缩后容量）。

---

## 十、把「整场不变的字段」请出热帧（2026-10-10，re-apk 线 / PR #157）

§九 之后 `m.public` 仍是唯一的大头。它内部有一批**开局即定、之后不再变**的字段（`lastRound` / `modeId` /
`difficulty` / `stageId` / `factions` / `disabledBonds` / `drawnDisabledBonds` / `bannedChess` / `bossId` /
`hiddenBossId`），而 permessage-deflate 用的是 **`serverNoContextTakeover`（每帧独立压）** ——
**帧里任何常量都要在每一帧付出它的压缩后大小**。这就是它们值得搬走的全部理由。

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

### 10.3 兜底（照抄 15Hz↔20Hz 那套的六要素）

| 快照率（§7.1.2）的要素 | 本文的对应物 |
|---|---|
| `SP_SNAP_RATE=auto/slow/fast` pin | 能力位（**每 socket**，`hello.pub`） |
| 每 watcher 独立计数决策（15 / 20 Hz 两档互不嵌套） | 每 socket 的 `pubCap`，**每次 hello 重新求值** |
| 快照已无「守恒守卫」（旧"慢 tick ⊂ 快 tick"随独立计数作废） | **基线一定先到**：`start()` 与 `_resync()` 都发 —— 理由不同：漏帧 / 重连的合并端需要一份权威全量帧 |
| 无链路源 → plain 15 Hz | **未声明能力 → 一律发完整帧**（老客户端 / 第三方 / 部署前打开的旧 JS） |

**`hello.version` 仍强校验**（`server/net.js`），所以能力位是**新增的可选字段**，不是版本号。

### 10.4 还没做（按顺序）

1. **`players[].bonds` 按收件人定制**（只发"屏幕上"那 1~2 个球员，其余剥掉）：单独一项约再省 **24% wire**；
   需要服务端按收件人出帧 + 点开非屏幕玩家时走一次 `g.bonds` 按需请求。
2. **delta**（只发变化字段）：在裁剪之上再约 **1.24×**（合计 2.05×）。
3. 上游 **PR #91** 的只读状态接口（给外部观察者，**不动**对局内广播）。


