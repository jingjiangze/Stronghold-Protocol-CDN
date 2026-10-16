# openp2p 异地联机 P2P 平台

> 非官方同人作品，仅供学习交流。素材版权归 Hypergryph / Yostar 所有。

把 openp2p 用作游戏《卫戍协议：盟约》的异地联机组网。端口转发模型：把房主的本地 3000 端口映射到每个玩家自己的本地 / 入口，玩家在本地访问 `127.0.0.1:3000` 即等同于访问房主机房里的同一端口。平台跑在阿里云 ECS 上，对外经 Cloudflare 隧道暴露，玩家只要能出站 UDP 即可，无需公网 IP。

本文分两部分：

- **第一部分 · 给 Agent / 程序接入看**：接口字段、返回结构、接入契约，复制顶部代码块给 agent 即可干活。
- **第二部分 · 给腐竹 / 房主安装看**：房主怎么把服务器接进来的逐步人话教程，含三种方案（本地手动装 / Windows 启动器 / Docker 云部署）。

---

# 第一部分 · 给 Agent / 程序接入看

下面这块复制给调用方就够了；想接服务器直接看「第二部分 · 房主怎么接入」。

```
平台主址       https://p2p.jiangjiangze.icu
平台备址       https://aliyun.jiangjiangze.icu
房间时效       开房后 6 小时过期（expiresAt 是 ISO 8601 UTC）
hostNode 规则  8–63 位，字符集 [A-Za-z0-9._-]，缺/太短直接 400
code 规则      可选，不校验长度（传 2 位也行）；不填返回 null
可用入口       joinUrl = https://p2p.jiangjiangze.icu/go/<roomId>?room=<code>
不可用入口     joinUrlHost = https://<roomId>.jiangjiangze.icu/ —— 该子域名当前无 DNS，是死链
房主游戏端口   必须跑在 3000（与返回的 dstPort 对齐）
openp2p token  开房返回的 int64 数字，别手写字符串（会被解析成 0）
客户端前置     需要能出站 UDP（NAT 穿透依赖 UDP）
```

## 接口一览

所有接口都挂在平台基址下（`https://p2p.jiangjiangze.icu` 或 `https://aliyun.jiangjiangze.icu`）。以下全部实测过，返回码是 200 / 400 / 404 之一。

| 方法 | 路径 | 实测行为 |
|---|---|---|
| `POST` | `/api/room` | 房主开房。body `{hostNode, code?}`。返回完整房间对象（200） |
| `GET` | `/api/room/{roomId}` | 加入方拉参数，返回与开房完全相同的对象（200）；房间不存在返回 404 |
| `DELETE` | `/api/room/{roomId}` | 房主收房，返回 `{"closed":"<roomId>"}`；房间不存在返回 404 `{"error":"no such room"}` |
| `GET` | `/api/rooms` | 返回 `{"rooms":[...]}`；当前没人开房时就是空数组 |
| `GET` | `/api/health` | 返回 `{"ok":true,"rooms":0,"uptime":8983}` |
| `GET` | `/api/config` | 返回平台配置（见「平台配置」一节） |

## 开房 POST /api/room

房主调用，开一个房间并拿到连接参数与 token。

**请求体：**

```json
{
  "hostNode": "node_zcode_probe",
  "code": "ABCD"
}
```

- `hostNode`：**必填**，8–63 位，字符集 `[A-Za-z0-9._-]`。缺或太短返回 `400`，报文：
  ```json
  {"error":"hostNode required: 8-63 chars [A-Za-z0-9._-]"}
  ```
  节点名太短是最常见的开房失败原因。
- `code`：**可选**。省略时开房仍然 200，只是返回里 `"code": null`，`joinUrl` 不带 `?room=`（实测：`https://p2p.jiangjiangze.icu/go/1b37e68a`）。
- `code` **不校验长度**：服务端最多截取前 10 位（`slice(0,10)`），传 2 位的 `"AB"` 照样 200，并原样出现在 `joinUrl` 里。所以「4 位密钥」只是约定，不是服务端约束。

**返回示例（实测原样，roomId=5f51d1ee 那次）：**

```json
{
  "roomId": "5f51d1ee",
  "hostNode": "node_zcode_probe",
  "code": "ABCD",
  "dstPort": 3000,
  "token": "1798913699555900373",
  "serverHost": "api.openp2p.cn",
  "serverPort": 27183,
  "wsPath": "/ws",
  "protocol": "tcp",
  "joinUrl": "https://p2p.jiangjiangze.icu/go/5f51d1ee?room=ABCD",
  "joinUrlHost": "https://5f51d1ee.jiangjiangze.icu/?room=ABCD",
  "expiresAt": "2026-10-16T00:10:26.001Z",
  "ready": true
}
```

**字段说明：**

| 字段 | 含义 |
|---|---|
| `roomId` | 房间 ID，出现在 joinUrl、joinUrlHost、所有后续接口路径里 |
| `hostNode` | 房主 openp2p 节点名（就是开房时传的那个，已原样回显） |
| `code` | 房间密钥；不填时为 `null` |
| `dstPort` | 房主侧游戏端口，固定 `3000` |
| `token` | 平台下发的 openp2p token（int64 数字），客户端后续连接拿它鉴权，**不要自己生成** |
| `serverHost` / `serverPort` | openp2p 信令服务器 `api.openp2p.cn:27183` |
| `wsPath` | 信令 WebSocket 路径 `/ws` |
| `protocol` | 转发协议 `tcp` |
| `joinUrl` | 给玩家的零安装入口（走 `/go/<roomId>` 路径），**当前唯一可用入口** |
| `joinUrlHost` | 形如 `https://<roomId>.jiangjiangze.icu/`，**当前子域名无 DNS 记录、实测不存在，不可用** |
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

实测 `GET /go/<roomId>` 返回 **302**，`location` 是个**相对路径** `/?room=ABCD`（带 room 查询串），平台下发 cookie 后跳进游戏。

> **同一浏览器一次只能在一个房间里**：cookie 按浏览器维度下发，不按标签页。开着 A 房间再开 B 房间，前面的会被挤掉。

**`joinUrlHost` 是死链，别用。** 它形如 `https://<roomId>.jiangjiangze.icu/`（例如 `https://5f51d1ee.jiangjiangze.icu/`），但 `<roomId>.jiangjiangze.icu` 这个子域名**当前没有 DNS 记录、实测解析不到任何地址**，所以 `joinUrlHost` 现在点不开。能用的只有 `joinUrl`（走 `/go/<roomId>` 那条路径）。

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
- `dstport 3000` / `srcport 3000`：房主侧游戏端口映射到本机 3000，和 Web 入口的 `127.0.0.1:3000` 对齐。
- ECS 平台侧默认 `ShareBandwidth=0`（只走信令、不中转流量）；APK 侧只要能直连即可，无需声明带宽。

---

# 第二部分 · 给腐竹 / 房主安装看（人话、逐步）

一句话说清联机模型：游戏本体**没有**任何 P2P、也没有对外开房 API；异地联机完全靠 openp2p 平台把「房主电脑上的 3000 端口」映射到「每个玩家自己电脑的 3000 端口」。所以腐竹要做的事就三件——**① 本机起游戏服（绑 3000）→ ② 本机跑一个 openp2p 节点（同一个 token）→ ③ 开房拿到 joinUrl 发群里**。玩家点链接零安装进房。

下面给三种方案，按省事程度从难到易：

| 方案 | 适合谁 | 难度 | 说明 |
|---|---|---|---|
| A · 本地手动装 | 想完全自己掌控、Linux 服 / VPS 房主 | 中 | 全程命令行，最通用 |
| B · Windows 启动器 | 纯 Windows、不想碰命令行 | 易 | 双击即用，内置 openp2p、自动下游戏 |
| C · Docker / 云部署 | 不想本机装 Node、想挂云端 | 中 | 走 ModelScope Docker，端口 7860 |

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

## 方案 C · 云端部署（魔搭 / ModelScope 创空间，server-deploy.md）

不想本机装 Node、想把游戏服挂到云端的腐竹，走 **魔搭（ModelScope）创空间 Docker 部署**：对外只暴露一个端口 **7860**，配套仓库已写好零叠加层最简 Dockerfile，素材直接走 CDN 绝对地址、不过容器。

> 关键点：无论游戏服跑在你本机（方案 A）、Windows 启动器（方案 B）还是这台魔搭云端容器（方案 C），**openp2p 节点都必须装在「跑游戏服的那台机器」上**，并把那台机器的 3000 端口（云端是容器内的 3000）暴露给平台。也就是说：云端部署只解决「服务器在哪跑」，联机这一步仍然回到本页第一部分——在那台服务器上 `openp2p install -node <节点名> -token <int64> -sharebandwidth 20` 并 `POST /api/room` 开房，再把 `joinUrl` 发出去。

完整步骤（准备什么、怎么建创空间、零域名·零叠加层最简 Dockerfile、怎么验收）见姊妹文档： [./server-deploy.md](./server-deploy.md)

## 房主侧通用提醒

- **ECS 默认 `ShareBandwidth=0`**：平台侧只走信令、不中转流量，省下阿里云约 18G/月的出口额度；有 p2p 直连能力时数据不经过服务器。你本地 `-sharebandwidth 20` 是节点侧声明，不影响平台侧的默认行为。
- **游戏端口必须 3000**：与 `dstPort:3000` 对齐，否则玩家映射端口对不上。
- **客户端需要能出站 UDP**：openp2p 的 NAT 穿透依赖 UDP（公司网常封 27183 信令端口），封了就打不通。
- **房间 6 小时过期**：过期后 `GET /api/room/{id}` 会 404，玩家链接失效，需房主重新开房重发。

---

## 注意事项

合并两版共同的坑，接人和写程序都要注意：

- **房间 6 小时过期**：`expiresAt` 是 ISO 8601 UTC，实测开房后正好 6.00 小时。过期后 `GET /api/room/{roomId}` 会 404，玩家链接失效，需房主重新开房。
- **`hostNode` 有硬校验**：8–63 位、`[A-Za-z0-9._-]`；不满足直接 400。这是最常见的报错来源。
- **`code` 很宽松**：可省略、长度不限（服务端最多截 10 位），只是约定 4 位，服务端不强制。
- **`joinUrlHost` 当前不可用的死链**：子域名无 DNS，别用它；只用 `joinUrl`。
- **ECS 默认 `ShareBandwidth=0`**：只走信令不中转，省阿里云约 18G/月出口；有 p2p 直连时数据不过服务器。
- **`token` 是 int64 数字，不是字符串**：由平台 API 下发，客户端不要自己造；传给 openp2p CLI 时**绝不能加引号**（加了被解析成 0、登录失败）。这是最高频踩坑点。
- 客户端需要能**出站 UDP**（openp2p 的 NAT 穿透依赖 UDP），否则无法建立直连。
- 零安装 Web 入口同一浏览器一次只能在一个房间（cookie 按浏览器维度）。
