# WS 链路压缩（当前已上线 · as-built）

> 对象：对局期间的 WebSocket 出站（服务端 → 客户端）。与「素材搬去 CDN」那条线分开记 ——
> 那条解决**首载**，这条解决**稳态**，而 10 Mbps 带 2000 人的天花板在稳态这一侧。
> 日期：2026-10-10 · 全部数字来自本仓库实测脚本，不是估算。

---

## 一、目标与判据

| | 值 |
|---|---|
| 预算 | 10 Mbps = 1,250,000 B/s |
| 目标 | 2000 人同时在线 |
| 因此每席位可花 | **625 B/s** |

**结论（已达成）**：优化前 2,048 B/s/人（10 Mbps 只够 **610 人**）；压缩后 **505 B/s/人（2,475 人）** → 2000 人**能跑，余量约 24%**。

---

## 二、一个席位收到的字节里 98% 是 `m.public`

用生产 `Match` 引擎跑真实 4 人 co-op 对局、拦截每一帧出站消息：

| 消息 | 占比 | 帧大小 | 频率 |
|---|---|---|---|
| **`m.public`** | **≈98%** | 4,610 B（最大 6,647） | 对局内 ~0.76 帧/s |
| `m.ticker` | ~2% | 178 B | 偶发（且不可压：105%） |
| `b.snap` / `b.ev` | **0** | — | 默认 `clientCombat` 无观战者时不发 |
| WS ping（心跳） | ~0 | 2 B | 30 s / 次 |

所以「WS 压缩」= **压 `m.public`**。`b.snap` 那条只在服务端跑战斗（接管 / `SP_COMBAT=server`）时才活；
本轮把它的基准率从 10 Hz 调到 **15 Hz（抖动 20 Hz）**，只影响这条非默认路径，**不改变本节的每席位 / 容量数字**。

---

## 三、手段 1 — permessage-deflate，白名单 + 窗口 12

`server/wsCompression.js`：`threshold 512`、`serverNoContextTakeover`、`serverMaxWindowBits 12`、`level 6 / memLevel 5`。

- **白名单**：`b.snap` / `b.ev` / `m.field` / `m.public` / `m.private` / `m.result`。
- **窗口为什么是 12**：`m.public` 有 ~4.6 KB，512 B 窗口够不到它重复的羁绊 / 状态块 ——
  实测 **wb9 = 3.36×、wb12 = 4.94×**。（小窗口对 ~250 B 的战斗帧更省，那是旧口径。）
- **浏览器自动解压**，对客户端完全透明：不改客户端、不改协议、老版本客户端一样有效。

### 3.1 顺手修掉的真 bug：广播路径从来没压过

`m.public` 走的是**广播**（`Lobby.broadcastRoom → sendRaw`），而压缩白名单**只在 `send()`（单播）里被查询** ——
广播那条路径从来没传 `compress`。**所以无论白名单怎么写，`m.public` 永远不会被压缩**，白名单对它等于死代码。
修法：`broadcastRoom` 按 `isCompressibleType` 传 `compress`；两条重放路径（`pendingResult` / `runResync`，发的也是
`m.public` / `m.result`）同样压。

⚠️ **前提**：`SP_WS_COMPRESSION=on` 必须真的在**生效槽**上。盒子更新器会重写槽脚本、抹掉手工加的那行 ——
已修 `tools/box/sp_update_zip.ps1` 让它每次都写；否则切槽后压缩静默失效，容量掉回 610。

---

## 四、手段 2 — 观战 / AI 节流

`server/match/fields.js` 的 `_emit`：**不是本场球员的 watcher** 在**自己的档位**上每 2 帧才收一次 `b.snap`（即它自己的间隔翻倍），本场球员照收每一帧。
覆盖两类，都是「全速位置更新买不到任何东西」的场合：

- **纯观战者** —— 被淘汰的队友、观战席，其客户端本来就在快照之间插值；
- **没人打的场** —— 每个球员都是 AI 的场，它的 watcher 全是非球员。

`b.ev` **永不丢**（它带的是伤害数字 / 阵亡）。这一层与 `snapRate.js` 的**链路自适应速率**（15 Hz ↔ 20 Hz，
按 watcher 的 RTT 抖动升降、有滞后与刹车；每个 watcher 有自己的流逝 tick 计数，两档互不嵌套）**合成**：
非球员拿到的是**它自己档位的一半** —— 纯观战者 / 全 AI 场：基准 **7.5 Hz**、动态 **10 Hz**（旧模型是 5 / 10）。

---

## 五、手段 3 — 热帧去掉「整场不变的字段」（PR #157，待合并）

因为 `serverNoContextTakeover` **每帧独立压**，帧里任何常量都要在**每一帧**付出它的压缩后大小。
十个字段开局即定、之后不再变（`lastRound` / `modeId` / `difficulty` / `stageId` / `factions` /
`disabledBonds` / `drawnDisabledBonds` / `bannedChess` / `bossId` / `hiddenBossId`；五个 case 实测 distinct 全为 1）。

| | 每帧 |
|---|---|
| 完整帧（基线，带 `full: true`） | 5,653 B |
| **紧凑帧（热帧）** | **4,799 B** |
| **每帧省** | **15.1%** |

### 5.1 基线 + 合并（**重连是重中之重**）

- 热帧变**紧凑帧**；常量只在**基线**里走一次。
- `start()`：在阶段推进之后、flush 之前，给每个**在线真人席位**发一份基线 —— 保证任何紧凑帧之前
  客户端手里已有常量。
- `_resync()`：加入 / **重连** / 观战席中途加入本来就发完整视图，现在带 `full: true`。
- 客户端把 `m.public` 从**整份替换**改为**合并**：见 `full: true` 就**丢弃镜像**重来，否则合并 ——
  紧凑帧再也擦不掉基线给的常量。
- **结算屏重放**保留完整帧，否则重连后会被重放一帧没有 `difficulty` 的视图。

### 5.2 兜底（照抄 15 Hz↔20 Hz 那套的六要素）

| 快照率（`snapRate.js`）的要素 | 本方案的对应物 |
|---|---|
| `SP_SNAP_RATE=auto/slow/fast` pin | 能力位**每 socket**（`hello.pub`） |
| 每连接决策（每个 watcher 独立计数） | 每次 hello **重新求值**（重连换了新旧客户端不会被上次答案污染） |
| 快照两档互不嵌套（15 / 20 Hz，无子集要求；旧「守恒守卫」已随按 watcher 独立计数作废） | **基线一定先到**：`start()` 与 `_resync()` 都发 —— 理由不同：漏帧 / 重连的合并端需要一份权威全量帧 |
| 无链路源 → plain 15 Hz | **未声明能力 → 一律发完整帧** |

**`hello.version` 仍强校验**，所以能力位是**新增的可选字段**。老客户端 / 第三方客户端 / 部署前打开还在跑旧 JS
的页面 → 行为与今天**完全一致**。

---

## 六、验收（三条命令）

```bash
# 1. 真实 WS Upgrade 握手，读协商出的扩展参数（期望 server_max_window_bits=12）
#    ⚠️ 不要用 `curl -sI <站点>/ | grep sec-websocket` —— 那是普通 HEAD，不是 Upgrade 握手，验不了压缩。
#    生效槽在盒子上是 127.0.0.1:3001 / :3002，从盒子本机（或经隧道）直连做握手：
node -e '
const n=require("net"),s=n.connect(PORT,"HOST",()=>s.write(
 "GET /ws HTTP/1.1\r\nHost: HOST\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
 "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"+
 "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n"));
let b="";s.on("data",d=>{b+=d;if(b.includes("\r\n\r\n")){
 console.log(b.split("\r\n").filter(l=>/^(HTTP|Sec-WebSocket-Extensions)/i.test(l)).join("\n"));s.destroy();}});'
# 期望：Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover;
#       client_no_context_takeover; server_max_window_bits=12

# 2. 生效槽的脚本里有压缩开关（否则切槽后静默失效）
#    盒子上：update/sp_slot_<port>.cmd 应含 set SP_WS_COMPRESSION=on

# 3. 契约与 buildTag（部署后）
node tools/box/verify-service.mjs --expect=<新 buildTag>
```

> ⚠️ **只看到扩展协商成功，不等于 `m.public` 广播路径已经修好。** 白名单只在单播 `send()` 里被查询过 ——
> 广播路径（`Lobby.broadcastRoom`）必须自己把 `compress` 传下去，否则占 98% 的那条流一字节都不会被压。
> 两者要分别验：握手看扩展，广播看代码接入点（或看线上实际出站字节）。


---

## 七、还没做 → 见《WS 链路压缩（下一轮）》

`players[].bonds` 按收件人定制（≈24% wire）、delta（合计 2.05×）、上游 PR #91 的只读接口。
数字与方法都写在 **`ws-link-compression-next.md`**（同一目录）。
