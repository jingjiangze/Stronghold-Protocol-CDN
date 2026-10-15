# openp2p 异地联机 P2P 平台

把 openp2p 用作游戏《卫戍协议：盟约》的异地联机组网。端口转发模型：把房主的本地 3000 端口映射到每个玩家自己的本地 / 入口，玩家在本地访问 `127.0.0.1:3000` 即等同于访问房主机房里的同一端口。

## 平台基址

| 地址 | 说明 |
|---|---|
| `https://p2p.jiangjiangze.icu` | 主基址（推荐） |
| `https://aliyun.jiangjiangze.icu` | 备用基址 |

平台跑在阿里云 ECS 上，对外经 Cloudflare 隧道暴露。客户端只要能出站 UDP 即可，无需公网 IP。

## 快速接入 API

所有接口都挂在平台基址下。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/room` | 房主开房，返回连接参数与 token |
| `GET` | `/api/room/{roomId}` | 加入方拉取连接参数 |
| `DELETE` | `/api/room/{roomId}` | 房主收房（解散房间） |
| `GET` | `/api/rooms` | 列出当前房间 |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/config` | 平台配置 |

### 开房（`POST /api/room`）

请求体：

```json
{
  "hostNode": "<房主 openp2p 节点名>",
  "code": "ABCD"
}
```

返回示例：

```json
{
  "roomId": "<房间ID>",
  "hostNode": "<房主 openp2p 节点名>",
  "code": "ABCD",
  "dstPort": 3000,
  "token": "<平台下发的 token>",
  "serverHost": "api.openp2p.cn",
  "serverPort": 27183,
  "wsPath": "/ws",
  "protocol": "tcp",
  "joinUrl": "https://p2p.jiangjiangze.icu/go/<roomId>?room=ABCD",
  "joinUrlHost": "https://p2p.jiangjiangze.icu",
  "expiresAt": "<过期时间>",
  "ready": true
}
```

- `dstPort` 固定为 `3000`（游戏房主端口）。
- `token` 由平台下发，客户端后续所有连接都拿它鉴权，不要自己生成。
- `serverHost` / `serverPort` 是 openp2p 信令服务器（`api.openp2p.cn:27183`）。
- `joinUrl` 是给玩家用的零安装入口（见下）。

### curl 示例

开房：

```bash
curl -X POST https://p2p.jiangjiangze.icu/api/room \
  -H 'content-type: application/json' \
  -d '{"hostNode":"node_alice","code":"ABCD"}'
```

加入方拉参数：

```bash
curl https://p2p.jiangjiangze.icu/api/room/<roomId>
```

收房：

```bash
curl -X DELETE https://p2p.jiangjiangze.icu/api/room/<roomId>
```

## Web 零安装入口

玩家无需安装任何东西：浏览器直接打开 `joinUrl`（形如 `https://p2p.jiangjiangze.icu/go/<roomId>?room=ABCD`）。

平台下发 cookie 后 302 跳进游戏。限制：**同一浏览器一次只能在一个房间里**（cookie 按浏览器维度，不按标签页）。

## 安卓 APK 接入

APK 内嵌了 openp2p 的 `openp2p.aar`，两种调用方式任选其一。

**方式一：SDK 接口（推荐）**

```java
Openp2p.runAsModule(baseDir, token, 0, 1);
P2PNetwork.connect(30000);
// 把房主 :3000 映射到本机 :3000
P2PNetwork.addApp("房主节点名:3000->本机:3000");
```

随后在 WebView 里打开：

```
http://127.0.0.1:3000/?room=<4位密钥>
```

**方式二：命令行（后台线程调用）**

```java
Openp2p.runCmd("-node … -token … -peernode … -dstport 3000 -srcport 3000");
```

随后同样用 WebView 打开 `http://127.0.0.1:3000/?room=<4位密钥>`。

- `token` 来自开房接口的返回，不要硬编码。
- `dstport 3000` / `srcport 3000`：房主侧游戏端口映射到本机 3000。

## 房主侧

房主先在机器上安装 openp2p 节点并共享带宽：

```bash
openp2p install -node <节点名> -token <token> -sharebandwidth 20
```

再调用 `POST /api/room` 开房，把返回的 `joinUrl` 发给玩家。

## 注意事项

- **ECS 默认 `ShareBandwidth=0`**：只走信令、不中转流量，省下阿里云约 18G/月的出口额度；有 p2p 直连能力时数据不经过服务器。
- `token` 由平台 API 下发，客户端不要自己造。
- 客户端需要能**出站 UDP**（openp2p 的 NAT 穿透依赖 UDP），否则无法建立直连。
- 零安装 Web 入口同一浏览器一次一个房间。
