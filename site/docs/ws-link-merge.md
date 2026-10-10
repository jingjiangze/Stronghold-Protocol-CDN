# WS 链路压缩 · 合并说明（ws-link-as-built）

> 这个包把 **fork 独有的 WS 链路层**装进一份服务器部署。它不改游戏协议、不改 JSON 内容，
> 客户端零改动（浏览器 WebSocket 自动解压）。适用于：拿上游官方包自建服务器的第三方服主，
> 或任何要把这套带宽优化应用到现有部署的人。

## 这是什么 / 治什么病

对局期间一个玩家收到的字节 **98% 是 `m.public`**（对局公开状态广播）。默认配置下实测每席位
**2,048 B/s** —— 10 Mbps 上行只带得动 **~610 人**。装上这个包后每席位 **~505 B/s**，10 Mbps 约 **2,475 人**。
（数字来源见 [《WS 链路压缩》](./ws-link-compression.md)。）

包里 5 个文件，各治一件事：

| 文件 | 治什么 |
|---|---|
| `server/wsCompression.js` | **新文件**：有界 deflate 参数（窗口 12 / 阈值 512 B / 无上下文接管）+ 压缩白名单（含 `m.public`） |
| `server/lobby.js` | **真 bug**：`m.public` 走广播路径，而压缩开关过去只在单播路径生效 → `broadcastRoom` 和两条重放路径补传 `compress` |
| `server/match/fields.js` | 观战 / AI 快照节流：**非本场球员的 watcher 按自己的档位每 2 帧收一次** `b.snap`（即它自己的间隔翻倍 → 基准 7.5 Hz / 动态 10 Hz），`b.ev` 永不丢 |
| `tools/box/sp_update_zip.ps1` | 盒子上自动更新器重写槽脚本时**保留** `SP_WS_COMPRESSION=on`（用自建蓝绿更新的才需要；手工起服可忽略） |
| `tools/ws-link-gate.mjs` | **同步门禁**：`node tools/ws-link-gate.mjs` 十项自检，防止下次更新把这套层静默抹掉 |

## 下载与校验

```
https://github.com/jingjiangze/Stronghold-Protocol/releases/download/ws-link-as-built/ws-link-AS-BUILT.zip
```

- 大小 **45,580 B** · sha256 **`cc50666ab0593301502862187881666883474e384a4839589d38daf7eba75afa`**
- 对应源码：`jingjiangze/Stronghold-Protocol` 分支 **`master-play`**，提交 **`c587705f`**

> ⚠️ 两个前提（来自上游代码核对）：上游 `server/http/websocket.js` 把 `perMessageDeflate` 钉死为 `false`，
> 且上游没有本包的接入点 —— **直接整包同步上游会把这套层静默还原**（服务器照常跑，握手不再给 deflate）。
> 所以每次更新部署后，跑一遍门禁（见下）。

## 合并步骤

### 1. 备份

```bash
cp server/lobby.js server/lobby.js.bak
cp server/match/fields.js server/match/fields.js.bak
```

### 2. 覆盖

把 zip 解到部署根目录（保持相对路径）：`server/wsCompression.js`、`server/lobby.js`、
`server/match/fields.js`、`tools/`。

- `server/lobby.js` / `server/match/fields.js` 是**整文件覆盖**：如果你的部署改过这两个文件，
  不要直接盖，用 diff 把三处接入点手工挪进去：
  1. `lobby.js` 顶部 `import { isCompressibleType } from './wsCompression.js';`
  2. `lobby.js` `broadcastRoom()`：`sendRaw(session.ws, data, { droppable, compress: isCompressibleType(msg && msg.t) })`
  3. `lobby.js` 两处重放（`pendingResult`、`runResync`）：`sendRaw(..., { compress: true })`
- `net.js` 的 `sendRaw` 若被上游改回去，参照 zip 里 `server/net.js` 不存在 → 你只需确认你的
  `sendRaw(ws, data, { droppable, compress })` 仍把 `compress` 传给 `ws.send(data, { compress })`。

### 3. 开开关

启动环境里加：

```
SP_WS_COMPRESSION=on
```

（关 = 完全回退上游行为。默认 off。）

### 4. 自检 + 门禁

```bash
node tools/ws-link-gate.mjs          # 期望 10/10 ok
```

**握手验收**（必须用真实 WS Upgrade，`curl -sI` 验不了）：

```bash
node -e '
const n=require("net"),s=n.connect(3000,"127.0.0.1",()=>s.write(
 "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
 "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"+
 "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n"));
let b="";s.on("data",d=>{b+=d;if(b.includes("\r\n\r\n")){
 console.log(b.split("\r\n").filter(l=>/^(HTTP|Sec-WebSocket-Extensions)/i.test(l)).join("\n"));process.exit(0);}});'
# 期望：HTTP/1.1 101 +
# Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover;
#   client_no_context_takeover; server_max_window_bits=12
```

注意：**握手协商成功 ≠ 广播已压** —— `broadcastRoom` 的接入点（上面第 4 行 diff）才是 `m.public` 被压的原因，
门禁的 `broadcastRoom passes compress` 一项就是查它。

### 5. 回退

```bash
rm server/wsCompression.js && cp server/lobby.js.bak server/lobby.js && cp server/match/fields.js.bak server/match/fields.js
# 去掉 SP_WS_COMPRESSION 或设为 off
```

回退后行为与上游完全一致：协议、JSON 内容、消息类型都没动过。

## 兼容边界

| 客户端 | 影响 |
|---|---|
| 浏览器原生 WebSocket（官方网页端 / 我们的 APK） | **零改动**：deflate 由浏览器自动解压 |
| 不做 permessage-deflate 协商的第三方客户端 | 零影响：没协商就不压，帧内容不变 |
| 用 `version` 校验的连接 | 零影响：本包不动 `PROTOCOL_VERSION`、不动握手字段 |

**本包不含**：热帧去常量 / 基线合并 / `hello.pub` 能力位（那是下一轮，见
[《WS 链路压缩（下一轮）》](./ws-link-compression-next.md)）—— 那部分要求服务端与客户端**成对发布**，
不能这样单独盖。
