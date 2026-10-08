# 给 AI agent 的提示（可直接粘贴给 agent）

这个文件夹让一份**未经修改的上游服务器部署包**把美术素材交给 CDN，而不是从本机 `public/assets/` 发。

## 你要做的事（三步）

1. **确认部署位置**：找到含 `package.json`、`server/`、`public/` 的那个目录（上游完整包解压后的
   `Stronghold-Protocol/`）。本文件夹放在**三种位置之一**都能被自动找到：

   ```
   Stronghold-Protocol/            Stronghold-Protocol/          <任意目录>/
     stronghold-cdn/         或      （部署包本体）          或     Stronghold-Protocol/
     （部署包本体）                  stronghold-cdn/               stronghold-cdn/
   ```

   都不满足时（例如部署目录被改名成 `servers/`），显式指定：

   ```
   SP_DEPLOY_DIR=/path/to/部署目录 node cdn-serve.mjs
   ```

2. **启动**：Windows 双击 `start-with-cdn.cmd`；Linux/macOS 运行 `sh start-with-cdn.sh`。
   它会：把游戏服起在内部端口（`PORT+1`），在 `PORT`（默认 3000）上代理它，并把
   `/data/{assets,local-assets,emotes}.json` 三个响应里的 `/assets/…`、`/fonts/…` 改写成 CDN 绝对地址。
   **不改部署包里的任何文件**，WebSocket（房间/对局）原样透传。

3. **验收**：另开一个终端运行

   ```
   node verify-cdn.mjs http://127.0.0.1:3000
   ```

   期望输出最后一行是 `OK: art is served from the CDN`。它要求：清单里 **0 条**素材仍指向本机，
   且抽样 20 条 CDN URL 全部返回 200。

## 可选：本地化模式（`SP_LOCALIZE=1`）

想让素材落在部署机本地（局域网速度、运行期不依赖外网）：设 `SP_LOCALIZE=1` 启动。侧车会按
`mirrors.json` 的打包清单下载（默认优先社区镜像，`SP_LOCALIZE_FROM=direct` 改直连）并解压到
`.sp-assets/`，然后**同源**发出 `/assets/**`、`/fonts/**`。

- **不要**在这个模式下再去改写清单 —— 上游的相对路径就是对的（同源）。
- 未命中按 `本地 → 上游 → CDN` 兜底；`SP_LOCALIZE_PACKS=a,b` 可只下子集。
- 验收：`SP_LOCALIZE=1 node verify-cdn.mjs http://127.0.0.1:<端口>`，期望
  `unpacked tree: N/N … from local disk` 与 `OK: art is served locally by this sidecar`。

## 硬约束（别踩）

- **不要在部署包里改 `data/assets.json`**：服务器自己也要读这个文件（`server/data.js`、`server/update.js`
  会用它做完整性校验），改磁盘文件会破坏更新与自检。只在**响应层**改写（本文件夹就是这么做的）。
- **素材必须带 CORS**：客户端用 `img.crossOrigin='anonymous'` 取图，CDN 必须回
  `Access-Control-Allow-Origin: *`，否则 WebGL 贴图会被 canvas 污染而变白块。
- **不要改 `HOST`/`PORT` 之外的东西**：本文件夹通过环境变量传端口给子进程。
- 若部署包是**本项目 fork**（含 `SP_ASSET_CDN` 支持），可以不用本文件夹，直接
  `SP_ASSET_CDN=__SP_CDN_BASE__ npm start` —— 效果相同且更省一层代理。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `verify-cdn.mjs` 报还有 N 条指向本机 | 你连的是没走本代理的端口（直连了内部端口 `PORT+1`），或访问的是别的实例 |
| 页面白块 / 控制台 CORS 报错 | CDN 响应缺 `Access-Control-Allow-Origin`（缓存里可能存了无 CORS 的副本） |
| 端口被占用 | `PORT=8080 node cdn-serve.mjs`（内部端口会变成 8081） |
| 想彻底撤销 | 直接删掉本文件夹，按原来的方式启动即可；部署包从未被修改 |
