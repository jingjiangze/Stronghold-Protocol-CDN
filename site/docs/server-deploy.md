# 服务器部署文档

> 非官方同人作品，仅供学习交流。素材版权归 Hypergryph / Yostar 所有。

把卫戍协议游戏服从零部署到 **ModelScope 创空间**（一个 Docker 容器）。文档写清了：部署前要准备什么信息、怎么创建创空间、默认配置是什么、怎么推送并触发重新部署、怎么验收，外加一套**不绑自有域名、也不用任何叠加层**的最简部署方案。所有默认配置都随配套仓库 `Stronghold-Protocol-Server-Deploy` 附上、逐字可用。全部来自仓库源码与线上实测（2026-10-11，线上 build `5061a4e4` / app `0.2.3`）。

## 一、结论先行

游戏服跑在 ModelScope 创空间的 Docker 容器里，对外只暴露一个端口 **7860**（平台写死，不可改）。最省事的部署是**零叠加层**：容器里只跑游戏进程，监听 7860；素材由清单里的绝对 `https://speedcdn.jiangjiangze.icu/…` 地址直接指到 CDN（R2 桶 stronghold-assets，规范门牌 speedcdn），浏览器自己取，字节不过容器。配套仓库另带一套 **nginx + sidecar 302 边缘层**（边缘注入 / 多源兜底用），但线上清单已自带绝对 CDN 地址，所以那层对 speedcdn 部署是**可选、且已审计出局**的——下面「零域名 · 零叠加层方案」就是最简路径。默认配置已写好，复制即用。

- 这是服务端部署，不是素材 CDN：本页讲「游戏服怎么跑起来」。素材本身由 R2 / git 镜像分发；游戏服只负责把清单里的素材地址指向那些源。两者是不同系统，不要混。

## 二、部署前需要准备什么

| 项 | 必需 | 说明 |
|---|---|---|
| ModelScope 账号 | ✅ | 当前用 `jingjiangze`。没有先注册。 |
| ModelScope Access Token | ✅ | 形如 `ms-xxxx-xxxx`。做 git 远程鉴权与「重新部署」，不要用主密码。 |
| 游戏服务端代码 | ✅ | 上游 `sganggs/Stronghold-Protocol` 的 fork，或配套仓库（其 `Dockerfile` 假定 `server/ public/ data/ tools/` 在同目录）。 |
| 素材 CDN 源 | ⚠️ 默认已给 | 线上清单已写死绝对 `https://speedcdn.jiangjiangze.icu` 地址（R2 桶 stronghold-assets，规范门牌 speedcdn），浏览器直取，容器不存素材字节。配套仓库还多给 `modelscope` 数据集镜像作 302 兜底源（边缘层用）。 |
| 基础镜像 | ⚠️ | `node:22-alpine`。本项目是 Node 应用，不需要 torch 镜像。 |
| 硬件规格 | ⚠️ | `platform/2v-cpu-8g-mem`（免费 CPU，2 vCPU / 8 GB）。 |
| 对外端口 | ⚠️ | **7860，硬锁**（`deploy_schema.json` 的 `port.const`；8080 已被平台占用）。 |
| 对外域名 | ⚠️ | 平台分配 `https://jingjiangze-stronghold-protocol.ms.show/`，不能自定义。**最简方案就直接用这个域名**（无需 Cloudflare Worker / 自有域名）；要塞进自有站点用 `iframe referrerpolicy="no-referrer"` 即可过 WAF（见零域名方案）。 |
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

**下面这套是可选的「边缘层」**（素材 302 / 多源兜底 / 边缘注入）。配套仓库 `Stronghold-Protocol-Server-Deploy` 把它的 5 个文件放在 `deploy/stardust/ms-edge/`，整目录复制进你的服务端代码即可（路径不变，根 `Dockerfile` 按这个路径 `COPY`）。**若走「零域名 · 零叠加层方案」（下一节），这 5 个文件一个都不用复制**——游戏直接监听 7860，素材靠清单里的绝对 speedcdn 地址（https://speedcdn.jiangjiangze.icu）。

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

sources.json 默认（节选；2026-10-18 起 `modelscope` 已移出 `order`）：

```json
{
  "order": ["r2"],
  "sources": [
    { "id": "r2",
      "base": "https://speedcdn.jiangjiangze.icu" }
  ],
  "exceptions": {
    "/assets/skins/char_340_shwaz_snow_1/illustration.png": "r2"
  }
}
```

> `modelscope` 条目（`modelscope.cn/datasets/jingjiangze/Stronghold-Protocol-Assets/resolve/master/releases/v1-trial`）
> 已于 2026-10-18 从公开 `order` 里摘除：数据集转为私有后**匿名**访问 404/403，而边缘 302 是匿名通道，
> 再指过去只会把必然失败的源放大出去。**数据集本身没有失效** —— 它在 `origins.json` 里以 `enabled:false` 保留，
> 所有者会话（token 换 cookie）实测 `resolve` 仍返回 200 / 56,617 字节真 PNG，CDN 的服务端链路与同步照常调用；
> 玩家侧公开字节由 `r2` 承接（同一份对象）。

- `order` 是静态顺序，不是实时测速：容器在 ModelScope 机房，量不出玩家那边的链路。真正按玩家网络选最快是**客户端** `pick.js` 的事，两者分工。新增镜像后要核对覆盖率——平台审核会拒收个别文件（如上面的 `exceptions` 路径），这些必须点名改道，否则玩家 404。

## 六、零域名 · 零叠加层方案（最简）

这是给「只想让游戏服跑起来、不折腾代理」的人。它**不申请自有域名、不套 Cloudflare Worker、也不装边缘层**，直接用平台分配的 `*.ms.show` 域名，容器里只跑游戏进程。前提：清单里的素材地址已经是绝对 `https://speedcdn.jiangjiangze.icu/…`（线上就是，R2 桶 stronghold-assets 规范门牌）。**不是「不绑 CDN」，而是不绑自有域名**——素材依旧走 speedcdn，只是不经过任何叠在游戏前面的代理。

**为什么可行**

- **素材不过容器，靠清单绝对地址**：玩家浏览器读 `/data/assets.json` 拿到的是完整 `https://speedcdn.jiangjiangze.icu/…` URL，自己直连 CDN 取字节。容器既不用存素材，也不用 302 转发——边缘层的存在理由被清单直接抹掉了。
- **`*.ms.show` 域名能直接进游戏**：平台 WAF 对浏览器 UA 放行 7860；但要塞进自有站点必须用 `<iframe referrerpolicy="no-referrer">`（直链会 302 到门户）。自定义 SNI / 自有域名在 WAF 层是默认证书，接不通——所以本方案干脆不绑。

**部署步骤**

1. **准备一个只跑游戏的容器**：把服务端代码（`server/ public/ data/ tools/`）和下面这个极简 `Dockerfile` 放进创空间仓库即可，**不要**复制 `deploy/stardust/ms-edge/`。
2. **极简 Dockerfile**（游戏直接监听 7860，不再经 nginx 分流）：

   ```dockerfile
   FROM node:22-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev
   COPY server public data tools ./
   ENV NODE_ENV=production \
       PORT=7860 HOST=0.0.0.0
   EXPOSE 7860
   CMD ["node", "server/index.js"]
   ```

3. **确认素材地址是绝对 speedcdn URL**（https://speedcdn.jiangjiangze.icu）：部署前一行命令核对清单：

   ```sh
   curl -fsS https://你的域名/data/assets.json | grep -c "https://speedcdn.jiangjiangze.icu"
   ```

   若清单里是相对路径（旧版），要么把游戏配成带 `SP_ASSET_CDN` 基址，要么退回上面的边缘层——否则玩家会 404。

4. **推送并点「重新部署」**：同「第三步」：`git push ms HEAD:master` 后，在创空间控制台点「重新部署」才会重新 build。
5. **把游戏塞进你的站点（不绑域名的关键）**：在自己的页面里用如下 iframe 内嵌，**必须带 `referrerpolicy="no-referrer"`**，否则 WAF 把直链 302 到 ModelScope 门户：

   ```html
   <iframe
     src="https://jingjiangze-stronghold-protocol.ms.show/"
     referrerpolicy="no-referrer"
     allow="autoplay; fullscreen"
     style="width:100%;height:80vh;border:0"></iframe>
   ```

**取舍**：零叠加层省掉了 nginx + sidecar 两个进程和一套源表，部署面更小、出问题的点更少；代价是你不能做边缘注入 / 多源实时兜底（这些要靠清单本身带绝对地址）。**自己搭的私有服没有这份 speedcdn 清单**时，还是得用边缘层或另配 `SP_ASSET_CDN`。本方案专为「用现成 speedcdn 清单」的场景。

## 七、第三步：推送并触发重新部署

```sh
# 1) 加 ModelScope git 远程（oauth2 把 token 嵌进 URL）
git remote add ms "https://oauth2:${MS_TOKEN}@www.modelscope.cn/studios/jingjiangze/Stronghold-Protocol.git"

# 2) 提交配置（本机若开了 SSH 签字，用一次性覆盖避免 agent 缺失）
#    零叠加层：只加 Dockerfile；边缘层：另加 deploy/stardust/ms-edge
git add Dockerfile            # 零叠加层
# git add Dockerfile deploy/stardust/ms-edge   # 边缘层
git -c commit.gpgsign=false commit -m "deploy: 游戏服默认配置"

# 3) 推到创空间的 git 远程
git push ms HEAD:master

# 4) 推送后，在创空间控制台点「重新部署」——API 在 Running 态会拒绝 start
```

- 推送 ≠ 部署。推到创空间 git 远程只是落地代码；还要在控制台点「重新部署」（或调 API）才会重新 build。忘了这步，线上不会变。

## 八、第四步：验收

```sh
# 1. 健康检查（零叠加层：直连 7860；边缘层：经 nginx 代理）
curl -fsS https://jingjiangze-stronghold-protocol.ms.show/healthz

# 2. 清单里的素材地址必须是绝对 speedcdn URL（https://speedcdn.jiangjiangze.icu；零叠加层不依赖 302）
curl -fsS https://jingjiangze-stronghold-protocol.ms.show/data/assets.json \
  | grep -c "https://speedcdn.jiangjiangze.icu"
#    若用边缘层（302 方案），则改成看 302：
#    curl -fsS -o /dev/null -w '%{http_code} -> %{redirect_url}\n' \
#      https://...ms.show/assets/char/avatar/char_1016_agoat2.png

# 3. WebSocket（联机用）
wss://jingjiangze-stronghold-protocol.ms.show/ws
```

| 现象 | 原因 / 处理 |
|---|---|
| 构建失败，`nginx -t` 错 | 只在用边缘层时出现：`sources.json` 渲染不出 `sources-nginx.conf`，或 `nginx.conf` 语法错。零叠加层没有 nginx。 |
| 素材 404 | 零叠加层：清单地址不是绝对 speedcdn URL（https://speedcdn.jiangjiangze.icu；旧版相对路径），或 speedcdn 挂了；边缘层：命中 `exceptions` 没覆盖的被审核拒收路径，或 `order` 里的源挂了。 |
| 直链打开跳到 ModelScope 门户 | WAF 把裸 `*.ms.show` 直链 302 到门户。塞进自有站点必须 `iframe referrerpolicy="no-referrer"`；自定义域名在 WAF 层是默认证书，接不通。 |
| push 成功但没生效 | 忘了点「重新部署」。 |

## 状态词

- `BASELINE`：线上（2026-10-11）= 平台分配域名 `jingjiangze-stronghold-protocol.ms.show`，端口 7860 锁死，build `5061a4e4` / app `0.2.3`；清单 `/data/assets.json` 已写死绝对 `https://speedcdn.jiangjiangze.icu` 地址（R2 桶 stronghold-assets，规范门牌 speedcdn），素材字节不过容器。边缘层（nginx+sidecar 302）对 speedcdn 部署已审计出局（可选）。
- `IMPLEMENTED`：本页与 `server-deploy.md` 已写入 `stronghold-cdn` 仓库 `site/` 与 `site/docs/`；配套部署仓库 `jingjiangze/Stronghold-Protocol-Server-Deploy` 含边缘层 5 文件 + Dockerfile（零叠加层可只用 Dockerfile）。
- `PENDING`：游戏服的实际创建与「重新部署」需在 ModelScope 控制台手动操作（凭据不在本机）。
- `FAIL`：当前未跑游戏服部署验证（缺控制台操作）；上述验收命令需部署后执行。
