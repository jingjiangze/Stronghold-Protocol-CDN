# openp2p 异地联机 P2P 平台

> 非官方同人作品，仅供学习交流。素材版权归 Hypergryph / Yostar 所有。

把 openp2p 用作游戏《卫戍协议：盟约》的异地联机组网。端口转发模型：把房主的本地 3000 端口映射到每个玩家自己的本地 / 入口，玩家在本地访问 `127.0.0.1:3000` 即等同于访问房主机房里的同一端口。平台跑在阿里云 ECS 上，对外经 Cloudflare 隧道暴露，玩家只要能出站 UDP 即可，无需公网 IP。

本文分两部分：

- **第一部分 · 给 Agent / 程序接入看**：接口字段、返回结构、接入契约，复制顶部代码块给 agent 即可干活。
- **第二部分 · 给腐竹 / 房主安装看**：房主怎么把服务器接进来的逐步人话教程，含三种方案（本地手动装 / Windows 启动器 / Docker 云部署）。

> 只想让**自己的服务器**接入平台（玩家只跟服务器打交道、不装启动器）？直接看第一部分的
> 「服务端内置接入」一节，或网页版 <https://downcdn.jiangjiangze.icu/p2p-platform>。

---

# 第一部分 · 给 Agent / 程序接入看

下面这块复制给调用方就够了；想接服务器直接看「第二部分 · 房主怎么接入」。

```
平台主址       https://p2p.jiangjiangze.icu
平台备址       https://aliyun.jiangjiangze.icu
平台语义       v3「仅握手」：平台绝不中转任何游戏流量，只下发连接参数 + /go/<roomId> 发一条 302 决定玩家去哪
房间时效       开房后 6 小时过期（expiresAt 是 ISO 8601 UTC）
p2p 房间       传 hostNode（8–63 位，[A-Za-z0-9._-]），房主自跑 openp2p 节点，游戏绑 3000
直连房间       传 upstream（https 源站，*.ms.show / *.modelscope.cn / *.jiangjiangze.icu），平台纯 302 直连，腐竹零安装
code 规则      可选，不校验长度（传 2 位也行）；不填返回 null
可用入口       joinUrl = https://p2p.jiangjiangze.icu/go/<roomId>?room=<code>
直连房间跳转   /go/<id> 直接 302 到 upstream（如 https://jingjiangze-stronghold-protocol.ms.show/?room=CODE），浏览器自连，无 cookie
p2p 房间跳转   /go/<id>：隧道通 → 302 到 http://127.0.0.1:<srcPort>/?room=CODE（加入方本机映射端口）；不通 → 302 到 fallback（带 &o2pfallback=1）或本机带 &o2pretry=1
p2p 房间端口   房主游戏必须跑在 3000（与返回的 dstPort 对齐）；srcPort 默认为 3000，建房可传 srcPort 指定（整数 1024–65535，否则 400）
openp2p token  开房返回的 int64 数字，别手写字符串（会被解析成 0）；直连房间 token 为 null
客户端前置     p2p 房间需要能出站 UDP（NAT 穿透依赖 UDP）；直连房间只要能访问平台即可
```

## 接口一览

所有接口都挂在平台基址下（`https://p2p.jiangjiangze.icu` 或 `https://aliyun.jiangjiangze.icu`）。以下全部实测过，返回码是 200 / 400 / 404 之一。

| 方法 | 路径 | 实测行为 |
|---|---|---|
| `POST` | `/api/room` | 房主开房。body `{hostNode, code?, srcPort?}`（或 `{upstream, code?, srcPort?}`）。返回完整房间对象（200） |
| `GET` | `/api/room/{roomId}` | 加入方拉参数，返回与开房完全相同的对象（200）；房间不存在返回 404 |
| `DELETE` | `/api/room/{roomId}` | 房主收房，返回 `{"closed":"<roomId>"}`；房间不存在返回 404 `{"error":"no such room"}` |
| `GET` | `/api/rooms` | 返回 `{"rooms":[...]}`；当前没人开房时就是空数组 |
| `GET` | `/api/health` | 返回 `{"ok":true,"rooms":0,"uptime":8983}` |
| `GET` | `/api/config` | 返回平台配置（见「平台配置」一节） |

## 开房 POST /api/room

房主调用，开一个房间并拿到连接参数。两种房间二选一：**p2p 房间**传 `hostNode`（房主自跑 openp2p 节点），**直连房间**传 `upstream`（游戏服已有公网 https 入口，平台纯 302 直连、不反代、不中转任何游戏流量，腐竹零安装）。

**请求体（p2p 房间）：**

```json
{
  "hostNode": "node_zcode_probe",
  "code": "ABCD"
}
```

**请求体（直连房间）：**

```json
{
  "upstream": "https://jingjiangze-stronghold-protocol.ms.show",
  "code": "ABCD"
}
```

- `hostNode`：**p2p 房间必填**，8–63 位，字符集 `[A-Za-z0-9._-]`。缺或太短返回 `400`，报文：
  ```json
  {"error":"hostNode required: 8-63 chars [A-Za-z0-9._-] (or pass upstream for a direct room)"}
  ```
  节点名太短是最常见的开房失败原因。
- `upstream`：**直连房间必填**（与 `hostNode` 二选一，传了 `upstream` 就忽略 `hostNode`）。必须是 https 源站（不带路径），主机名限定 `*.ms.show` / `*.modelscope.cn` / `*.jiangjiangze.icu`；其他域名返回 `400 {"error":"upstream host not allowed ..."}`，http 或带路径返回 `400 {"error":"upstream must be an https origin (no path)"}`。直连房间不 spawn openp2p 转发进程、平台不反代；开房后 `GET /go/<id>` 只对玩家浏览器发一条 302，让它**直连**到该 upstream（含 `/ws` WebSocket 也由浏览器直连，平台字节不过手）。
- `srcPort`：**可选**（p2p 房间用）。建房时指定加入方把房主游戏端口映射到自己本机的哪个端口；整数 `1024–65535`，越界或非整数返回 `400`。省略时默认为 `3000`（与 `dstPort` 对齐）。注意这是「加入方本机端口」，不是房主侧端口。
- `code`：**可选**。省略时开房仍然 200，只是返回里 `"code": null`，`joinUrl` 不带 `?room=`（实测：`https://p2p.jiangjiangze.icu/go/1b37e68a`）。
- `code` **不校验长度**：服务端最多截取前 10 位（`slice(0,10)`），传 2 位的 `"AB"` 照样 200，并原样出现在 `joinUrl` 里。所以「4 位密钥」只是约定，不是服务端约束。

**返回示例（实测原样，roomId=5f51d1ee 那次）：**

```json
{
  "roomId": "5f51d1ee",
  "kind": "p2p",
  "hostNode": "node_zcode_probe",
  "upstream": null,
  "code": "ABCD",
  "dstPort": 3000,
  "srcPort": 3000,
  "token": "1798913699555900373",
  "serverHost": "api.openp2p.cn",
  "serverPort": 27183,
  "wsPath": "/ws",
  "protocol": "tcp",
  "joinUrl": "https://p2p.jiangjiangze.icu/go/5f51d1ee?room=ABCD",
  "fallback": "https://jingjiangze-stronghold-protocol.ms.show",
  "expiresAt": "2026-10-16T00:10:26.001Z",
  "ready": true
}
```

（直连房间对应字段为 `"kind":"direct"`、`"upstream":"https://…"`、`"dstPort":null`、`"srcPort":null`、`"fallback":null`、`"token":null`；`GET /go/<id>` 直接 302 到 `upstream`。）

**字段说明：**

| 字段 | 含义 |
|---|---|
| `roomId` | 房间 ID，出现在 joinUrl、所有后续接口路径里 |
| `kind` | 房间类型：`p2p`（传 hostNode，房主自跑节点）或 `direct`（传 upstream，平台纯 302 直连、不反代） |
| `hostNode` | 房主 openp2p 节点名（p2p 房间回显；直连房间为 `null`） |
| `upstream` | 直连房间的 https 源站；p2p 房间为 `null` |
| `code` | 房间密钥；不填时为 `null` |
| `dstPort` | 房主侧游戏端口，p2p 房间固定 `3000`；直连房间为 `null` |
| `srcPort` | 加入方本机映射端口（p2p 房间使用），默认 `3000`；建房可传 `srcPort` 指定（整数 1024–65535，否则 400）；直连房间为 `null` |
| `token` | 平台下发的 openp2p token（int64 数字），客户端后续连接拿它鉴权，**不要自己生成**；直连房间为 `null` |
| `serverHost` / `serverPort` | openp2p 信令服务器 `api.openp2p.cn:27183` |
| `wsPath` | 信令 WebSocket 路径 `/ws` |
| `protocol` | 转发协议 `tcp` |
| `joinUrl` | 给玩家的零安装入口（走 `/go/<roomId>` 路径），**当前唯一可用入口**；`/go/<id>` 只发一条 302，平台不中转任何游戏流量 |
| `fallback` | p2p 房间回显的 upstream（打洞失败时 `/go/<id>` 带 `&o2pfallback=1` 回退到该游戏服）；无 fallback 时为 `null` |
| `expiresAt` | 过期时间，ISO 8601 UTC；实测开房后正好 6 小时 |
| `ready` | 房间是否就绪，`true` |

**curl 示例：**

```bash
curl -X POST https://p2p.jiangjiangze.icu/api/room \
  -H 'content-type: application/json' \
  -d '{"hostNode":"node_alice","code":"ABCD"}'
```

## 加入房间 GET /api/room/{roomId}

玩家（或任何加入方）用 roomId 拉取连接参数。返回的对象与开房时**完全相同**，所以加入方拿到的 token、hostNode、dstPort 都一致。

```bash
curl https://p2p.jiangjiangze.icu/api/room/5f51d1ee
```

房间不存在时返回 `404`，报文 `{"error":"no such room"}` —— 这不是服务器炸了，就是房间没开或已过期。

## 收房 DELETE /api/room/{roomId}

房主解散房间。

```bash
curl -X DELETE https://p2p.jiangjiangze.icu/api/room/5f51d1ee
```

成功返回 `{"closed":"5f51d1ee"}`。

> 收房不是幂等的：房间已经不存在时再删，返回的是 `404` `{"error":"no such room"}`，不是 200。所以「反复收房」不会报错累积，但也不要把它当成「一定成功」的信号——返回 404 只说明现在没这个房间了。

## 平台配置 GET /api/config

返回平台当前配置，内容和开房返回里的连接参数一致，方便客户端不依赖某次开房就能预取。

```json
{
  "serverHost": "api.openp2p.cn",
  "serverPort": 27183,
  "token": "1798913699555900373",
  "dstPort": 3000,
  "wsPath": "/ws",
  "protocol": "tcp",
  "baseDomain": "jiangjiangze.icu",
  "apexHost": "p2p.jiangjiangze.icu",
  "apexHosts": ["p2p.jiangjiangze.icu", "aliyun.jiangjiangze.icu"]
}
```

> 注意这里的 `token` 是平台级示例值，真实接入请用**开房接口**返回的 token，不要硬编码这个。

## Web 零安装入口

玩家无需安装任何东西：浏览器直接打开 `joinUrl`（形如 `https://p2p.jiangjiangze.icu/go/<roomId>?room=ABCD`）。

实测 `GET /go/<roomId>` 返回 **302**，平台**不发任何 cookie、不反代、不中转游戏流量**，只决定「玩家浏览器最终去哪」：

- **直连房间**：`location` 直接是 `upstream`（如 `https://jingjiangze-stronghold-protocol.ms.show/?room=CODE`）。玩家浏览器自己连那个公网游戏服，平台字节不过手。实测 `https://jingjiangze-stronghold-protocol.ms.show/?room=PUB1` → 200（标题「卫戍协议：盟约 · STRONGHOLD PROTOCOL」），`/ws` → `101 Switching Protocols`。
- **p2p 房间（隧道通）**：`location` 为 `http://127.0.0.1:<srcPort>/?room=CODE`（加入方自己本机的 openp2p 端口映射，默认 `srcPort=3000`）。
- **p2p 房间（隧道不通，有 fallback）**：`location` 为 `https://<upstream>/?room=CODE&o2pfallback=1`，玩家回退到游戏服自带联机服务器。
- **p2p 房间（隧道不通，无 fallback）**：`location` 为 `http://127.0.0.1:3000/?room=CODE&o2pretry=1`，提示本机重试。

> **「同一浏览器一次只能在一个房间」的限制已不适用**：v3 不再下发 cookie，`/go/<id>` 是纯 302 跳走，玩家浏览器直接连目标服。想同时开多个房间、用不同标签页/浏览器都行，互不挤占。

> 平台根路径 `/` 现在是纯文本帮助信息（实测 `grep -c '<script\|<title'` = 0，不是游戏页），不再吐游戏页面。

## 安卓 APK 接入

APK 内嵌了 openp2p 的 `openp2p.aar`，两种调用方式任选其一（依据仓内 `ANDROID.md` 接入契约）。平台基址用 `https://aliyun.jiangjiangze.icu`（与主址同平台，任选其一可达）。

**方式一：SDK 接口（推荐，非阻塞模块 API）**

```kotlin
val net = openp2p.Openp2p.runAsModule(filesDir.absolutePath, token, 0, 1) // (baseDir, token, bw, loglevel)
net.connect(30000)                                                        // boolean
net.addApp(openp2p.AppConfig().apply {                                   // 端口转发：房主:3000 -> 本机:3000
    appName = "sp"; protocol = "tcp"; peerNode = hostNode
    dstHost = "127.0.0.1"; dstPort = 3000; srcPort = 3000
})
// 关房/退出：net.deleteApp(...) / openp2p.Openp2p.stop()
```

> `AppConfig` 的字段访问器由 gomobile 生成，请对照 `openp2p-sources.jar` 校正（字段名通常为 `AppName/Protocol/PeerNode/DstHost/DstPort/SrcPort`）。

**方式二：命令串 API（最省事，必须放后台线程）**

```kotlin
Thread {
    openp2p.Openp2p.runCmd(
      "-node p-${randomId()} -token $token -appname sp -peernode $hostNode " +
      "-dstport 3000 -srcport 3000 -protocol tcp -d")
}.start()   // runCmd 会阻塞，务必放后台线程；切换房间前先 stop()
```

两种方式最后都在 WebView 打开：

```
http://127.0.0.1:3000/?room=<密钥>
```

- `token` 来自开房接口的返回，**不要硬编码**（特别是别写成字符串，见上节 int64 的坑）。
- `dstport 3000` / `srcport 3000`：房主侧游戏端口映射到本机 3000，和 Web 入口的 `127.0.0.1:3000` 对齐。这里的 `srcport 3000` 对应平台返回的 `srcPort` 默认值；建房时若通过 `POST /api/room` 传了 `srcPort`，APK 侧 `srcport` 要改成同一个值，否则映射端口对不上。
- ECS 平台侧默认 `ShareBandwidth=0`（只走信令、不中转流量）；APK 侧只要能直连即可，无需声明带宽。

## 服务端内置接入（推荐：玩家只跟服务器打交道）

游戏服务器自己就是接入方：开房时由**服务器**向平台登记，把返回的 `joinUrl` 通过 `room.state.inviteUrl` 发给房内所有人；玩家在游戏里点「复制链接」拿到的就是平台入口，点开由平台 302 决定去哪。**不需要启动器、不需要玩家装任何东西**，玩家只跟服务器打交道。

实现见游戏仓库的 `server/platform.js`，接线在 `server/lobby.js`（开房即登记、销毁即释放）与 `public/js/screens/room.js`（邀请框优先用服务端下发的链接）。

> **网页版入口（推荐先看这个）**：<https://downcdn.jiangjiangze.icu/p2p-platform> —— 整条链路图、每步拆解、三个环境变量、失败隔离表、验收命令，一页可看完，可从卡片跳转到本文与《服务器部署文档》。

**三个环境变量，都不设 = 功能关闭（行为与未接入时完全一致）：**

| 变量 | 作用 |
|---|---|
| `SP_PLATFORM_URL` | 平台基址，默认 `https://p2p.jiangjiangze.icu`；`0` / `off` 显式关闭 |
| `SP_PLATFORM_HOSTNODE` | 房主机器的 openp2p 节点名（8–63 位 `[A-Za-z0-9._-]`）。设了就走 **p2p 优先** |
| `SP_PLATFORM_UPSTREAM` | 打不穿时回退的服务器地址（https 源站）。**p2p 模式下是回退目标**；direct 模式下就是自己 |

`SP_PLATFORM_UPSTREAM` 缺省时，direct 模式会用 ModelScope 注入的 `STUDIO_HOST` / `SPACE_HOST` 推出自己的公网地址；两个都没有且 hostNode 也没设 ⇒ 整体关闭（`GET /api/platform` 返回 `{"enabled":false}`）。

**两种模式的选择**（由上面两个变量决定，同一套代码）：

- **p2p（优先）**：设了 `SP_PLATFORM_HOSTNODE` ⇒ 登记 `{hostNode, upstream, code}`。玩家点链接后，隧道通就 302 到玩家本机映射端口（p2p 直连，游戏流量不经平台）；打不穿则 302 到 `SP_PLATFORM_UPSTREAM`（服务器联机），带 `&o2pfallback=1`。
- **direct（线上 ms.show 默认）**：没设 hostNode ⇒ 登记 `{upstream, code}`。平台只发一条 302 让玩家直连本服务器，零安装、零节点。

**行为约定（都已实测）：**

- **开房即登记**：`room.create` 成功后异步 `POST /api/room`，成功后重播一次 `room.state`，其中多一个 `inviteUrl` 字段（字符串或 `null`）。solo 房不登记（没有人要邀请）。
- **销毁即释放**：`disposeRoom` 时 `DELETE /api/room/<roomId>`；释放失败也不重试，平台侧 6 小时后自行过期。
- **失败不影响开房**：平台不可达 / 超时（4 s）/ 返回非 2xx ⇒ `inviteUrl` 保持 `null`，房间照常创建与联机，前端「复制链接」回落到本地 `?room=` 链接。这条已用「平台指向死端口」实测。
- **不升协议版本**：`room.state.inviteUrl` 是纯展示字段，旧客户端会忽略未知键（`validateC2S` 跳过未知字段），`PROTOCOL_VERSION` 保持 1。
- **登记去重**：同一房间 5 分钟内重复登记复用上一次结果；并发登记只发一次请求（`pending` 去重）。
- **诊断**：`GET /api/platform` 返回 `{enabled, mode, base, upstream, hostNode, rooms, lastOkAt, lastError}`（只有计数与配置，无玩家数据）；未配置时是 `{"enabled":false}`。

### 同步到服务器（补丁包）

现成补丁包按 **`ms/master`**（线上 ModelScope 创空间实际运行的那棵树，app 0.3.0）重打过，1 个新增文件 + 5 处接线，解压覆盖后重启即可：

| 文件 | 动作 | 作用 |
|---|---|---|
| `server/platform.js` | **新增** | 接入模块：登记 / 释放 / 状态，失败隔离 |
| `server/index.js` | 改 | 启动时建实例，把诊断端点交给 HTTP 层 |
| `server/lobby.js` | 改 | 开房即登记、销毁即释放、`toState()` 多一个 `inviteUrl` |
| `server/http/routes.js` | 改 | `GET /api/platform` 诊断端点 |
| `public/js/screens/room.js` | 改 | 「复制链接」优先用服务端下发的链接 |
| `shared/protocol.js` | 改 | 注释说明 `inviteUrl` 是可选展示字段 |

```bash
unzip -o stronghold-server-platform-patch.zip -d /tmp/sp-patch
cp -a /tmp/sp-patch/server-integration-patch/. <游戏仓库>/
node --check <游戏仓库>/server/platform.js    # 无输出 = 语法 OK
# 然后重启；设不设环境变量见上一节
```

上线 ms.show（direct 模式）三个变量一个都不用设——默认基址就是主基址，direct 模式自己推出 upstream；自建机房 / VPS 想走 p2p 优先，设 `SP_PLATFORM_HOSTNODE` + `SP_PLATFORM_UPSTREAM`，房主侧另跑一个 openp2p 节点（同名 + 开房返回的 int64 token，别加引号）。

> 补丁相对 `ms/master` 是 +67 / −5 行的干净增量（包内附 `ms-platform-only.diff`）。本机在干净基座上实测：能启动、冒烟 30/30、eslint 0 error（仅 2 条 warning 与 `ms/master` 原版逐字相同，非补丁引入）。



---

# 第二部分 · 给腐竹 / 房主安装看（人话、逐步）

一句话说清联机模型：游戏本体**没有**任何 P2P、也没有对外开房 API；异地联机完全靠 openp2p 平台。两种玩法：

- **p2p 房间**（方案 A/B）：平台把「房主电脑上的 3000 端口」映射到「每个玩家自己电脑的 3000 端口」，腐竹要**① 本机起游戏服（绑 3000）→ ② 本机跑一个 openp2p 节点（同一个 token）→ ③ 开房拿到 joinUrl 发群里**。
- **直连房间**（方案 C）：游戏服挂云端（魔搭），本身有公网入口——腐竹**只发一条开房命令**告诉平台游戏服地址，平台只对玩家发一条 302 让他直连魔搭，**零安装零节点、平台不中转流量**。

两种房间的玩家体验完全一致：点 `joinUrl` 零安装进房。

下面给三种方案，按省事程度从难到易：

| 方案 | 适合谁 | 难度 | 说明 |
|---|---|---|---|
| A · 本地手动装 | 想完全自己掌控、Linux 服 / VPS 房主 | 中 | 全程命令行，最通用；数据 p2p 直连不过服务器 |
| B · Windows 启动器 | 纯 Windows、不想碰命令行 | 易 | 双击即用，内置 openp2p、自动下游戏；数据 p2p 直连 |
| C · 云端 + 直连房间 | 不想装任何东西、想挂云端 | **最易** | 魔搭 Docker 部署 + 一条开房命令，腐竹零安装零节点；流量不经平台（玩家浏览器按 302 直连魔搭） |

## 方案 A · 本地手动装（Windows / Linux，最详细）

按下面 1→5 顺序做，全程实测可跑通。

### 1) 装 openp2p v3.25.11

下载基址：`https://github.com/openp2p-cn/openp2p/releases/tag/v3.25.11`

- **Windows**：资产名 `openp2p-3.25.11.windows-amd64.zip`，解压出来就是单个 `openp2p.exe`。
- **Linux**：资产名 `openp2p-3.25.11.linux-amd64.tar.gz`，解压出来就是单个 `openp2p` 二进制。
- 还有 `darwin` / `android` 等平台的资产，按需取。

```bash
# Windows（PowerShell，解压出 openp2p.exe 放到某目录，例如 D:\openp2p\）
# 下载 openp2p-3.25.11.windows-amd64.zip 后：
Expand-Archive openp2p-3.25.11.windows-amd64.zip -DestinationPath D:\openp2p

# Linux
curl -fsSL -o o2p.tar.gz https://github.com/openp2p-cn/openp2p/releases/tag/v3.25.11/download/openp2p-3.25.11.linux-amd64.tar.gz
tar -xzf o2p.tar.gz                 # 解出单个 openp2p 二进制
sudo install openp2p /usr/local/bin/openp2p
```

`openp2p install` 子命令会把二进制装成**系统服务**并以后台守护方式启动（Windows = Windows 服务，Linux = systemd 服务）；不带参数直接跑则是前台 / 后台守护运行。本方案第 4 步就用 `install`。

### 2) 装 Node.js ≥ 22

游戏 `package.json` 写死 `"engines": {"node": ">=22"}`，低于 22 起不来。

- **Windows**：
  - 官网 <https://nodejs.org> 下 LTS 装（选 22 或 24）；
  - 或 Chocolatey：`choco install nodejs`（装完 `node -v` 确认 ≥ 22）。
- **Linux**：
  - 推荐 `nvm`：`nvm install 22 && nvm use 22`；
  - 或发行版包管理器 `apt install nodejs`（**注意**：很多发行版仓库里的 node 还是 18/20，务必 `node -v` 确认 ≥ 22，不够就走 nvm 或 NodeSource 源）。

### 3) 拿到游戏源码并起服（必须绑 3000）

游戏本体来自上游 `sganggs/Stronghold-Protocol`（当前 v0.3.0）：

```bash
git clone https://github.com/sganggs/Stronghold-Protocol.git
cd Stronghold-Protocol
npm install
node server/index.js          # 默认 PORT=3000，HOST='::'（IPv6 双栈，绑不上自动回退 IPv4）
```

起服后浏览器访问 `http://127.0.0.1:3000/?room=<4位同盟密钥>` 即可进游戏；游戏在启动时会读并消费 `?room=` 查询串自动加入对应房间。游戏 WS 在 `/ws`，`/healthz` 返回 JSON 健康检查。

> **端口必须 3000**：游戏默认 `PORT=3000`，与开房返回的 `dstPort:3000` 对齐。房主的游戏服务**必须跑在 3000**，否则玩家映射过去端口对不上。改了 `PORT` 就得用别的办法对端口，别默认它能对上。

### 4) 装 openp2p 节点（先把第 5 步的 token 准备好）

先把 openp2p 装成系统服务并以后台守护跑起来。**这一步的 token 是高频踩坑点**：

- 实操顺序：先跳到第 5 步 `POST /api/room` 开房，从返回里抄出 `token`（纯数字）和你的 `hostNode`，**再回来执行这里的 `install`**——因为节点的 token 就是开房接口下发的那个。
- `-token` 必须是**纯数字 int64**（形如 `1798913699555900373`），**绝不能加引号**——openp2p 的 token 是 `uint64`，加了引号会被解析成 `0`，`if token == 0` 直接跳过登录、连不上。
- 这个 token **不是你自己编的**，是「开房接口返回的」那个 `token` 字段（见 §开房）。
- `-node` 就是你在开房时填的 `hostNode`，要满足 8–63 位、`[A-Za-z0-9._-]`。

```bash
# 先开房拿到 token（见第 5 步），再把返回的 token 原样填进这里，注意无引号、纯数字
openp2p install -node <你的节点名> -token <开房返回的int64数字，无引号> -sharebandwidth 20
```

`-sharebandwidth 20` 是节点侧声明的共享带宽上限（MB），有利于直连；它**不影响平台侧默认行为**（见末尾提醒）。

### 5) 开房并把链接发出去

```bash
curl -X POST https://p2p.jiangjiangze.icu/api/room \
  -H 'content-type: application/json' \
  -d '{"hostNode":"<你的节点名>","code":"ABCD"}'
```

把返回里的 `joinUrl`（`https://p2p.jiangjiangze.icu/go/<roomId>?room=ABCD`）发给玩家即可。玩家点开就是零安装进房。

### 腐竹 10 分钟开服清单（串起来）

1. 下载 openp2p v3.25.11（Windows 解压出 `openp2p.exe` / Linux 解压出 `openp2p` 二进制），放到 `PATH` 或固定目录。
2. 确认 `node -v` ≥ 22；不够就装。
3. `git clone` 游戏本体 → `npm install` → `node server/index.js`（确认 `http://127.0.0.1:3000` 能开）。
4. `curl POST /api/room` 开房，从返回里抄出 `token`（纯数字）和 `joinUrl`。
5. `openp2p install -node <节点名> -token <第4步抄的纯数字token，无引号> -sharebandwidth 20`（Windows 装成服务、Linux 装成 systemd）。
6. 把 `joinUrl` 发群里；过期（6h）就重开重发。

## 方案 B · Windows 启动器（makise2，最省事）

**GitHub：** <https://github.com/makise2/stronghold-protocol-launcher>（当前 v1.2.6，C# / .NET Framework 4.8，单文件 exe 约 524 KB，Windows 10/11）

这个启动器把「组网 + 开房 + 下载游戏本体」全包进一个 exe，**不想碰命令行的腐竹首选**：

- 内置 openp2p 引擎，开房即自动打通隧道（不需要管理员权限、不装虚拟网卡/驱动）。
- 没装过游戏本体的玩家，启动器直接从原作者官方 Release 下载（断点续传、自动切镜像），解压校验通过才替换。
- 断线自愈、整族清理残留引擎、环境自检（缺 Node.js 弹框引导）、日志自动给 token 打码。
- token 获取顺序：`启动器配置.txt` 里的 `o2ptoken=` 行 → 本机装过 OPL 则借用其 `bin\config.json` 的 `Token` → 都没有首次弹框让用户粘一次。**一般不用手填**。
- 房主 spawn 参数（启动器内部调用）：`-d -loglevel 1 -node <MyO2PNode> -token <tk> -sharebandwidth 20`。

用法：下载 Release 里的 zip 解压 → 双击 `卫戍协议启动器.exe` → 房主点「开房并复制邀请」→ 把内容粘到群里；朋友点「加入朋友的房间」粘贴即进。想自己开房的人需要游戏本体 + Node.js（启动器设置页可一键下载游戏本体、Node 用便携版或自装）。

> 这是 Windows 专属方案；非 Windows 房主请走方案 A 或 C。

## 方案 C · 云端部署 + 直连房间（魔搭 / ModelScope 创空间，腐竹零安装）

不想本机装 Node、想把游戏服挂云端的腐竹，走 **魔搭（ModelScope）创空间 Docker 部署**：对外只暴露一个端口 **7860**，配套仓库已写好零叠加层最简 Dockerfile，素材直接走 CDN 绝对地址、不过容器。

部署完之后，联机这一步**比方案 A/B 更省**——不用装 openp2p、不用跑节点、不用开端口转发：

**为什么腐竹什么都不用装**：魔搭容器跑不了 openp2p 节点（无 systemd/root、端口锁 7860），但它自带公网 HTTPS 入口（`https://<你的创空间>.ms.show`，WAF 对浏览器 UA 放行）。所以平台支持一种**「直连房间」**：腐竹只调一次开房接口，把魔搭地址告诉平台；平台从此只对 `p2p.jiangjiangze.icu/go/<id>` 的玩家发一条 **302**，让玩家浏览器**直连**到那个地址（含 WebSocket 也由浏览器直连）。平台不反代、不中转任何游戏字节——打洞都不需要，魔搭本来就有公网入口。

**腐竹的全部操作（一条命令）：**

```bash
curl -X POST https://p2p.jiangjiangze.icu/api/room \
  -H 'content-type: application/json' \
  -d '{"upstream":"https://jingjiangze-stronghold-protocol.ms.show","code":"ABCD"}'
```

- `upstream`：游戏服的 **https 源站**（只允许 `*.ms.show` / `*.modelscope.cn` / `*.jiangjiangze.icu`，不带路径；其他域名返回 400）。
- 返回里的 `kind` 是 `"direct"`、`token` 为 `null`（不需要 openp2p 鉴权）、`joinUrl` 照常生成——把 `joinUrl` 发给玩家即可，玩家侧体验与 p2p 房间完全一致。
- 房间照旧 **6 小时过期**；`DELETE /api/room/{id}` 收房。

**实测链路（2026-10-17 全部通过）**：`POST /api/room {"upstream":"https://jingjiangze-stronghold-protocol.ms.show","code":"MST2"}` → 200，`"kind":"direct"`, `"token":null`，`"joinUrl":"https://p2p.jiangjiangze.icu/go/<id>?room=MST2"`；`GET /go/<id>` → `302 Found`，`location: https://jingjiangze-stronghold-protocol.ms.show/?room=MST2`，**无 set-cookie**；目标站实测可用（`/?room=PUB1` → 200 标题「卫戍协议：盟约」，'/ws' → 101 Switching Protocols）；本机经 CF 隧道打公共入口 → 302 + location ms.show + `CF-RAY` 头，平台根路径只有纯文本、没有任何 `<script>/<title>`。

> 取舍：**直连房间的游戏流量完全不经平台、不经 ECS 中转**——玩家浏览器按 302 直连魔搭，平台只发跳转、字节不过手。素材字节仍由浏览器直连 CDN；游戏会话字节走魔搭公网入口（受魔搭自身额度约束，与阿里云 ECS 出口无关，见 server-deploy.md 的量级估算）。相比方案 A/B「数据不过服务器」，直连房间用「玩家浏览器直连」换腐竹的零安装，平台零带宽开销。魔搭 WAF 对浏览器 UA 放行，玩家直连时无感。

完整部署步骤（准备什么、怎么建创空间、零域名·零叠加层最简 Dockerfile、怎么验收）见姊妹文档： [./server-deploy.md](./server-deploy.md)

## 房主侧通用提醒

- **两种房间的约束不同**：p2p 房间（方案 A/B）要求数据 p2p 直连——**游戏端口必须 3000**、客户端要能**出站 UDP**（NAT 穿透依赖 UDP，公司网常封 27183 信令端口）；直连房间（方案 C）只要游戏服有公网 https 入口即可，上述两条都不适用，且游戏流量由玩家浏览器按 302 直连、不经平台、不经 ECS 中转。
- **ECS 默认 `ShareBandwidth=0`**：平台 v3 是「仅握手」模式——**任何房间都不吃 ECS 流量（信令除外）**，p2p 房间平台侧只走信令、不中转字节，省下阿里云约 18G/月的出口额度；有 p2p 直连能力时数据不经过服务器。你本地 `-sharebandwidth 20` 是节点侧声明，不影响平台侧的默认行为。直连房间玩家浏览器直连魔搭，完全不经过 ECS。
- **p2p 打不穿时的回退语义**：p2p 隧道建立失败时，`/go/<id>` 会带 `&o2pfallback=1` 回退到游戏服自带的联机服务器（建房时填的 `fallback` / `upstream`）。但**对局状态存在游戏服内存里、不能迁移**——回退不是无缝续上，而是「所有人用同一个 code 重新开一局」。这是 v3 仅握手的固有限制，房主发链接时应提醒玩家：打洞失败要重开，不是接着打。
- **`srcPort` 端口**：p2p 房间返回 `srcPort`（默认 3000），是「加入方本机映射端口」；建房可传 `srcPort` 指定（整数 1024–65535，否则 400）。APK 侧 `srcport` 要与它一致，否则映射对不上。
- **房间 6 小时过期**：过期后 `GET /api/room/{id}` 会 404，玩家链接失效，需房主重新开房重发。

---

## 注意事项

合并两版共同的坑，接人和写程序都要注意：

- **房间 6 小时过期**：`expiresAt` 是 ISO 8601 UTC，实测开房后正好 6.00 小时。过期后 `GET /api/room/{roomId}` 会 404，玩家链接失效，需房主重新开房。
- **`hostNode` 有硬校验**：8–63 位、`[A-Za-z0-9._-]`；不满足直接 400。这是最常见的报错来源。
- **`upstream` 只收白名单域名**：`*.ms.show` / `*.modelscope.cn` / `*.jiangjiangze.icu`，https 源站不带路径；其他域名 / http / 带路径都 400。
- **`code` 很宽松**：可省略、长度不限（服务端最多截 10 位），只是约定 4 位，服务端不强制。
- **`srcPort` 可选**：p2p 房间建房可传（整数 1024–65535，否则 400），指定「加入方本机映射端口」；省略默认 3000。直连房间没有此字段（返回 `null`）。
- **ECS 默认 `ShareBandwidth=0`**：平台 v3 是「仅握手」——**任何房间都不吃 ECS 流量（信令除外）**。p2p 房间只走信令不中转，省阿里云约 18G/月出口；有 p2p 直连时数据不过服务器；直连房间玩家浏览器按 302 直连魔搭，游戏字节完全不经 ECS。
- **`token` 是 int64 数字，不是字符串**：由平台 API 下发，客户端不要自己造；传给 openp2p CLI 时**绝不能加引号**（加了被解析成 0、登录失败）。这是最高频踩坑点。直连房间 `token` 为 `null`，无需 openp2p。
- p2p 房间客户端需要能**出站 UDP**（openp2p 的 NAT 穿透依赖 UDP），否则无法建立直连；直连房间不需要 UDP，只要能访问平台。
- **v3 不再下发 cookie，无「单浏览器单房间」限制**：`/go/<id>` 是纯 302 跳走到目标服，可同时开多个房间、不同标签页/浏览器互不挤占。平台根路径 `/` 现为纯文本帮助信息，不是游戏页。
- **p2p 打不穿 → 回退游戏服自带联机，但状态不迁移**：隧道失败时 `/go/<id>` 带 `&o2pfallback=1` 回退到建房时填的 `fallback`/`upstream`（无 fallback 则 `&o2pretry=1` 回本机重试）。对局状态在游戏服内存里、无法迁移，所以回退是「所有人用同一 code 重新开一局」，不是无缝续上。发链接时应提醒玩家。
