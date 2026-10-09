# Stronghold-Protocol-CDN

把上游（[`sganggs/Stronghold-Protocol`](https://github.com/sganggs/Stronghold-Protocol)）**最新 Release 里的静态素材**自动镜像到 Cloudflare R2，并对外提供一套可校验、可引用的素材接口。

本仓是 `weishucdn.jiangjiangze.icu`（R2 桶 `stronghold-assets`）**素材部分的唯一发布者**。

## 为什么需要它

上游的 `public/assets/**`（约 460 MB）**不在 git 里**（`.gitignore` 排除），由 `tools/fetch-assets.mjs` 在安装期从第三方下载。唯一"权威且完备"的产物是 **Release 完整包** `Stronghold-Protocol-v<tag>.zip` —— 上游 `tools/package.mjs` 出包前会硬断言"清单列出的每个文件都在"。

在此之前，桶里的素材是若干次手工上传的叠加，实测（2026-10-08，对上游 v0.2.1 清单 7,976 个唯一路径）：

| 前缀 | 缺（清单要、桶没有） | 多（桶有、清单不要） |
|---|---|---|
| `assets/` | 2,273（28.5%） | 4,387 |
| 与 `assets-re/` 取并集后 | 仍缺 667 | 8,500 |

也就是说：**没有任何机制能回答"CDN 是否与上游一致"**。本仓把它变成一个可机检的布尔值。

## 边界（重要）

| 前缀 | 归属 |
|---|---|
| `assets/`、`fonts/` | **本仓独占**（本仓是唯一写入者） |
| `apk/`、`apk-test/`、`assets-re/`、`site/`、`scout/`、`upstream/` | **其他产品线**，本仓**不写、不删** |

只托管**素材 + 字体 + 清单**，不做整站静态托管（游戏仍需要 Node 服务端）。

## 它做什么

```
gh 取上游 latest release（或 --tag 指定）
  → 下载完整包（约 428 MB）
  → 只解压 public/assets/**、public/fonts/**、data/{assets,local-assets}.json、packs/**
  → 逐文件算 size + sha256，生成内容索引
  → 与 CDN 上现有的 cdn/v1/index.json 对账（只增不改不删；删除仅报告）
  → （非 dry-run 时）上传差集，并发布接口文件
  → 门禁：对清单里每一个 URL 做 HEAD，missing / mismatch 必须为 0
  → 写 report.json + 步骤摘要
```

**默认 `--dry-run`：只读、零写入、不需要任何凭据。** 真实上传需要 `--write`，并要求 R2 凭据在环境里。

## 接口

基址 `<CDN>` = `https://weishucdn.jiangjiangze.icu/`

| 路径 | 内容 |
|---|---|
| `<CDN>/assets/**` | 素材本体（键 = 上游 `public/assets/**` 去掉 `public/`） |
| `<CDN>/fonts/**` | 字体 |
| `<CDN>/data/assets.json` | 上游清单，`/assets/…`、`/fonts/…` 已改写为绝对 URL 且带 `?v=<tag>` |
| `<CDN>/cdn/v1/art.json` | art 契约 + 版本水位 + 校验结果（字段名与 re 线 `site/manifest-re.json` 的 `art` 块对齐） |
| `<CDN>/cdn/v1/index.json` | 全量键表 `{ "assets/…": { size, sha256 } }`，供二级镜像与逐文件校验 |

接法见 [`docs/INTEGRATION.md`](docs/INTEGRATION.md)。

## 对外产物

除素材接口外，每轮同步还发布三类**给人下载**的产物（R2 `packs/assets-<tag>/` + GitHub release `assets-<tag>` 双写）：

| 产物 | 体积 | 给谁 | 它怎么让素材走 CDN |
|---|---|---|---|
| `stronghold-cdn-dropin-<tag>.zip` | 十几 KB | **已经有**能跑的上游部署包 | 侧车代理，运行时改写三张清单的响应；**不改动部署包里任何文件** |
| `stronghold-official-cdn-<tag>.zip` | ~23 MB | **还没有**部署包 | 取上游 `-lite.zip`（不含素材、自带 node_modules），**把包内 `data/assets.json` 与 `data/emotes.json` 改写成绝对 CDN 地址**；解压即跑 |
| 17 个 `assets-<tag>/<id>.zip` | 481 MB | 打包通道 / `SP_LOCALIZE` | 批量取素材到本地，不再逐文件走 CDN |

后两者由 `src/packs.mjs` 与 `src/official-cdn.mjs` 产出。整合包改动了上游受管的
`data/emotes.json`，因此会**同步更正 `MANIFEST.json` 里对应的 `{size, sha256}`**，保证
`npm run doctor` 的文件校验自洽（`data/assets.json` 属上游 setup 管理，不在 MANIFEST 里，可自由改写）。

## 运行

```bash
node src/sync.mjs                 # dry-run：只读对账，打印报告（门禁不通过则退出码非 0）
node src/sync.mjs --report-only   # 同上，但门禁失败也退出 0（只想读数字时用）
node src/sync.mjs --tag=v0.2.1    # 指定版本
node src/sync.mjs --write         # 真上传（需要 R2 凭据）
node src/sync.mjs --write --prune # 额外删除 CDN 上已不在上游清单的对象（危险，默认关）
node --test tests/*.test.mjs      # 纯函数单测（不联网）
```

**门禁在两种模式下都是权威的**：红色 = CDN 与清单不一致。当前 `assets/` 树还不完整，所以不写数据的运行也会是红的 —— 那正是它要报告的事实；加 `--report-only` 才是"只看数字、不判失败"。

CI 里由 [`.github/workflows/sync.yml`](.github/workflows/sync.yml) 调用，默认 dry-run。

## 凭据

**只从环境变量读取**，源码、示例与测试里不出现任何凭据字面量：

| 变量 | 用途 |
|---|---|
| `R2_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token（只授该桶的 Object Read & Write） |
| `R2_BUCKET` | 默认 `stronghold-assets` |

在 Actions 里通过仓库 secrets 注入。dry-run 路径**完全不需要**这些变量。

## 安全约定

- **不做删除**，除非显式 `--prune`。
- 上游 URL 只允许 `https://`，且拒绝环回/私有/保留地址。
- 不把字节提交进仓库（素材体积以 GB 计，且版权归 Hypergryph / Yostar；见 `NOTICE` 说明）。
