# 完整镜像链路同步方法（上游发布 / 后台上传 → R2 → git 链 → 各 git 镜像）

> 本篇把**整条镜像同步链路**一次讲清：从「上游发布 / 后台上传」进 R2 桶，到「发布轮 → git 链 → 各 git 镜像」的字节级搬运，再到「排名测速」独立收尾。事实来自 `main` 分支的 Workflow 与实测（2026-10-15），不估算。主门牌 `https://speedcdn.jiangjiangze.icu`；`weishucdn` / `weishucdn2` / `speedcdn` 是**同一个 R2 私有桶（stronghold-assets）的三个域名**，字节完全相同，接口文件（`/cdn/v1/*.json`）只挂在 R2 桶域名上。

## 1. 结论先行

- 字节只有一条主干：**上游发布 / 后台上传 → 发布轮 → R2 桶（三域名）→ git-art → 孤儿分支 assets-raw → OpenI + 魔搭数据集 + ghfast/jsDelivr/gitcdn-own**。
- rank 链（D）是**独立的排名 / 测速支线**，只把「合格的实测源」排序信息喂给容器边缘，不改字节树本身。
- **硬依赖顺序**：`promote → git-art → openi/dataset-tree`。git 链是中枢——OpenI 与魔搭数据集链都读 `assets-raw`；rank 独立，收尾重测。乱序会丢字节或让镜像落后。

```text
字节主干（A→B→C）
上游发布 ─┐
          ├─► [发布轮 promote-uploads] ─► R2 桶（weishucdn / weishucdn2 / speedcdn，同字节）
后台上传 ─┘                                          │
                                                    ▼
                                          [git-art-sync] 把上线字节补提交进孤儿分支 assets-raw
                                                    │
                          ┌─────────────────────────┼──────────────────────────┐
                          ▼                          ▼                          ▼
                  [openi-mirror]              [dataset-tree]            ghfast / jsDelivr / gitcdn-own
                  推 OpenI 仓库             推魔搭数据集                 读 GitHub 分支（拉取型，自动跟随）
                  raw/branch/assets-raw     releases/v1-trial/**

排名支线（D，独立）
[rank.yml] Globalping 实测 → rank.json → 写 R2 + 镜像进魔搭数据集
[network-measure.yml] 每周一重测并触发 rank
容器边缘 asset-jump.js 每 5 分钟读 rank.json（主门牌=魔搭数据集 API，兜底 weishucdn）把合格源排头部
```

**时延（2026-10-15）**：上传端到端——点了「同步到镜像源」后，发布轮 **1–3 分钟** → git 链 **2–25 分钟**（视积压）→ OpenI / 数据集随之跟上；上游发布走 cron 4 窗（最长 6 小时）。魔搭数据集补齐是**长期收敛项**（2026-10-15 实测覆盖约 54.5%，缺口目录级：voice 0%、char 21%、ui 20%、spine 45%、local 36%）。

## 2. 四条链路：A 上游发布 · B 后台上传 · C R2→git→镜像 · D 排名测速

**链 A · 上游发布 → CDN（`sync.yml`）**

- 每天 4 窗 cron `17 1,7,13,19 * * *`，或 `workflow_dispatch` 手动触发。
- 镜像上游 release → 解包 → 上传 R2（assets/fonts/docs + 三张清单 `data/*.json` 绝对 URL 化）。
- 发接口文件 `cdn/v1/index|tree|api|art|mirrors` 等 → 可选打 GitHub Release 包 + 部署 Pages。
- 末尾自动 dispatch `site.yml` 刷新下载页快照。

**链 B · 后台上传 → R2（`promote-uploads.yml`）**

- 入口：管理员页 `/admin`，或命令行 `tools/agent-upload.mjs` / `agent-upload-batch.mjs`。
- 字节落暂存区 `cdn/incoming/<id>/` + `claim.json`。
- 发布轮 `promote-uploads.yml` 逐字节核对 sha256 → `CopyObject` 到对外键（`Cache-Control: immutable`）。
- 登记 `hosted.json` 进 git → 重发接口树 `sync.mjs --write --interface-only`（几十秒）。

**链 C · R2 → git 树 → 各 git 镜像（`git-art-sync.yml` 为中枢）**

- `git-art-sync.yml` 把 R2 已上线后台上传的字节补提交进孤儿分支 `assets-raw`（一天 4 窗 + 链式触发）。
- ① `openi-mirror.yml` 把该分支 `git push` 到 OpenI（每天 4 次）。
- ② `dataset-tree.yml` 把整棵树分批推魔搭数据集 `releases/v1-trial/**`（每次运行最多 6 轮 × 400 MiB）。
- ③ ghfast / jsDelivr / gitcdn-own 读 GitHub 的 `assets-raw` / `main` 分支（拉取型，自动跟随，无需推送）。

**链 D · 排名与测速（独立支线）**

- `rank.yml`（每天 4 窗）生成 `rank.json`（Globalping 内地三运营商实测）→ 写 R2 + 镜像进魔搭数据集。
- 容器边缘 `asset-jump.js` 每 5 分钟读它（主门牌 = 魔搭数据集 API，兜底 weishucdn）把合格的实测源排在头部。
- `network-measure.yml` 每周一重测并触发 rank。
- 与字节流解耦：只排顺序，不搬运素材。

**镜像源清单（2026-10-15 实测）**

- ① R2 桶（三域名，字节真源）；
- ② 魔搭数据集 `jingjiangze/Stronghold-Protocol-Assets@master:releases/v1-trial/`（容器边缘默认跳转目标，覆盖约 54.5%，缺口目录级：voice 0% / char 21% / ui 20% / spine 45% / local 36%，正由 dataset-tree 链持续补齐）；
- ③ OpenI 启智（`openi.pcl.ac.cn/.../raw/branch/assets-raw`，最快但 CORS 写死第三方域不可用，仅 `?sp_source=openi` 点名可达）；
- ④ ghfast / jsDelivr（GitHub 代理，可用率低）；
- ⑤ gitcdn-own（自有中转 Worker）；
- ⑥ spages（Pages）。

## 3. 每步在哪个仓库、哪个 workflow、什么触发、多久

| 链路 | 仓库 / workflow | 触发 | 频率 / 时延 |
|---|---|---|---|
| A 上游发布 | `sync.yml` | cron 17 1,7,13,19 * * * / workflow_dispatch | 每天 4 窗；最长 6 小时 |
| B 发布轮 | `promote-uploads.yml` | 上传 claim / 「催一次发布」/ 定时每 30 分钟兜底 | 逐字节核对 sha256 → CopyObject；1–3 分钟 |
| B 接口重发 | `sync.mjs --write --interface-only` | 发布轮末尾 | 几十秒 |
| C git 中枢 | `git-art-sync.yml` | 链式触发 / 一天 4 窗 | 2–25 分钟（视积压） |
| C→OpenI | `openi-mirror.yml` | 每天 4 次 | 幂等 git push |
| C→魔搭数据集 | `dataset-tree.yml` | 链式触发 / 定时 | 每次最多 6 轮 × 400 MiB |
| C→GitHub 代理 | ghfast / jsDelivr / gitcdn-own | 拉取型，自动跟随 | 读 assets-raw / main，无需推送 |
| D 排名 | `rank.yml` | 每天 4 窗 | Globalping 实测 → rank.json |
| D 重测 | `network-measure.yml` | 每周一 | 重测并触发 rank |

## 4. 后台按钮怎么用（2026-10-15 起）

2026-10-15 起：后台上传**不再自动叫发布轮**——批量上传时每件叫一轮会把 Actions 队列打爆。改为由管理员在 `/admin` 页面手动推进镜像链：

- **① 同步到镜像源（推荐）**：一次点击按顺序触发：① 发布轮（promote-uploads）→ ② `git-art-sync.yml --write=true`。下游由 git 链自动跟进：openi / dataset-tree 链式触发，无需再点。适合「上传完一批，整链推到镜像」的常规动作。
- **② 催一次发布 / 定时兜底**：「催一次发布」只跑**发布轮**（不推镜像）——仅想把字节上线、暂不碰 git 链时用。定时轮每 **30 分钟**仍作兜底：即便忘点按钮，暂存区字节也会被定期 promote。命令行等价：`tools/agent-upload.mjs` / `agent-upload-batch.mjs` 上传，发布轮由事件或定时驱动。

## 5. 怎么核对（各步验收）

```bash
# 1. 发布轮是否跑完（Actions 页看 promote-uploads.yml 绿）
gh run list --workflow=promote-uploads.yml --limit 5

# 2. 接口树已重发：tree.json 能取到、含刚上线的键
curl -s https://speedcdn.jiangjiangze.icu/cdn/v1/tree.json | head
curl -s https://weishucdn.jiangjiangze.icu/cdn/v1/tree.json | head   # 三域名同字节

# 3. git 中枢：assets-raw 分支有本次字节（git-art-sync 提交）
git ls-remote https://github.com/jingjiangze/Stronghold-Protocol-CDN assets-raw
git -C <本地仓> log --oneline origin/assets-raw -5

# 4. OpenI 镜像可达（raw 应 200 + 正确 MIME）
curl -sI https://openi.pcl.ac.cn/jingjiangze/Stronghold-Protocol/raw/branch/assets-raw/assets/char/avatar/char_1016_agoat2.png | grep -iE "HTTP|content-type"

# 5. 魔搭数据集补齐进度：resolve 链接能拉到对应路径
curl -sI "https://www.modelscope.cn/api/v1/datasets/jingjiangze/Stronghold-Protocol-Assets/repo?Revision=master&FilePath=releases/v1-trial/assets/char/avatar/char_1016_agoat2.png" | grep -iE "HTTP|location"

# 6. rank 支线：rank.json 已写、边缘读到（主门牌=数据集 API，兜底 weishucdn）
curl -s https://speedcdn.jiangjiangze.icu/cdn/v1/rank.json | head
```

**接口文件只在 R2 桶域名上**：`/cdn/v1/*.json` 只挂在 weishucdn / weishucdn2 / speedcdn，不挂在 git 镜像（OpenI / 数据集 / jsDelivr 等）。核对接口层一律用主门牌或三域名之一，别去 git 镜像找接口。

## 6. 已废弃路径：推魔搭创空间 cdn 分支

旧方案 `mirror-modelscope.yml` 把**整树推魔搭创空间 cdn 分支**，被平台 **1.6 GB 仓库上限硬拒**（实测素材树 2.36 GB），**已停用**。素材树现改走**魔搭数据集** `releases/v1-trial`（`dataset-tree.yml` 分批推送，每次最多 6 轮 × 400 MiB）。任何新文档 / 脚本都不要再引用创空间 cdn 分支同步——它不会成功，也没有回退计划。

## 7. 关键约束

- 硬依赖顺序：`promote → git-art → openi/dataset-tree`；git 链（assets-raw）是中枢，OpenI 与数据集链都读它。
- rank 链独立，只排顺序、不搬运字节；收尾由 `network-measure.yml` 每周一重测。
- 2026-10-15 起上传不再自动叫发布轮；后台用「同步到镜像源」一次推整链，定时轮 30 分钟兜底。
- 接口文件（`/cdn/v1/*.json`）只在 R2 三域名上存在，git 镜像无接口层。
- 魔搭数据集补齐是长期收敛项（2026-10-15 覆盖约 54.5%），缺口目录级：voice 0% / char 21% / ui 20% / spine 45% / local 36%。
