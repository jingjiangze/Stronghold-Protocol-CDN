# 第三镜像：ModelScope 创空间（git 镜像，非运行时源）

> 续《镜像站》《第二镜像：OpenI》。前两篇讲「有哪些源、客户端怎么挑」与「OpenI 为什么默认停用」；
> 本篇记**第三镜像 ModelScope 创空间**——它和 OpenI 一样是「第二份素材树的存放地」，但定位不同：
> **它是我自己 `assets-raw` 树的一次幂等 git 镜像**（不是别人 fork 的树、也不是运行时源）。
> 它**不做玩家运行时源**，因为创空间不提供文件直链；它存在的意义是「树可被 clone / 被 git-mount CDN 挂载」。
> 事实来自 `feat/modelscope-mirror` 分支的 `tools/push-modelscope.mjs` 与 `.github/workflows/mirror-modelscope.yml`，不是估算（2026-10-11）。

---

## 一、一句话结论

- 素材树（我的 `assets-raw` 分支，14,741 文件 / ~2.14 GiB，含 2,476 个皮肤文件）由 `tools/push-modelscope.mjs` **幂等**推送到
  ModelScope 创空间 `jingjiangze/Stronghold-Protocol` 的 **`cdn` 分支**，由 `.github/workflows/mirror-modelscope.yml`
  每天四次（`cron: '23 */6 * * *'`）调用。
- **它不是运行时源**：创空间**不提供文件直链**——`/resolve/`、`/raw/`、`/tree/`、`/api/v1/.../repo/blob/` 对任意路径
  都返回同一份 ~8.6 KB 的 SPA HTML（实测）。所以它只能被 **clone / 被 git-mount CDN 挂载**，浏览器不能直连取字节。
- **源树已含皮肤，本镜像默认仍排除**：`assets-raw` 现已手工提交 **2,476 个皮肤文件**（与上游素材同树、字节一致），
  经 git-mount 层（jsdelivr-assets / ghfast-assets / gitcdn-own→OpenI）以 `coverage:full` 提供给玩家；
  但本镜像推送**默认排除 `assets/skins/**`**（`--include-skins` 开启才带），所以 ModelScope 侧暂不含皮肤；
  R2/Pages 则**同样含皮肤**（上游 release 包现已打入 `assets/skins/**`，实测与 assets-raw 字节一致）。
- 它和仓库里另一篇审计 `docs/audit/modelscope-openi-hanabi-sources.md` **不是一回事**：那篇审的是
  **Stardust fork 的 `Stardust/arknight-assets`**（对音频 0% 覆盖、只补皮肤有价值、不接运行时）；本篇是我**自己树**的镜像。

---

## 二、机制（push-modelscope.mjs）

- **幂等**：先用 `git ls-tree -r --name-only assets-raw` 枚举源树、算 sha256 指纹，与镜像分支上
  `assets.summary.json` 记录的 `treeHash` 比对；**相同就直接退出、不重传那 ~650 MiB**（零改动时一次 cron 只花一次 fetch + 一次 blob 读）。
- **字节保真为契约**：`git archive` 直接管道进一个裸 checkout，不重采样、不转码；`.gitattributes`
 （`* -text -diff -merge binary`）随树一起带走，任何平台都不能把 PNG/MP3/skel 的字节做换行归一化。
- **两个实战踩坑（已写入代码注释）**：
  - 枚举用 `ls-tree` **不是** `tar -tf`：tar 还会为目录出一行，计数会虚高（13,689 vs 真实 12,265），会把谎言写进 manifest。
  - 排除用 `grep` 过滤 `assets/skins/`，**不是** `ls-tree` 的 `':(exclude)'` pathspec——后者被该命令直接拒绝
    （"pathspec magic not supported"），`ls-files --with-tree` 又会混入 index 状态、差 120 条。
- **Windows 路径**：脚本里 `tar -x -C` 用正斜杠（Git Bash 的 tar 把反斜杠当转义，会 "No such file"）。
- **凭据**：推上去的远端 URL 带凭据（`MODELSCOPE_URL` 环境变量），脚本**绝不打印**；认证形如
  `oauth2:<token>@modelscope.cn/...`。
- **不签名**：镜像 commit 关 `commit.gpgsign`（机器生成快照；本机 gpg-agent 不可用时签名会直接让 commit 失败）。镜像本就不是溯源源——真正溯源的是 R2 原站上冻结的 `index-*.json` 快照。

---

## 3. 为什么单独一条 Workflow（不顺手塞进 sync.yml）

`sync.yml` 是 R2/Pages 原站的发布链，有自己的「镜像 → 门禁 → 发布」契约；ModelScope 是**不同目的地、不同凭据、不同失败语义**——
一次 ModelScope 推送失败，**绝不能把 CDN 标红**。所以拆成独立 `mirror-modelscope.yml`、`concurrency` 分组隔离。
它与 `sync.yml`（每 6h :17）**错开到 :23**，互不争抢。

---

## 4. 状态词与边界

- `BASELINE`：ModelScope 创空间 `jingjiangze/Stronghold-Protocol`（`cdn` 分支）、`tools/push-modelscope.mjs`、
  `.github/workflows/mirror-modelscope.yml`。
- `IMPLEMENTED`：幂等 git 镜像脚本 + 每日四次定时 + 字节保真 + 皮肤默认排除。
- `PASS`：脚本幂等逻辑（`remote._mirror.treeHash === src.hash` 直接退出）、`ls-tree`/`grep`/正斜杠三处踩坑已修正。
- `PENDING`：
  - **分支未合入 `origin/main`**：`feat/modelscope-mirror` 含 workflow + tool 但 cron 尚未生效；按纪律未直接动 main。
  - **皮肤补充**：默认排除 `assets/skins/**`，待 `--include-skins` 增量追加（上游皮肤集完整时）。
  - **完整 2.2 GB 数据集上传**：本镜像按 `assets-raw` 推（非那一份 2.2 GB 本地源），故不受其 C 盘占用约束；
    若日后要扩到全量本地源，脚本与分批策略需重新评估。
  - **不接运行时源**：本篇镜像**不写进 `origins.json`**——创空间无文件直链，浏览器取不到字节，所以只作
    git-mount / clone 用途，不是玩家可见的素材源。

---

## 5. 验收

```bash
# 1. 幂等：树未变时一次 cron 只花费一次 fetch + 一次 blob 读，输出 "mirror already carries this exact tree"
node tools/push-modelscope.mjs --dry-run        # 本地预览：准备 N 文件、不推送

# 2. 真推送（需要 MODELSCOPE_URL 带凭据，脚本不打印）
MODELSCOPE_URL='oauth2:<token>@https://www.modelscope.cn/studios/jingjiangze/Stronghold-Protocol.git' \
  node tools/push-modelscope.mjs                 # 默认不含皮肤
# 含皮肤（仅上游皮肤集完整时）：追加 --include-skins

# 3. 确认是 git 镜像而非直链源：创空间文件路径返回 SPA HTML，不是字节
curl -s https://www.modelscope.cn/studios/jingjiangze/Stronghold-Protocol/resolve/cdn/assets/char/avatar/char_1016_agoat2.png | head -c 200
```
