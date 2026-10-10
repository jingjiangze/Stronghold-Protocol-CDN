# agent 接入 · 上传静态素材（只新增，按原结构分类）

给自动化工具用的上传通道说明。复制这一段给 agent 就够它自己干活：

```
后台基址   https://downcdn.jiangjiangze.icu
接口鉴权   请求头 x-admin-key: <直连后台密钥>
上传目录   只能是 assets/ 、fonts/ 、packs/ 三个前缀之下
键名规则   与上游部署树一致：assets/<类>/<子类>/<文件名>（不要自己造新的顶层目录）
必须自带   size（字节）与 sha256（64 位十六进制）——发布机会逐字节核对，不符就不上线
禁止       覆盖已存在的键、删除键、写 cdn/ data/ apk/ site/ scout/ 这些契约与其它产品线的键
扩展名     只收素材：png jpg jpeg webp gif atlas skel json txt mp3 ogg wav m4a woff woff2 ttf otf zip bin data xml
           （.html/.svg/.js 一律拒：这个域名对全世界发 ACAO *，放可执行内容等于在自己的域上开 XSS 位）
```

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

不确定就对照现成的两张表：<https://weishucdn.jiangjiangze.icu/cdn/v1/tree.json>（桶里每个目录与文件）和 <https://weishucdn.jiangjiangze.icu/cdn/v1/index.json>（上游素材 + size/sha256）。

## 两种调用方式

**1) agent 命令行（推荐，不受单请求 100 MB 上限）**

```bash
node tools/agent-upload.mjs \
  --file=./art.png --to=assets/char/avatar/mod_x.png \
  --source=demo-mod --what="说明：这批字节是什么、出处" \
  --dispatch --wait
node tools/agent-upload.mjs --list          # 暂存区与最近发布
node tools/agent-upload.mjs --docs          # 打这一份说明（含密钥）——路径不写死，见下
node tools/agent-upload.mjs --kick          # 催一次发布轮
node tools/agent-upload.mjs --purge=<id> --yes   # 清掉一组还没上线的暂存
node tools/agent-upload.mjs --rm=<键> --yes      # 下线一个后台上线过的键
```

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
```

浏览器另有一条一条式的 `PUT /api/cdn/upload/put?<key>&<size>&<sha256>&<source>&<what>`，body 就是文件，≤64 MiB，元数据必须在查询串里（HTTP 头不允许非 ISO-8859-1）。

## 上线节奏与核对

**发布是触发式的**：`commit` / `put` / `remove` / `kick` 任一发生，都会当场叫起 `.github/workflows/promote-uploads.yml`（靠 Pages secret `GH_DISPATCH_TOKEN` + `GH_REPO`；没配就退回定时兜底，定时是每半小时的保险，不是主路径）。一轮做完若还有积压会立刻自补一轮排干。它做四件事——流式重算 sha256 与声明比对 → `CopyObject` 到对外键并带 `Cache-Control: public, max-age=31536000, immutable` 与 `x-amz-meta-sha256` → 清暂存 → **把 `hosted.json` 的登记提交进 git** 并刷新 `cdn/v1/tree.json`、`cdn/v1/hosted-index.json`、`cdn/v1/upload-log.json`。

所以「传上去了吗」只有一个答案来源：<https://weishucdn.jiangjiangze.icu/cdn/v1/upload-log.json>（后台发布记录）与 `hosted-index.json`（这些字节的摘要表）。三份摘要不一致就不会上线，日志里会留 `rejected` 原因。

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
