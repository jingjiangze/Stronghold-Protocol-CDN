# 边缘分流源 ms-edge（Docker 动态跳转 / 创空间容器 302 边缘层）

> 本篇记一个**不同于**「镜像」的东西：不是另一份素材树的存放地，而是站在字节源前面的一层**分流边缘层**。它跑在 ModelScope 创空间的容器里，把 `/assets/**` 与 `/fonts/**` **302 重定向**到真实字节源（当前指向自建 ModelScope 数据集镜像），字节不经容器；其余路径由容器里的游戏服务器回答。事实来自 `feat/ms-edge-origin` 分支的 `origins.json` 与 `src/origins.mjs`（2026-10-11）。

## 1. 结论先行

- 容器地址 `https://jingjiangze-stronghold-protocol.ms.show`，nginx 占 **`:7860`** 做分流：
  - `/assets/**`、`/fonts/**` → Node sidecar（内部 `:3130`）返回 **302** 跳到真实字节源；
  - 其余（页面 / data / js / ws / healthz）→ 游戏服务器（内部 `:3120`）。
- **本站不持有任何美术字节**，只做「把请求指到正确的源」。
- 为什么是 302 而不是反代：字节直接 302 出网，容器只承担一次重定向的极轻开销，不被几百 MB 素材流量拖垮；且创空间对容器有单实例端口与流量约束，让字节绕开容器最稳。
- **当前默认 `enabled:false`**：创空间容器需人工在设置页「重新部署」才会重建镜像（平台对 Running 态容器拒绝重建），在那之前这个源的 `/assets/**` 是 404，所以先停着。

## 2. 容器内分流架构

**请求怎么走**

- `/assets/**`、`/fonts/**` → nginx 转给 Node sidecar（`:3130`），sidecar 回 **302** 到真实字节源。
- 其余（`/`、`/data/`、`/js/`、`/ws/`、`/healthz`）→ 游戏服务器（`:3120`）。
- sidecar 挂掉时，nginx **兜底 `return 302` 主源**，不把玩家卡在 502。

**实现取舍**

- 弃用 Lua：原 nginx+lua 方案改为**普通 nginx + Node sidecar**——lua 在容器镜像里装配成本高、调试难，sidecar 用 JS 写更直观。
- 真实字节源当前指向**自建 ModelScope 数据集镜像**（本仓 `assets-raw` 树的同源存放，非创空间页面本身）。
- 容器地址由创空间**强制端口 `:7860`**，外部只能访问这个端口。

**与三篇「镜像」的区别**：OpenI / ModelScope 是「素材树的一份拷贝」（git 镜像）；ms-edge 是「在字节源前面的一层分流」，自己不存字节。`probe` 必须点名真实素材路径（`/assets/char/avatar/char_003_kalts.png`），不能用默认 `/robots.txt`——否则会量到游戏服务器、把游戏页当镜像。

## 3. 接入配置（origins.json）

它作为一条 `extraOrigin` 进入 `art.json` / `mirrors.json`，由 `src/origins.mjs` 透传 `probe` 与 `coverage`。仓库约定：parking 需条目级 `enabled:false` 与 `disabled` 列表**双写**。

```jsonc
// origins.json —— extraOrigins
{
  "id": "ms-edge",
  "kind": "cdn",
  "root": "https://jingjiangze-stronghold-protocol.ms.show",
  "probe": "/assets/char/avatar/char_003_kalts.png",
  "coverage": "full",
  "enabled": false
}

// origins.json —— disabled 列表（与条目级 enabled:false 双写）
"disabled": [ "jsdelivr", "jsdelivr-assets", "openi", "ms-edge" ]
```

`src/origins.mjs` 的 `readExtraOrigins` 现在透传 `probe` / `coverage` / `enabled` 三个字段——扁平原点过去意味着「R2 形状的树、随便探测」，但重定向边缘层形状扁平、探测不扁平：它把 `/assets/**` 中继出去、其余从背后的游戏服务器回答，所以默认探测路径会量到游戏页、把游戏页当镜像；显式命名 probe 才能让测量诚实。而 `coverage` 不设默认是 `partial`，客户端会直接过滤掉，所以 full 源必须明说。

**启用待办（验收通过后）**：去掉条目里的 `enabled:false` **且**从 `disabled` 列表移除 `"ms-edge"`——两处必须同步改，否则会被另一条发布分支悄悄复活 / 悄悄忽略。

## 4. 状态词与边界

| 项 | 状态 |
|---|---|
| `origins.json` / `src/origins.mjs` | **IMPLEMENTED**：ms-edge 条目 + probe/coverage/enabled 透传 + 测试 |
| 容器重建 | **PENDING**：ModelScope 需人工在设置页「重新部署」才重建镜像；部署仓已推 commit `8456a42`（gh 与 ms 一致）但容器未重建 |
| 线上生效 | **PENDING**：`enabled:false` 期间 `/assets/**` 是 404；验收通过后去掉停靠才转为运行时候选 |
| 镜像源 apk | **已实现**：仅用于 Docker build 期换 alpine 源（`dl-cdn.alpinelinux.org → mirrors.aliyun.com`），与运行时 302 目标无关 |

## 5. 验收

```bash
# 1. 容器重建后：真实素材路径应 302 到字节源（非容器本身）
curl -sI https://jingjiangze-stronghold-protocol.ms.show/assets/char/avatar/char_003_kalts.png \
  | grep -iE '^HTTP|^location'

# 2. 游戏页面仍由容器回答（不应被 302 到外部）
curl -sI https://jingjiangze-stronghold-protocol.ms.show/ | grep -iE '^HTTP'

# 3. 验收通过后：去掉 origins.json 的 enabled:false 与 disabled 列表里的 ms-edge，重发接口
node src/sync.mjs --interface-only      # 秒级重发 mirrors.json + art.json
```

## 6. 关键约束

- `ms-edge` 的 `probe` 必须指向真实素材路径（如 `/assets/char/avatar/char_003_kalts.png`），不可依赖默认 `/robots.txt`。
- 镜像源仅用于 Docker build 期 apk，与运行时 302 目标（ModelScope 数据集）无关。
- 部署仓 `sources.json` 仍引用 `master` 而非 40hex 钉版（已知小偏差，待定）。
