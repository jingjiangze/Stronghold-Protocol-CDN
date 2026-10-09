# 让上游服务器部署包用 CDN 发素材（Stronghold-Protocol-CDN drop-in）

适用：上游 [`sganggs/Stronghold-Protocol`](https://github.com/sganggs/Stronghold-Protocol) 的
**服务器部署包**（完整包 `Stronghold-Protocol-v__SP_UPSTREAM_TAG__.zip` 或精简包 + `npm run setup`）。
目标：把约 460 MB 美术素材从"部署机自己发"改成"从 CDN 发"，同时**不修改部署包里的任何文件**。

- 素材源：`__SP_CDN_BASE__`（内容 = 上游 `v__SP_UPSTREAM_TAG__` 完整包里的同一批文件，逐文件校验过）
- 版本令牌：`__SP_CDN_TOKEN__`（内容变了令牌就变，所以可以放心长缓存）

---

## 1. 为什么

上游把 `public/assets/**` 放在 `.gitignore` 里、**安装期**从第三方仓库下载（`tools/fetch-assets.mjs`），
运行期再由服务器自己发。这在两个方面吃亏：

1. **安装慢**：首次约 309 MiB / 5,690 个文件，来源是 `raw.githubusercontent.com`。上游为此加了镜像层
   （见 §5）。
2. **运行期带宽**：每个玩家冷启动都要从部署机拉几百 MB。家用上行（10 Mbps 量级）下这是最大的一笔开销，
   而且素材对每个玩家都一样，完全没必要重复过一遍部署机。

CDN 把这两件事都接走：素材只有一份、放在边缘，玩家就近取。

---

## 2. 一键使用（运行期）

```
Stronghold-Protocol/          ← 上游部署包
  stronghold-cdn/             ← 本文件夹（放部署包内、旁边、或部署包上一级都能被自动找到）
```

- **Windows**：双击 `stronghold-cdn\start-with-cdn.cmd`
- **Linux/macOS**：`sh stronghold-cdn/start-with-cdn.sh`
- 部署目录被改过名（例如 `servers/`）：`SP_DEPLOY_DIR=/path/to/servers sh stronghold-cdn/start-with-cdn.sh`

它会启动游戏服（内部端口 `PORT+1`），在 `PORT`（默认 3000）上做代理，并把三个美术清单响应里的
`/assets/…`、`/fonts/…` 改写成 CDN 绝对地址。房间与对局的 WebSocket 原样透传。

**验收**：

```bash
node stronghold-cdn/verify-cdn.mjs http://127.0.0.1:3000
# 期望：OK: art is served from the CDN（清单里 0 条仍指向本机 + 抽样 20 条全 200）
```

**撤销**：删掉 `stronghold-cdn/`，按原方式启动。部署包自始至终没被改过。

### 2.1 本地化模式（把素材搬到本机，玩家不再各拉几千个文件）

默认模式是"素材由 CDN 发"。如果你希望素材**存在本机**（局域网速度、且不依赖外网），加一个环境变量：

```bash
# Windows: set SP_LOCALIZE=1 之后双击 start-with-cdn.cmd
SP_LOCALIZE=1 sh stronghold-cdn/start-with-cdn.sh
```

启动时会按 `mirrors.json` 的打包清单下载素材包（约 533 MB，**默认优先走社区镜像**，
`SP_LOCALIZE_FROM=direct` 可改为直连 GitHub），解压到 `stronghold-cdn/.sp-assets/`，之后
`/assets/**`、`/fonts/**` 由侧车**从本地磁盘同源发出**。

- **清单不做任何改写**：上游本来就是相对路径 `/assets/…`，同源正是客户端要的 —— 所以这个模式下"正确的改写"就是不改写，连 CORS 都不需要。
- **未命中的文件按 `本地 → 部署包自己的素材 → CDN` 兜底**，所以只下部分包也能跑（`SP_LOCALIZE_PACKS=assets-spine-1,fonts-1` 指定子集）。
- **验收**：`SP_LOCALIZE=1 node stronghold-cdn/verify-cdn.mjs http://127.0.0.1:3000` —— 期望
  `manifests: … relative`、`unpacked tree: N/N sampled files served from local disk`、`OK: art is served locally by this sidecar`。
- 再想回到 CDN 模式：删掉 `.sp-assets/` 并去掉 `SP_LOCALIZE`。

**为什么浏览器客户端不能"自己解压"**：客户端是上游页面，不修改它就无法拦截它自己的图片请求；
能做这件事的位置只有**部署侧的这层侧车**（既不是服务器配置，也不是上游文件）。

> 如果你用的是**本项目 fork**（含 `SP_ASSET_CDN` 支持），可以不要这层代理：
> `SP_ASSET_CDN=__SP_CDN_BASE__ npm start` 就是同样的效果。

---

## 3. 安装期加速（可选，但很值）

上游的素材下载器已经支持"前缀镜像"（`SP_ASSET_SOURCE=mirror` + `SP_GITHUB_PROXY`，默认
`https://gh-proxy.com/`）。CDN 可以作为**第一个来源**插进去，因为 CDN 上的路径与部署树里的
`assets/…` 完全一致：

```bash
# 只下缺的文件，优先走 CDN，失败再回落到上游原来的源
SP_ASSET_SOURCE=mirror SP_GITHUB_PROXY=__SP_CDN_BASE__/ npm run assets
```

即使不启用镜像，也可以直接按清单从 CDN 补齐（本文件夹的 `verify-cdn.mjs` 会告诉你缺哪些）。
素材清单是唯一真源：`data/assets.json` 列出客户端会请求的每一条路径。

---

## 4. 聚合接口与镜像选择

CDN 自己发布聚合接口，机器可读。

**完整清单以 `__SP_CDN_BASE__/cdn/v1/api.json` 为准**（字段 `{ schema, base, token, endpoints[] }`，
每个端点带路径 / 类型 / 缓存 / 用途）。下表只列侧车最常用的四个：

| 路径 | 内容 |
|---|---|
| `__SP_CDN_BASE__/cdn/v1/art.json` | 契约 + 版本水位 + 校验结果（`art.mirrors[]`、`art.packs[]`、`verified`） |
| `__SP_CDN_BASE__/cdn/v1/mirrors.json` | 全部镜像（R2 / Pages / 打包通道 + 镜像站前缀）与选取建议 |
| `__SP_CDN_BASE__/cdn/v1/index.json` | 全量键表 `{ 路径: { size, sha256 } }`，逐文件校验用 |
| `__SP_CDN_BASE__/cdn/v1/pick.js` | 依赖为零的 ES 模块：测速并返回最快的镜像 |

```js
import { pickFastest } from '__SP_CDN_BASE__/cdn/v1/pick.js';
const { best, ranked } = await pickFastest((await (await fetch('__SP_CDN_BASE__/cdn/v1/mirrors.json')).json()).flat);
console.log('用这个：', best.id, best.base, best.ms + 'ms');
```

**为什么要客户端选而不是服务端定**：部署机和玩家不在同一个网络里，谁是"最快"的答案不一样。
所以接口只给候选与元数据，测速在消费端做（本项目下载站也是这个套路）。

---

## 5. 上游的相关工作（PR）

| PR | 状态 | 做了什么 |
|---|---|---|
| [#24](https://github.com/sganggs/Stronghold-Protocol/pull/24) | 已合并（2026-10-06） | **向 setup 添加 gh-proxy 镜像**：新增 `tools/assets/sources.mjs`、`network.mjs`、`downloader.mjs`、`cache.mjs`，引入 `SP_ASSET_SOURCE=direct\|mirror` 与 `SP_GITHUB_PROXY` 前缀代理 + jsDelivr 兜底、镜像连续失败自动熔断 |
| [#23](https://github.com/sganggs/Stronghold-Protocol/pull/23) | 已关闭 | 同一目标的早期尝试（给 Setup 加 gh-proxy 加速国内下载） |
| [#289](https://github.com/sganggs/Stronghold-Protocol/pull/289) | 打开中 | 让 downloader 正确处理 `$HTTP_PROXY` 环境变量（引入 undici 的 `EnvHttpProxyAgent`） |

也就是说上游认可"加速素材拉取"这件事，且已经把它抽象成**来源选择 + 前缀镜像 + 熔断**三层。
本 CDN 与它不冲突：上游解决"从 GitHub 拉"，本 CDN 解决"拉完之后的运行期分发"，并且可以作为
上游镜像链里的一个来源（§3）。

---

## 6. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 素材仍是本机的 | 你访问的是内部端口（`PORT+1`）或另一个实例；走代理端口再看 |
| 白块 / CORS 报错 | CDN 响应缺 `Access-Control-Allow-Origin`（可能是边缘缓存里存了无 CORS 的副本） |
| `verify-cdn.mjs` 报缺文件 | 用 `__SP_CDN_BASE__/cdn/v1/index.json` 比对，缺什么补什么；上游清单是唯一真源 |
| 想换端口 | `PORT=8080`（内部端口自动 8081） |
| 房间连不上 | 代理必须透传 WebSocket upgrade；本文件夹的 `cdn-serve.mjs` 已处理 |
