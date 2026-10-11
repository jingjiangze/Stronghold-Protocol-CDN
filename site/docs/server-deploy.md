# 服务器部署文档

> 非官方同人作品，仅供学习交流。素材版权归 Hypergryph / Yostar 所有。

把卫戍协议游戏服从零部署到 **ModelScope 创空间**（一个 Docker 容器）。文档写清了：部署前要准备什么信息、怎么创建创空间、默认配置是什么、怎么推送并触发重新部署、怎么验收。所有默认配置都随配套仓库 `Stronghold-Protocol-Server-Deploy` 附上、逐字可用。全部来自仓库源码与平台实测（2026-10-11）。

## 一、结论先行

游戏服跑在 ModelScope 创空间的 Docker 容器里，对外只暴露一个端口 **7860**（平台写死，不可改）。容器内部三个进程共用这个口：**nginx** 占 7860 做分流，**edge-sidecar**（:3130）只把素材请求 302 到 CDN，**游戏**（:3120）跑页面 / WebSocket / 数据。素材字节**从不经过容器**——玩家浏览器拿到的是 302，自己去 CDN 取。默认配置已写好，复制即用，不用自己猜参数。

- 这是服务端部署，不是素材 CDN：本页讲「游戏服怎么跑起来」。素材本身由 R2 / git 镜像分发；游戏服只负责把清单里的素材地址指向那些源。两者是不同系统，不要混。

## 二、部署前需要准备什么

| 项 | 必需 | 说明 |
|---|---|---|
| ModelScope 账号 | ✅ | 当前用 `jingjiangze`。没有先注册。 |
| ModelScope Access Token | ✅ | 形如 `ms-xxxx-xxxx`。做 git 远程鉴权与「重新部署」，不要用主密码。 |
| 游戏服务端代码 | ✅ | 上游 `sganggs/Stronghold-Protocol` 的 fork，或配套仓库（其 `Dockerfile` 假定 `server/ public/ data/ tools/` 在同目录）。 |
| 素材 CDN 源 | ⚠️ 默认已给 | 容器不存素材字节，只 302。默认两个源：`modelscope`（数据集镜像，公开）+ `r2`（`weishucdn.jiangjiangze.icu`）。 |
| 基础镜像 | ⚠️ | `node:22-alpine`。本项目是 Node 应用，不需要 torch 镜像。 |
| 硬件规格 | ⚠️ | `platform/2v-cpu-8g-mem`（免费 CPU，2 vCPU / 8 GB）。 |
| 对外端口 | ⚠️ | **7860，硬锁**（`deploy_schema.json` 的 `port.const`；8080 已被平台占用）。 |
| 对外域名 | ⚠️ | 平台分配 `https://jingjiangze-stronghold-protocol.ms.show/`，不能自定义（自有域名需走 Cloudflare Worker 代理）。 |
| 实例数 | 建议 | `1`（免费档默认）。 |

带 ⚠️ 的是平台硬约束，改不了。

## 三、架构总览

```
                    ┌─ /assets/** /fonts/** ─► edge-sidecar :3130 ──302──► 素材源（字节不过容器）
玩家 ──:7860──► nginx┤                                              ↑ 只有 Location，没有字节
                    └─ 其余（页面/data/js/vendor/media/ws/healthz）─► 游戏 :3120
```

- **为什么这么分**：创空间只给一个公网口（7860），所以 nginx 占住它，另外两个退到内部端口（绑 `127.0.0.1`）。这与 Stardust 的 compose 同构（游戏 3120 / 素材解析器 3130 / 一个 nginx 在前面）。
- **监督语义是故意不对称的**：游戏或 nginx 退出 → 整体退出，让平台重启容器（少一个就没服务）；sidecar 退出 → 只记日志；nginx 的 fallback 还能供素材，不为它重启整个容器。

## 四、第一步：创建 ModelScope 创空间

1. 打开 ModelScope 创空间控制台 → 创建创空间；命名空间保持你的账号，仓库名填 `Stronghold-Protocol`；基础镜像选 `node:22-alpine`，硬件选 `platform/2v-cpu-8g-mem`。先别点部署。
2. 进创空间「设置」，复制 Git 仓库地址，形如 `https://oauth2:<Token>@www.modelscope.cn/studios/jingjiangze/Stronghold-Protocol.git`（Token 已嵌进 URL，无需 ssh key）。第三步当 git remote 用。

- 端口在控制台看不到输入框——它被平台的 `deploy_schema.json` 锁成 7860。记住它、别在 Dockerfile 里改端口即可；构建失败日志会提示端口约束。

## 五、第二步：默认配置（随配套仓库附上）

配套仓库 `Stronghold-Protocol-Server-Deploy` 已把边缘层 5 个文件放在 `deploy/stardust/ms-edge/`，整目录复制进你的服务端代码即可（路径不变，根 `Dockerfile` 按这个路径 `COPY`）：

| 文件 | 作用 |
|---|---|
| `sources.json` | 源表与例外表（唯一真源，运行时读取） |
| `edge-sidecar.mjs` | 决策：路径校验、选源、302、CORS、方法限制（纯 Node，无 Lua） |
| `nginx.conf` | 分流 + 后端故障兜底（不含任何 Lua） |
| `render-nginx.mjs` | 构建期从 `sources.json` 渲染 `sources-nginx.conf`（定兜底基址） |
| `entrypoint.sh` | 三个进程的启动顺序与监督 |

Dockerfile 环境变量（写死）：

```dockerfile
ENV NODE_ENV=production \
    SP_PUBLIC_PORT=7860 \
    SP_GAME_PORT=3120 \
    SP_EDGE_PORT=3130 \
    PORT=3120 \
    HOST=127.0.0.1
```

sources.json 默认（节选）：

```json
{
  "order": ["modelscope", "r2"],
  "sources": [
    { "id": "modelscope",
      "base": "https://modelscope.cn/datasets/jingjiangze/Stronghold-Protocol-Assets/resolve/master/releases/v1-trial" },
    { "id": "r2",
      "base": "https://weishucdn.jiangjiangze.icu" }
  ],
  "exceptions": {
    "/assets/skins/char_340_shwaz_snow_1/illustration.png": "r2"
  }
}
```

- `order` 是静态顺序，不是实时测速：容器在 ModelScope 机房，量不出玩家那边的链路。真正按玩家网络选最快是**客户端** `pick.js` 的事，两者分工。新增镜像后要核对覆盖率——平台审核会拒收个别文件（如上面的 `exceptions` 路径），这些必须点名改道，否则玩家 404。

## 六、第三步：推送并触发重新部署

```sh
# 1) 加 ModelScope git 远程（oauth2 把 token 嵌进 URL）
git remote add ms "https://oauth2:${MS_TOKEN}@www.modelscope.cn/studios/jingjiangze/Stronghold-Protocol.git"

# 2) 提交默认配置（本机若开了 SSH 签字，用一次性覆盖避免 agent 缺失）
git add deploy/stardust/ms-edge Dockerfile
git -c commit.gpgsign=false commit -m "deploy: 内置边缘层默认配置（ms-edge）"

# 3) 推到创空间的 git 远程
git push ms HEAD:master

# 4) 推送后，在创空间控制台点「重新部署」——API 在 Running 态会拒绝 start
```

- 推送 ≠ 部署。推到创空间 git 远程只是落地代码；还要在控制台点「重新部署」（或调 API）才会重新 build。忘了这步，线上不会变。

## 七、第四步：验收

```sh
# 1. 健康检查（探的是对外口 7860，由 nginx 代理到游戏）
curl -fsS https://jingjiangze-stronghold-protocol.ms.show/healthz

# 2. 素材请求应拿到 302 到某个源（字节不经过容器）
curl -fsS -o /dev/null -w '%{http_code} -> %{redirect_url}\n' \
  https://jingjiangze-stronghold-protocol.ms.show/assets/char/avatar/char_1016_agoat2.png

# 3. WebSocket（联机用）
wss://jingjiangze-stronghold-protocol.ms.show/ws
```

| 现象 | 原因 / 处理 |
|---|---|
| 构建失败，`nginx -t` 错 | `sources.json` 渲染不出 `sources-nginx.conf`，或 `nginx.conf` 语法错。本地先复现。 |
| 素材 404 | 命中 `exceptions` 没覆盖的被审核拒收路径，或 `order` 里的源挂了。 |
| 连不上自有域名 | 平台 WAF 拦了：用 `*.ms.show` 域名 + `iframe no-referrer`，或 Cloudflare Worker 代理。 |
| push 成功但没生效 | 忘了点「重新部署」。 |

## 状态词

- `BASELINE`：当前线上 = 平台分配域名 `jingjiangze-stronghold-protocol.ms.show`，端口 7860 锁死，游戏 3120 / sidecar 3130，素材字节不过容器。
- `IMPLEMENTED`：本页与 `server-deploy.md` 已写入 `stronghold-cdn` 仓库 `site/` 与 `site/docs/`；默认配置在 `jingjiangze/Stronghold-Protocol-Server-Deploy`。
- `PENDING`：游戏服的实际创建与「重新部署」需在 ModelScope 控制台手动操作（凭据不在本机）。
- `FAIL`：当前未跑游戏服部署验证（缺控制台操作）；上述验收命令需部署后执行。
