# openp2p 异地联机 P2P 平台

把 openp2p 用作游戏《卫戍协议：盟约》的异地联机组网。端口转发模型：把房主的本地 3000 端口映射到每个玩家自己的本地 / 入口，玩家在本地访问 `127.0.0.1:3000` 即等同于访问房主机房里的同一端口。平台跑在阿里云 ECS 上，对外经 Cloudflare 隧道暴露，玩家只要能出站 UDP 即可，无需公网 IP。

下面这块复制给调用方就够了；想接服务器直接看「房主怎么接入服务器」一节。

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
- `code` **不校验长度**：传 2 位的 `"AB"` 照样 200，并原样出现在 `joinUrl` 里。所以「4 位密钥」只是约定，不是服务端约束。

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

## Web 零安装入口

玩家无需安装任何东西：浏览器直接打开 `joinUrl`（形如 `https://p2p.jiangjiangze.icu/go/<roomId>?room=ABCD`）。

实测 `GET /go/<roomId>` 返回 **302**，`location` 是个**相对路径** `/?room=ABCD`（带 room 查询串），平台下发 cookie 后跳进游戏。

> **同一浏览器一次只能在一个房间里**：cookie 按浏览器维度下发，不按标签页。开着 A 房间再开 B 房间，前面的会被挤掉。

**`joinUrlHost` 是死链，别用。** 它形如 `https://<roomId>.jiangjiangze.icu/`（例如 `https://5f51d1ee.jiangjiangze.icu/`），但 `<roomId>.jiangjiangze.icu` 这个子域名**当前没有 DNS 记录、实测解析不到任何地址**，所以 `joinUrlHost` 现在点不开。能用的只有 `joinUrl`（走 `/go/<roomId>` 那条路径）。

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

## 房主怎么接入服务器

这是「怎么把我的服务器接进来」的核心步骤。按顺序做：

**1) 装 openp2p 节点**

```bash
openp2p install -node <节点名> -token <token> -sharebandwidth 20
```

- `-node <节点名>` 就是开房时填的 `hostNode`，要满足 8–63 位、`[A-Za-z0-9._-]`。
- `-token` **必须是 JSON 数字 int64**（形如 `1798913699555900373`）。**写成字符串会被解析成 0，login 直接失败**——别给 token 加引号。
- `-sharebandwidth 20` 是共享带宽上限（MB）。

**2) 起游戏服务，必须绑在 3000 端口**

游戏服务端默认就听在 3000（`PORT` 环境变量默认 3000，`HOST` 默认 `'::'`，IPv6 双栈、绑不上自动回退 IPv4）。

这跟开房返回的 `dstPort: 3000` 对得上——房主的游戏服务**必须跑在 3000**，否则玩家映射过去端口对不上。改了 `PORT` 就得用别的办法对端口，别默认它能对上。

**3) 开房并把链接发出去**

```bash
curl -X POST https://p2p.jiangjiangze.icu/api/room \
  -H 'content-type: application/json' \
  -d '{"hostNode":"<你的节点名>","code":"ABCD"}'
```

把返回里的 `joinUrl`（`https://p2p.jiangjiangze.icu/go/<roomId>?room=ABCD`）发给玩家即可。

> **ECS 默认 `ShareBandwidth=0`**：只走信令、不中转流量，省下阿里云约 18G/月的出口额度；有 p2p 直连能力时数据不经过服务器。你本地 `-sharebandwidth 20` 是节点侧声明，不影响平台侧的默认行为。

## 安卓 APK 接入

APK 内嵌了 openp2p 的 `openp2p.aar`，两种调用方式任选其一（依据仓内 `jingjiangze/otg-drive-bridge` 相关审计）。

**方式一：SDK 接口（推荐）**

```java
Openp2p.runAsModule(baseDir, token, 0, 1);
P2PNetwork.connect(30000);
// 把房主 :3000 映射到本机 :3000
P2PNetwork.addApp("房主节点名:3000->本机:3000");
```

**方式二：命令行（后台线程调用）**

```java
Openp2p.runCmd("-node … -token … -peernode … -dstport 3000 -srcport 3000");
```

两种方式最后都在 WebView 打开：

```
http://127.0.0.1:3000/?room=<密钥>
```

- `token` 来自开房接口的返回，**不要硬编码**（特别是别写成字符串，见上节 int64 的坑）。
- `dstport 3000` / `srcport 3000`：房主侧游戏端口映射到本机 3000，和 Web 入口的 `127.0.0.1:3000` 对齐。

## 注意事项

- **房间 6 小时过期**：`expiresAt` 是 ISO 8601 UTC，实测开房后正好 6.00 小时。过期后 `GET /api/room/{roomId}` 会 404，玩家链接失效，需房主重新开房。
- **`hostNode` 有硬校验**：8–63 位、`[A-Za-z0-9._-]`；不满足直接 400。这是最常见的报错来源。
- **`code` 很宽松**：可省略、长度不限，只是约定 4 位，服务端不强制。
- **`joinUrlHost` 当前不可用的死链**：子域名无 DNS，别用它；只用 `joinUrl`。
- **ECS 默认 `ShareBandwidth=0`**：只走信令不中转，省阿里云约 18G/月出口；有 p2p 直连时数据不过服务器。
- `token` 由平台 API 下发，客户端不要自己造，且必须是 int64 数字而非字符串。
- 客户端需要能**出站 UDP**（openp2p 的 NAT 穿透依赖 UDP），否则无法建立直连。
- 零安装 Web 入口同一浏览器一次只能在一个房间（cookie 按浏览器维度）。
