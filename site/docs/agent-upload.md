# agent 接入 · 上传静态素材（只新增，按原结构分类）

给自动化工具用的上传通道说明。复制这一段给 agent 就够它自己干活：

```
后台基址   https://downcdn.jiangjiangze.icu
接口鉴权   请求头 x-admin-key: <直连后台密钥>
上传目录   只能是 assets/ 、fonts/ 、packs/ 三个前缀之下
键名规则   与上游部署树一致：assets/<类>/<子类>/<文件名>（不要自己造新的顶层目录）
必须自带   size（字节）与 sha256（64 位十六进制）——发布机会逐字节核对，不符就不上线
禁止       覆盖已存在的键、删除键、写 cdn/ data/ apk/ site/ scout/ 这些契约与其它产品线的键
           （.html/.svg/.js 一律拒：这个域名对全世界发 ACAO *，放可执行内容等于在自己的域上开 XSS 位）
扩展名     能直发对外键的静态素材：png jpg jpeg webp gif atlas skel obj bin json mp3 mp4 woff2 otf ttf
           （mp4 自 2026-10-20 起支持，服务端按 video/mp4 发；浏览器上传通道单文件仍受 64 MiB 限制，
           更大的视频走 agent 通道直传，上限 5 GiB）
           且必须落在 assets/ 或 fonts/ 之下 —— 判据是「格式 × 落点」两条一起，只看扩展名不够：
           .json/.bin/.obj 两边都是（assets/local/map/common/materials.json 是素材，
           packs/mod-assets/index.json 是清单）
先审后发   名单内但不算素材的（zip txt ogg wav m4a woff xml data，以及任何不在 assets/ fonts/ 下的键，
           包括 packs/ 下的 mod 包与 manifest）：照收进暂存区，当场回 tier=hold 与原因，**不上线**；
           要上线得有人 POST /api/cdn/upload/release {id}（单向、一次性、留放行痕迹），
           放行之后仍然由发布轮逐字节核对 sha256 才落对外键
说明       what 至少 10 个字符（它会进 hosted.json 当这一组的说明）——短于 10 字当场 400。
           这不是排版洁癖：那条下限同时是发布轮与站点部署的测试闸门，短了会把整条上线通道堵红
最后一步   **传完不会自动上线**（2026-10-15 起 commit/put 的 dispatched 恒为 false）。
           必须由上传方自己再做一步，三选一：
             · 只要 R2 对外键：     POST /api/cdn/upload/kick
             · 还要推 git 镜像：    POST /api/cdn/upload/sync-mirrors
             · 收到 tier=hold 的：  先 POST /api/cdn/upload/release {id}，再 kick
           什么都不做的话，字节只停在暂存区，等 promote-uploads 的 cron 兜底
           （每日 4 窗 01/07/13/19 UTC，最坏约 6 小时）。
```

> **2026-10-15 行为变更（重要）**：`commit` / `put` 成功后**不再自动触发发布轮**。返回里 `dispatched` 固定为 `false`，并提示「已收进暂存区（尚未上线）」。要让素材真正上线、进镜像，需显式调用发布（见「两种调用方式」里的 `kick` / 新增的 `sync-mirrors`，或等 promote-uploads 的 cron 兜底（每日 4 窗 01/07/13/19 UTC，最坏约 6 小时））。

## 目录怎么归类（照上游既有结构放，不要新造）

| 放这里 | 内容 |
|---|---|
| `assets/char/avatar/` `assets/char/portrait/` `assets/char/skin_avatar/` | 干员头像 / 立绘 / 皮肤头像 |
| `assets/spine/op/` `assets/spine/enemy/` | 骨架（`.atlas` + `.skel` + 图集） |
| `assets/audio/bgm/` `assets/audio/sfx/` `assets/audio/voice/` | 音乐 / 音效 / 语音 |
| `assets/ui/` `assets/local/ui/` `assets/local/emoticon/` `assets/local/guide/` | 界面图、表情包、教程图 |
| `assets/enemy/icon/` `assets/skill/` `assets/item/` `assets/bond/` `assets/band/` `assets/token/` | 敌人图标、技能、道具、盟约、唱片、信物 |
| `assets/local/` | 不属于以上任何一类的本地素材（表情、地图、网格等按子目录继续分） |
| `fonts/` | 字体 |
| `packs/` | 打包通道用的 zip（文件名形如 `<组名>-<序号>.zip`） |

不确定就对照现成的两张表：<https://speedcdn.jiangjiangze.icu/cdn/v1/tree.json>（桶里每个目录与文件）和 <https://speedcdn.jiangjiangze.icu/cdn/v1/index.json>（上游素材 + size/sha256）。

## 两种调用方式

**1) agent 命令行**

批量（推荐，不受单请求 100 MB 上限、内建重复跳过）：

```bash
node tools/agent-upload-batch.mjs \
  --manifest=list.json                       # 每行一个 {key,file,source,what,...}
# 或
node tools/agent-upload-batch.mjs \
  --dir=./art --to=assets/char/avatar/ \
  --source=demo-mod --what="说明：这批字节是什么、出处"
# 结束再叫一次发布轮（只触发发布轮本身，不推镜像）：
node tools/agent-upload-batch.mjs --kick
```

`agent-upload-batch.mjs` 内建「重复自动跳过」：对每个目标键先对桶公开面做 `HEAD` 预检，已存在的跳过；未完成的按 ledger 续传。**批量上传后想推到镜像，建议改用后台「同步到镜像源」按钮（见 `sync-mirrors`），或手动 dispatch `git-art-sync.yml`** —— 命令行本身只把字节收进暂存区、不推 git 镜像。

单条（旧工具，仍可单文件用）：

```bash
node tools/agent-upload.mjs \
  --file=./art.png --to=assets/char/avatar/mod_x.png \
  --source=demo-mod --what="说明：这批字节是什么、出处"
node tools/agent-upload.mjs --list          # 暂存区与最近发布
node tools/agent-upload.mjs --docs          # 打这一份说明（含密钥）——路径不写死，见下
node tools/agent-upload.mjs --kick          # 催一次发布轮
node tools/agent-upload.mjs --purge=<id> --yes   # 清掉一组还没上线的暂存
node tools/agent-upload.mjs --rm=<键> --yes      # 下线一个后台上线过的键
```

> 注：旧工具里的 `--dispatch --wait` 现在不再有意义——`commit` 已经不会自动叫发布轮，等不等都没差；上传完直接拿 `--kick` 或后台按钮触发发布即可。

`--source` 会成为 `hosted.json` 里的分组 id（2–60 位字母数字 `. _ -`），也是 prune 的唯一保护名单——**不登记的文件会被例行清理当镜像残渣删掉**。

**这一份说明本身不写死路径。** 后台取的是「站点文档里提到本接口的**最新一份**」：索引在
<https://downcdn.jiangjiangze.icu/data/docs.json>（每次部署重新生成，`agentDoc` 字段就是当前这一份）。
所以要拿最新说明，用 `--docs` 或 `GET /api/cdn/upload/agent-doc`，不要记某个固定文件路径。

**2) 三次 HTTP 调用（大文件走这条，字节直传桶的 S3 端点）**

```
POST /api/cdn/upload/begin      JSON {key,size,sha256,source,note}
      → {id, putUrl, stagingKey}          # putUrl 有效 15 分钟，只对一个键有效
PUT  <putUrl>                    原始字节，不带任何自定义头
POST /api/cdn/upload/commit     JSON {id,stagingKey,key,sha256,size,source,what}
      → {id,key,tier,state,dispatched:false}   # 2026-10-15 起：commit 不再叫发布轮，dispatched 恒为 false
POST /api/cdn/upload/release    JSON {id,note}
      → {ok,key,releasedAt}               # 只放行 hold 的那一类；重复调用会被告知已放行过。
                                          # 放行只是离开 hold，不触发发布——仍需 kick / sync-mirrors 才上线
```

**新增：同步到镜像源 / 催发布（同源 + `x-admin-key`）**

```
POST /api/cdn/upload/sync-mirrors
      # 「同步到镜像源」按钮的后端：按顺序触发
      #   ① promote-uploads.yml 发布轮（暂存 → 对外键 + hosted.json）
      #   ② git-art-sync.yml --write=true（R2 → assets-raw 分支）
      # 下游镜像（openi / 魔搭数据集 / git 挂载源）由 git 链收尾步自动跟进（仅 assets-raw 真前进时才链发）
      → 202 { ok, dispatched:[{step, ok|dispatched, ...}], message }
      # 失败项在数组里逐条给 reason；幂等，可重复点

POST /api/cdn/upload/kick
      # 只触发发布轮本身（不推镜像）；保留作轻量催单用
```

浏览器另有一条一条式的 `PUT /api/cdn/upload/put?<key>&<size>&<sha256>&<source>&<what>`，body 就是文件，≤64 MiB，元数据必须在查询串里（HTTP 头不允许非 ISO-8859-1）。`put` 同样不再触发发布轮（返回 `dispatched:false`）。

## 上线节奏与核对

**发布不再由上传自动触发（2026-10-15 起）。** 以前 `commit` / `put` 成功会当场叫起 `.github/workflows/promote-uploads.yml`；批量上传时一次提交等于一轮发布，实测 5,096 件上传产生数千次 dispatch，GitHub 开始取消排队。现在 `commit` / `put` 只把字节收进暂存区（返回 `dispatched:false`，提示「已收进暂存区（尚未上线）」），发布轮改由以下三种方式之一触发：

- `POST /api/cdn/upload/kick` —— 只跑发布轮（暂存 → 对外键 + hosted.json），**不推 git 镜像**；
- `POST /api/cdn/upload/sync-mirrors` —— 先跑发布轮，再跑 `git-art-sync`（见下）；
- `.github/workflows/promote-uploads.yml` 的 **cron 兜底（每日 4 窗 01/07/13/19 UTC，最坏约 6 小时）** —— 处理暂存积压，平时主路径。

发布轮做四件事——流式重算 sha256 与声明比对 → `CopyObject` 到对外键并带 `Cache-Control: public, max-age=31536000, immutable` 与 `x-amz-meta-sha256` → 清暂存 → **把 `hosted.json` 的登记提交进 git** 并刷新 `cdn/v1/tree.json`、`cdn/v1/hosted-index.json`、`cdn/v1/upload-log.json`。

「会同步到 Git 源仓库吗？」——分两层，结论如下（链路审计，依据 `src/promote-uploads.mjs` 与 `promote-uploads.yml`）：

- **素材字节：进 git，但不是当场。** 字节从 `cdn/incoming/<id>/` 暂存区经 `CopyObject` 落到 R2 对外键（`Cache-Control: public, max-age=31536000, immutable` + `x-amz-meta-sha256`）。R2 是**当场**的权威副本；随后 `.github/workflows/git-art-sync.yml`（一天四次：01:07 / 07:07 / 13:07 / 19:07）把它们补提交进 `assets-raw` 孤儿分支，git 挂载镜像（ghfast / gitcdn / OpenI raw …）才拿得到。
  - 为什么这一环不可省：那些镜像拉的是 `assets-raw`，不是 R2。历史上曾缺 3,390 个键（约 932 MiB），由 git-art-sync 持续补齐。
  - 补的时候不检出工作树（分支是 14k 文件 / 2 GiB）：`read-tree` 进临时索引 → `hash-object -w` → `update-index --index-info` → `write-tree` → `commit-tree`，只追加提交。每个字节先与 `hosted-index.json` 的 sha256 比对，不一致就跳过——索引平面写错一个 blob sha 会静默发布空内容树而 push 仍报成功。
  - 首轮积压按 700 MiB/轮排，两轮排干；排干后每轮几秒退出。所以**新上传的素材在 git 侧最多滞后约 6 小时**，R2 侧始终即时。
- **登记元数据：会进 git。** 发布轮在本地 `fs.writeFileSync('hosted.json', …)`，然后 workflow 末尾 `git add hosted.json && git commit && git push origin main`（带重试 + rebase，冲突要人工并）。这一步**失败会让整轮变红**——因为 `prune` 只读仓库里的那份 `hosted.json`，桶里上线但 git 没登记 = 下次例行清理会把这批字节当镜像残渣删掉。
- **接口/浏览面：重发而非同步。** 发布轮最后跑 `sync.mjs --write --interface-only`，重发 `cdn/v1/tree.json`、`hosted-index.json`、`upload-log.json` 等到 R2（几十秒，不重下上游 428 MB 包）。
- **git 镜像推送只由 git-art-sync 负责。** `sync-mirrors` 与 `git-art-sync.yml` 的 cron（一天四窗）把 R2 字节补提交进 `assets-raw` 孤儿分支；**发布轮本身不再推 git 镜像**——那是 git-art-sync 的活，定时窗之外也可被 `sync-mirrors` 手动触发。

一句话：**"同步到 Git"是两条腿**——`hosted.json` 这份登记（谁传的、传了什么、键、sha256、来源）当场进 main；素材字节随后由 `git-art-sync` 一天四次补进 `assets-raw`。权威副本始终先落在 R2 桶，git 是给镜像站的第二份。要查"传上去了吗"，看 `upload-log.json` 与 `hosted-index.json`，而不是 git 历史里的文件内容。

所以「传上去了吗」只有一个答案来源：<https://speedcdn.jiangjiangze.icu/cdn/v1/upload-log.json>（后台发布记录）与 `hosted-index.json`（这些字节的摘要表）。三份摘要不一致就不会上线，日志里会留 `rejected` 原因。

## 上传后如何到达各镜像源（2026-10-15 链路）

| 阶段 | 动作 | 谁触发 | 结果 |
|---|---|---|---|
| 1 | 上传字节进暂存区 | `commit` / `put` / 直传 `put` | R2 `cdn/incoming/<id>/`（返回 `dispatched:false`） |
| 2 | 发布轮（暂存 → 对外键 + hosted.json） | `kick` / `sync-mirrors` / cron（4 窗/日） | R2 对外键 + `hosted.json` + tree/index/log |
| 3 | git 同步（R2 → `assets-raw`） | `sync-mirrors` 第二步 / `git-art-sync` cron | 字节进 `assets-raw` 分支 |
| 4 | 镜像跟随 | git 链收尾步自动 | openi（git push）、魔搭数据集（dataset-tree）、ghfast / jsDelivr / gitcdn（拉取式自动跟随） |

只有第 2 步 `kick` 也能完成；**要到齐全部镜像（第 3、4 步）必须走 `sync-mirrors`**（或等 git-art-sync 的定时窗）。`assets-raw` 没真前进时，下游镜像不会链发。完整镜像链路同步方法见站点新页 [./sync-chain](./sync-chain)。

## 收到 `tier=hold` 之后该做什么（2026-10-14 起的规则）

对外键只发静态素材；mod 包、manifest、索引这类**要经人工审计**才上线。工具侧的正确姿势：

- **别重传、别改名绕过。** `hold` 不是失败：字节已经安全落在 `cdn/incoming/<id>/`，重传只会多一份。
  把 `id`、`key`、`holdReason` 原样回报给调用方就够了。
- 想让它上线，得有人（不是 agent）在后台点「审计后放行」，或
  `POST /api/cdn/upload/release {id,note}`；放行不降标准——仍然由发布轮逐字节核对 sha256 才落键。
  **放行只是离开 hold，不会自动上线**：放行后还要 `kick` 或 `sync-mirrors` 才真正发布。
- 不想要了就清暂存：`DELETE /api/cdn/upload/staging?id=<id>`（或 `--purge=<id> --yes`），
  这些字节对外没有任何引用，删掉不影响任何玩家。
- 判据只有一处真相：`src/upload.mjs` 的 `formatVerdict()`（名单、两个素材前缀、放行后的行为都由它定，
  并有 `tests/upload-format-gate.test.mjs` 钉住）。规则细节与取舍见仓库 `docs/upload-format-gate.md`。
- **一个已知盲点**：塞进 `assets/**` 的元数据会被当素材直发（例：`assets/local/<source>/config-*.json`）。
  没有任何「前缀 + 扩展名」规则能把它和 `materials.json` 分开，所以要审计的东西请一律放 `packs/<source>/`
  ——`tools/agent-upload.mjs` 的默认键本来就是那个形状。

## 后台状态：为什么一行会停在「只传了字节、没提交」

`GET /api/cdn/upload/status` 把暂存区按 `id` 归并后，凡是**没有 `claim.json`** 的那一组就标 `awaiting-commit`（状态中文「只传了字节、没提交」），并带一句 `reason`。这行**永远上不了线**，原因是设计如此，不是报错：

- 发布机（`promote-uploads`）只处理「有 claim」的组——claim 是 `commit` 写下的「这份声明完了」凭据；
  字节先进 `cdn/incoming/<id>/` 暂存区，**没点 `commit` 就不会有任何 claim**，发布机按设计跳过它。
- 所以这一态的**唯一成因是「begin + 直传 PUT 之后没调 commit」**，不是「重复」。
  「重复 / 已存在」会在 `begin` 或 `commit` 时以 **409** 当场拒绝（最终键已存在），根本到不了这一态。
- 后台页面会在「说明」列直接写明：字节已传多大、为什么不会上线、清暂存对外零影响；
  没有字节只有残留对象的组则标为「中断的上传 / 自检残留」。**两类都只是暂存区里的垃圾，清掉不影响任何对外地址。**

> 调用方最常见的误操作：直传 PUT 请求失败后没重试就以为传完了，于是卡在 `awaiting-commit`。
> 判据很直白——这一组在 `upload-log.json` 里**不会出现**，测速 / 取数也不会引用它的键。
> 想要它上线，重新走一遍 `begin → PUT → commit` 即可；不要的就用「清暂存」按钮或 `DELETE /api/cdn/upload/staging?id=`。

## 删除

**删除只走命令行，后台页面上没有按钮 —— 这是刻意的，不是没做。** 一次误点就会把对外正在被引用的
字节拿掉，所以这条能力只留给能明确说出「删哪个」的调用方。两条命令都不加 `--yes` 时只打印将要发生什么，
不动任何字节。

| 想删什么 | 命令 | 什么时候真的删掉 |
|---|---|---|
| 一组**还没上线**的暂存 | `--purge=<上传 id> --yes` | 立刻。这些字节对外没有任何用处，没有任何清单引用它，删掉不影响任何玩家 |
| 一个**已经上线**的键 | `--rm=<键> --yes` | 由发布轮核对后删：必须在 `upload-log.json` 里、不在上游 `index.json`、且不被 `site/manifest.json` / `data/*.json` 引用。任一条不符就拒绝，并在日志里写明原因 |

上游镜像件与 APK 按需素材包删不掉——不是界面藏了按钮，是判定拒绝。

HTTP 层对应 `DELETE /api/cdn/upload/staging?id=<id>` 与 `POST /api/cdn/upload/remove {key}`；
两者都只接受同源调用，命令行请用上面的工具。
