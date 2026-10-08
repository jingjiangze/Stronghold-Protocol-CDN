# 上行带宽最大化压缩

> 目标：在小上行带宽（以 **10 Mbps** 为算例）的家用盒子上一台服务器能带更多人。
> 全部数字来自工作树实测（`master-play`：158 个静态文件 / 7,969 个素材）与线上探测，不是估算值。
> 日期：2026-10-09 · 同步发布在 <https://downcdn.jiangjiangze.icu/bandwidth.html>

---

## 一、结论先行

**上行从来不是稳态瓶颈，是首载瓶颈。** 这是本轮最重要的发现，它决定了后面所有取舍：

| | 稳态（对局进行中，默认配置） | 首次进场（新玩家第一次连进来） |
|---|---|---|
| 优化前人均上行 | ≈60 B/s | **467.9 MiB** |
| 优化后人均上行 | ≈60 B/s | **1.48 MiB** |
| 10 Mbps 下 | 20,000+ 人（先撞 CPU / fd） | 从「1 人 6.5 分钟」变「1 人 1.2 秒」 |

也就是说：**花力气压 WS 帧收益接近零，花力气把素材和代码挪走收益是几百倍。**
本轮 90% 的收益来自「不让你盒子发字节」，而不是「把字节压得更小」。

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

### 措施 4 — permessage-deflate `serverMaxWindowBits` 12 → 9

`server/wsCompression.js`：

```js
serverMaxWindowBits: 9,          // 512 B 滑动窗口（原 12 = 4 KiB）
serverNoContextTakeover: true,   // 保内存上界
clientNoContextTakeover: true,
threshold: 512,                  // 小帧不压
concurrencyLimit: 8,
zlibDeflateOptions: { level: 6, memLevel: 5 },
```

- 小窗口用更便宜的距离码，实测**反而更省**：35.8% vs 36.5%、28.8% vs 30.0%。
- 只压 `b.snap` / `b.ev` / `m.field`，其余帧照常。
- ⚠️ **这个功能默认 `off`，且默认路径几乎用不到它**：`clientCombat` 默认 `on`（DESIGN §14），战斗跑在玩家浏览器里，服务端只在 AI / 接管 / `SP_COMBAT=server` 时才发 `b.snap`。

### 措施 5 — `clientCombat: on`（别退回去）

这是**天然的最大带宽优化**，不是我们做的，但必须守住：战斗逻辑在各端浏览器跑，服务端不广播 30 Hz 快照。

对比（`b.snap` 24 单位实测）：

| | 单帧 | 30 Hz 满帧每秒 | 10 Mbps 容纳 |
|---|---|---|---|
| 未压 | 1,058 B | 31.0 KiB/s = 0.25 Mbps | **39 人** |
| deflate w9（本轮） | 252 B | 7.6 KiB/s = 0.06 Mbps | **160 人** |

压完是 4 倍，但**只要 `clientCombat` 退成 `off`，这两种都比默认路径贵 100 倍以上**。这是本轮唯一有数量级意义的风险点。

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
| **B. 对局中（默认 `clientCombat`）** | ≈60 B/s | ≈480 bps | **20,833 人** | 服务端几乎不发 `b.snap` |
| C. 对局中（服务端模拟，**未压**） | 31,744 B/s | 254 kbps | **39 人** | `SP_COMBAT=server` / AI 接管 |
| D. 对局中（服务端模拟，**deflate w9**） | 7,782 B/s | 62 kbps | **160 人** | 同上，开启压缩 |

**读法**：A / B 的数字是「上行先被打满的人数」，但它大到没有意义 —— 现实中会先撞 CPU、每进程 fd 上限、`maxConnections`。也就是说**默认配置下上行根本不构成限制**，上表的 2 万人只用来说明余量有多大。

**C → D 的 39 → 160 人是本轮措施 4 的真实价值**，但它只在非默认路径上成立。

### 结论

> 优化前，10 Mbps 上行的实际容量是 **1~2 个新玩家排队进场**（素材占死）；
> 优化后，稳态容量由 CPU 决定（万级），首载吞吐 **0.81 人/s** 且复访为 **0**。

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

## 七、改动清单

| 文件 | 改动 | 状态 |
|---|---|---|
| `server/wsCompression.js` | `serverMaxWindowBits` 12 → 9 | ✅ 已改，5/5 测试通过 |
| `test/ws-compression.test.js` | 同步断言为 9 | ✅ 5/5 pass |
| `server/http/static.js` | 新增 `versionIndexHtml()` + `serveVersionedIndex()`，接线 `index.html` | ✅ 已改 |
| `test/index-version.test.js` | 新增 4 项（25/25 覆盖、幂等、线上 buildTag 一致、immutable 分支） | ✅ 4/4 pass |
| `server/http/files.js` | 仅注释：说明 `js`/`css` 为什么不进 `LONG_CACHE_DIRS` | ✅ 已改 |
| `CHANGELOG.md` | 「未发布 → 静态资源」小节 | ✅ 已改 |
| `SP_ASSET_CDN` 部署 | **无需改动**，线上已生效 | ✅ 已核验 |

> ⚠️ 上述 3 个代码文件**尚未提交**：仓库当时处于合并冲突中（7 个 `UU` 冲突，均非本轮文件），等待冲突解决后再一并提交。
