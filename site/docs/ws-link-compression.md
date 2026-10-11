# WS 链路压缩（当前已上线 · 2026-10-12 版）

> 对象：对局期间的 WebSocket 出站（服务端 → 客户端）。与「素材搬去 CDN」那条线分开记 ——
> 那条解决**首载**，这条解决**稳态**。
> ⚠️ **本页于 2026-10-12 整体重写**。上一版写的是旧配置（阈值 512 / 关上下文接管 / 窗口 pin 12）
> 与旧容量（2,048 → 505 B/s、610 → 2,475 人）—— **那套参数已经不在跑，那组容量已被整局实测推翻。**
> 现在的配置与数字见下文，全部来自线上握手与整局逐字节实测。
> 配套：[《WS 链路压缩（下一轮）》](./ws-link-compression-next.md) ·
> [《独立库与工坊包》](./ws-compression-library-and-pack.md) ·
> [《合并说明（旧 as-built 包）》](./ws-link-merge.md)

---

## 一、目标与判据

| | 值 |
|---|---|
| 预算 | 10 Mbps = 1,250,000 B/s |
| 目标 | 2000 人同时在线 |
| 因此每席位可花 | **625 B/s** |

**结论（现在的线上）**：每席位 **57.5 B/s** —— 只有预算的 **9.2%**，10 Mbps 约 **21,000 并发**
（留 20% 余量约 **17,000**）。2000 人不再是「刚好够」，而是**有约 10 倍余量**。

> ⚠️ **这个数字只对「已经在玩、客户端已缓存」的席位成立。** 真正的约束在别处：
> 一个新玩家**冷启动**要拉 **5.4 MB** 客户端代码，摊到 60 分钟是 **1,573 B/s** —— 比对局流量贵 **27 倍**。
> 省带宽的优先级是：① 把客户端静态交给 CDN（现在盒子自己发、CF 实测 `MISS`）→ ② 本页这套压缩
> → ③ 隐藏标签页停推。详见《下一轮》§四。

---

## 二、一个席位的字节都花在哪（整局实测，不是抽样）

用**真实服务器进程 + 真实 socket + AI 托管打满一整局**、拦截每一帧、两端字节校验通过后统计
（两次独立测量吻合：600 s 整局 104.6 B/s，400 s 窗口 111.3 B/s）：

| 流 | 应用层 | 在线速率 | 说明 |
|---|---|---|---|
| **`b.start`** | 43,504 B | **72.5 B/s** | 战斗规格，每场次每人一次 ~4.2 KB —— **占 69%** |
| `m.private` | 278,496 B | ~23 B/s | 逐人私有视图（棋盘 / 经济 / 商店） |
| `m.public` | 28,573 B | ~3 B/s | 公开状态广播，delta + 压缩后 |
| 其余控制帧 | 3,828 B | 6.4 B/s | `welcome` / `room.state` / `ticker` / `b.end` |
| **合计** | 354,401 B / 600 s | **≈105 B/s/席** | 这是 `b.start` **进白名单之前** |

> 🔴 **这条推翻了「98% 是 `m.public`」那个旧结论。** 那个百分比是在**机器人座位**上量出来的 ——
> `messaging.js` 的 `sendTo()` 第一句就是 `if (!ps || ps.isBot || ps.left) return false`，
> **机器人收不到任何单播**，所以样本里根本没有 `m.private`；98% 是在「只剩 `m.public`」的残缺样本里算的。
> 换成人类座位重测后，`m.public` 只剩 **3%**，大头是 `b.start` 与 `m.private`。
> ⇒ **凡看到「98% / 2,475 人」的旧口径，一律按本节作废。**

**把 `b.start` 也压掉之后（真机 A/B，同一套探针、同座位打一局）**：

| | 压 `b.start` 前 | 压 `b.start` 后 |
|---|---|---|
| 人均上行 | 125.3 B/s | **57.5 B/s（−54.1%）** |
| 整局逐字节 | 应用层 70,626 B | 在线 **8,610 B（8.20×）** |
| 逐帧校验 | — | **36 帧 / 解析失败 0** |

线上 `build 8dc03d15fddc`，翻槽时有 16–19 个真人在玩。

---

## 三、传输压缩：三档 `off` / `on` / `safe`

配置（`server/ws-compression/wsCompression.mjs`，零依赖，已 vendored 进服务器）：

```js
const SHARED = Object.freeze({
  threshold: 64,
  clientNoContextTakeover: true,
  concurrencyLimit: 8,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 5 }),
});
const OPTIONS      = SHARED;                                                       // on
const SAFE_OPTIONS = Object.freeze({ ...SHARED, serverNoContextTakeover: true });  // safe
const MODES = Object.freeze({ off: false, on: OPTIONS, safe: SAFE_OPTIONS });
```

### 3.1 两个参数**故意不声明**，这不是遗漏

| 选项 | 状态 | 为什么不写 |
|---|---|---|
| `serverNoContextTakeover` | **不声明**（= 协商，实际开上下文接管） | 跨帧复用字典才是真省钱：`m.private` **4.07× → 43.55×**、delta `m.public` **2.69× → 12.68×**、整流 **3.76× → 26.59×** |
| `serverMaxWindowBits` | **不声明**（= zlib 默认 15 位） | 一旦声明（哪怕 12），`ws` 会**拒绝**要求更小窗口的客户端并以 **HTTP 400 断连** |

⚠️ **写 `serverNoContextTakeover: false` 是错的** —— 在 `ws` 的协商里字面 `false` 意思是
「**强制要求** context takeover」，会拒绝要 no-context-takeover 的客户端（400）。**不声明 = 协商**，
两类客户端都能连。

⚠️ **同理，旧配置里的 `serverMaxWindowBits: 12` 是个潜伏 bug**：真实浏览器不要求小窗口所以从没炸过，
但任何要求窗口 < 12 的客户端会直接拿 400。本轮已去掉，回归测试钉住 **5 种客户端 offer × 2 档**全部不得 400。

### 3.2 `threshold: 64` 在 `on` 档是**死参数**（别被它误导）

核实 `ws` 8.22.0 `lib/sender.js`：

```js
if (rsv1 && perMessageDeflate && perMessageDeflate.params[... 'server_no_context_takeover' : 'client_no_context_takeover']) {
  rsv1 = byteLength >= perMessageDeflate._threshold;   // 只在「关掉 context takeover」时才查阈值
}
```

- `on` 保留上下文接管 → **阈值根本不生效**，小于 64 B 的 `b.snap` 照样被 deflate（不是 bug，是 `on` 的预期行为）。
- `safe` 声明了 no-context-takeover → **阈值才生效**，64 B 以下裸发。
- 阈值从 **512 降到 64** 仍然是对的：**那是对 `safe` 档的修正** —— 帧瘦身把热帧中位数推到 512 以下，
  当时 **61% 的热帧悄悄不再被压缩**。

### 3.3 三档与回退

| 档 | 上下文接管 | 窗口 | 阈值 | 用途 |
|---|---|---|---|---|
| `off` | — | — | — | 完全回退上游行为，握手不提供扩展 |
| **`on`（生产默认）** | 开（协商） | 15（默认） | 死参数 | 最大压缩比 |
| `safe` | **关** | 15 | **生效（64 B）** | 一键回退；每 socket deflate 上下文 ~64 KB → ~8 KB |

---

## 四、白名单：6 类基础 + `b.start`（带一词回退开关）

```
基础集（收敛后）：b.snap  b.ev  m.field  m.public  m.private  m.result
额外集（可配）：  b.start（默认开）
```

- 基础集**不随开关移动** —— 回退只收回额外类型，不是重置。
- `SP_WS_COMPRESS_EXTRA`（上游名 `WS_COMPRESS_EXTRA`）：不设 = 默认含 `b.start` / **`none` = 一词回退** /
  逗号列表 = 指定。
- ⚠️ 用 `none` 而不是空串：Windows `.cmd` 里 `set X=` 是**取消设置**，表达不了「空」，会静默回落到默认。
- 盒子读 `D:\stronghold\update\ws-extra.txt`（**不在发布包内**，永不被部署覆盖）。

`b.start` **不可丢**（`isDroppable` 只认 `b.snap`）⇒ **不存在**「进了 deflate 上下文却没送达」的 desync 路径。
CPU 成本可忽略（原本跳过的帧改压：整局 143 ms = 0.1%）。

---

## 五、顺手修掉的真 bug：广播路径从来没压过

`m.public` 走的是**广播**（`Lobby.broadcastRoom → sendRaw`），而压缩白名单**只在 `send()`（单播）里被查询** ——
广播那条路径从来没传 `compress`。**所以无论白名单怎么写，`m.public` 永远不会被压缩**，白名单对它等于死代码。

修法：`broadcastRoom` 按 `isCompressibleType` 传 `compress`；两条重放路径（`pendingResult` / `runResync`，
发的也是 `m.public` / `m.result`）同样压。

> 🔴 **「扩展协商成功」≠「广播路径已修好」。** 这两件事必须分别验：握手看扩展头（§八），
> 广播看接入点或线上实际出站字节。它是历史上最容易被「握手 101 了所以好了」骗过去的一个坑。

---

## 六、同一条链路上的另外三层

| 层 | 做什么 | 收益 | 怎么关 |
|---|---|---|---|
| **B 帧瘦身 ③④** | ③ `players[].bonds` 按收件人定制 + ④ 逐收件人 delta | `m.public` **6.05× raw / 2.98× deflate** | 客户端不声明 `hello.pub`；`SP_PUB_SYNC=full` |
| **C 快照节奏** | 球员 20 Hz / 观战 5 Hz；**无变化不发帧** | 观战者 −75% 帧 | `SNAPSHOT_EVERY_FAST === SNAPSHOT_EVERY` |
| **D 会话路由** | 重连回到**拥有该会话**的槽 | 翻槽不断线 | 不设 `SP_ROUTE_DIRECTORY` / `SP_ROUTE_SECRET` |

⚠️ **A（传输压缩）与 B/C 吃的是同一份跨帧冗余，收益不能相乘** —— B 让帧变小，A 让重复变免费，
乘出来的数字一定偏高。

---

## 七、两个「一词回退」开关（免重新部署）

| 文件 | 写什么 | 作用 |
|---|---|---|
| `D:\stronghold\update\ws-mode.txt` | `on` / `safe` / `off` | 换档位 |
| `D:\stronghold\update\ws-extra.txt` | `none` / 逗号列表 | 收回 `b.start` 等额外类型 |

两个文件**故意分开**：任一回滚都不会被另一个挡住。它们**不在发布包内**，部署永远不会覆盖。

⚠️ **前提**：槽脚本必须真的读它们 —— `tools/box/sp_update_zip.ps1` 会在每次重写槽脚本时把这两行读回来
（槽脚本被重写抹掉手工加的行，是这个部署的历史坑）。

---

## 八、验收（真实 Upgrade 握手）

```bash
# ⚠️ 不要用 `curl -sI <站点>/ | grep sec-websocket` —— 那是普通 HEAD，不是 Upgrade 握手，验不了压缩。
# 直连生效槽（3001 / 3002），或经隧道连 /ws：
node -e '
const t=require("tls"),s=t.connect({host:"HOST",port:PORT,servername:"HOST",rejectUnauthorized:false},()=>s.write(
 "GET /ws HTTP/1.1\r\nHost: HOST:PORT\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
 "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"+
 "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n"));
let b="";s.on("data",d=>{b+=d;if(b.includes("\r\n\r\n")){
 console.log(b.split("\r\n").filter(l=>/^HTTP|Sec-Websocket-Extensions/i.test(l)).join("\n"));s.destroy();}});'

# 期望（on 档，2026-10-12 线上实测）：
#   HTTP/1.1 101 Switching Protocols
#   Sec-Websocket-Extensions: permessage-deflate; client_no_context_takeover
```

**判据**：响应里**有** `permessage-deflate`，且**没有** `server_no_context_takeover`、**没有**
`server_max_window_bits` —— 有这两项就说明跑的不是 `on` 档（或配置被改回去了）。
`safe` 档会多一个 `server_no_context_takeover`。

> 隧道会重置一部分连接（樱花隧道实测 70–80%），所以**多试几次**，只认拿到的那条 101。

| 另外两条 | 命令 / 位置 |
|---|---|
| 槽脚本里的开关 | `update/sp_slot_<port>.cmd` 应读 `ws-mode.txt` / `ws-extra.txt` |
| 契约与 buildTag | `node tools/box/verify-service.mjs --expect=<新 buildTag>` |

---

## 九、只读接口（对外可查，不用登录）

| 路径 | 内容 | Cache-Control |
|---|---|---|
| `GET /ws-compression/status` | 生效档位、**实际会到线上的选项**（含两个「不声明」项）、可压类型、连接数 | `no-store` |
| `GET /ws-compression/stats` | 发送 / 跳过 / 字节 / 终止计数 | `no-store` |

只 `GET` / `HEAD`，其余动词 `405 Allow: GET, HEAD`。
⚠️ 这两条路**当前不在 `www.u712507.nyat.app` 这台盒子上**（实测 404）—— 它们随 `stronghold-server` 那条线，
装了这套层的部署才有。

---

## 十、独立库与工坊包

- **零依赖库 + 完整链路层**：<https://github.com/jingjiangze/stronghold-ws-compression>（MIT，28 项测试）
- **Forge 工坊兼容包** `ws-compression-reference`：已投稿 mod 站（`47.103.14.217:25570`，两条 `pending`），
  并开成 [PR #1](https://github.com/XiaMo233M/Stronghold-Protocol-Forge-Mods/pull/1) 进 `packs/`。
  ⚠️ 它**开不了压缩** —— 工坊包只有 `server.preDispatch`（拦**入站**消息）与 `routes`（只读 `.json`），
  而压缩是 `WebSocketServer({ perMessageDeflate })` 的**启动选项**，握手早就完成了。
  详见 [《独立库与工坊包》](./ws-compression-library-and-pack.md)。

---

## 十一、还没做 → 见《下一轮》

- ③ / ④ 目前在 **re-apk 分支**且 `SP_PUB_SYNC` 默认 `full`（delta **默认关**）→ 盒子跑的是 master-play，**拿不到**。
- 冷启动 5.4 MB 走盒子上行（CF `MISS`）—— **这才是容量的真瓶颈**。
- 隐藏标签页停推；`PUBLIC_THROTTLE` 100 → 200 ms。
- 详见 [`ws-link-compression-next.md`](./ws-link-compression-next.md)。
