# 第二镜像：OpenI（启智）素材树（2026-10-11）

> 续《镜像站》与《多源自动选源》。那两篇讲「有哪些源、客户端怎么挑」；本篇专门记**第二镜像 OpenI**：
> 它是测过最快的源，也是唯一 CORS 不可用的源。快是它的价值，CORS 是它的边界。
> 事实来自 `feat/openi-mirror` 分支的源码、Workflow 与实测，不是估算。

---

## 一、一句话结论

- 素材树（**12,706 文件 / ~915 MiB**）已幂等同步到 OpenI 仓库
  `jingjiangze/Stronghold-Protocol` 的 **`assets-raw`** 孤儿分支，由 `.github/workflows/openi-mirror.yml`
  每天四次（`cron: '47 0,6,12,18 * * *'`）推送。
- 它**默认停用**：`origins.json` 里 `id: "openi"` 带 `enabled: false`，且同时写进 `disabled` 数组。
  原因只有一个——**CORS 硬伤**（见 §四），不足以当玩家运行时源；现在只用于**直链下载 / 构建期取源**。
- 实测它**最快**：TTFB ~0.25 s，对比本桶 R2 主源 1.1–8.1 s，快约一个数量级；字节逐字节一致
  （40 条路径抽样 sha256 全一致）。

---

## 二、接入形态与配置

`origins.json` 条目（节选，与 `feat/openi-mirror` 已发布配置一致）：

```json
{
  "id": "openi",
  "kind": "git",
  "root": "https://openi.pcl.ac.cn/jingjiangze/Stronghold-Protocol/raw/branch/assets-raw",
  "probe": "/assets/char/avatar/char_1016_agoat2.png",
  "coverage": "full",
  "enabled": false,
  "assets-ref": "assets-raw",
  "note": "OpenI（启智）raw 挂载：本仓素材树由 openi-mirror.yml 每天四次推送。实测 TTFB ~0.25s、字节逐字节一致（sha256 核对）、覆盖 full —— 但它把 Access-Control-Allow-Origin 写死成第三方域 experience.pro.iflyaicloud.com，不反射请求方，且二进制（png/skel）忽略 Range（文本才回 206）。因此默认 enabled:false：浏览器跨域取 WebGL 贴图会被 CORS 拒绝，只能用于直链下载/构建期取源，不能作玩家运行时源。若平台日后改 CORS 或改由自有域中转，改这一处即可。"
}
```

`disabled` 数组（双写防静默启用——两条发布链读的位置不同，主链读条目自身 `enabled`，多源链读 `disabled` 列表）：

```json
"disabled": [ "jsdelivr", "jsdelivr-assets", "openi" ]
```

> 双写是必要的：`disabled` 列表与条目 `enabled:false` 是两处来源；只写一处，下一次由另一条链发布的
> `mirrors.json` 就可能把它当成可用源放出。两条都写成，不论主链还是多源链先发布，它都不会被选中。

---

## 三、同步机制（openi-mirror）

- `src/openi-mirror.mjs`：**幂等推送器**。它解出本地 `assets-raw` 的 commit sha、与远端比对，
  **相同就直接退出、不重传那 915 MiB**；只有当天美术真变了（每天四次里通常零次）才推。
- 字节取自 **git 自己**（就是当初发布所依据的 `assets-raw` 孤儿分支），**不回读 CDN**——
  避免把 CDN 抖动当成内容发布。
- 凭据走 **环境变量 `OPENI_TOKEN`**，用完即写进远端 URL、不落 `.git/config`（`git remote set-url`
  会把 token 留在本地配置里，后续步骤会泄漏）。
- 与 `sync.yml`（每 6 小时 :17）**错开**（:47），避免读到对方发布到一半的状态。
- 默认 **`--dry-run`**：只读、零写入、不需凭据；真上传要 `--write`（或定时任务自动 `--write`）。

---

## 四、为什么默认停用（CORS 硬伤）

实测（带 / 不带 `Origin: https://weishucdn.jiangjiangze.icu`，结果一致）：

```
Access-Control-Allow-Origin: https://experience.pro.iflyaicloud.com
```

这是**写死的第三方域**，不反射请求方、也无 `Vary: Origin`。后果：浏览器跨域拿不到响应——对本项目就是
那句老问题：**WebGL 贴图被污染，棋盘静默变白**。所以它**不能作为玩家运行时源**。

另外两个缺陷，影响有限：
- **Range 缺失**：二进制（png/skel）忽略 Range，只文本回 206。客户端按整文件取，影响不大；音频 seek 场景不能用它。
- 配额：未验证仓库容量上限（当前 915 MiB；后续加皮肤可能到 ~2.1 GiB）。

---

## 五、状态词

- `BASELINE`：OpenI 仓库 `jingjiangze/Stronghold-Protocol`（`assets-raw` 分支）、`src/openi-mirror.mjs`、
  `.github/workflows/openi-mirror.yml`、`origins.json` 的 `openi` 条目（`enabled:false` + `disabled` 双写）。
- `IMPLEMENTED`：素材树已推送（12,706 文件 / ~915 MiB）、幂等同步上线、字节逐字节一致、入 `origins.json` 默认停用。
- `PASS`：平台能力实测（匿名 clone / SSH 推送 / raw 挂载 / 字节保真 / TTFB ~0.25 s）；`tests/openi-mirror.test.mjs`
  与 `tests/origins.test.mjs` 新增用例全绿。
- `PENDING`：
  - **CORS 绕过**：两条路（自有域 Worker 中转补 `ACAO:*` 如 `gitcdn-own` / 等平台修）都没做；做完后 OpenI 才最快可用。
  - **CI 凭据**：`OPENI_TOKEN` 未配时定时任务在 `git ls-remote` 处失败（失败安全，不会误发）。
  - 分支 `feat/openi-mirror` **尚未合入 `origin/main`**：`origins.json` 的 `openi` 条目与 `disabled` 双写目前只在那条分支；
    主链 `mirrors.json` 尚未把它列为可用源。合入前，`disabled` 对线上无影响（线上根本没有这个源）。

---

## 六、验收

```bash
# 1. 仓库存在且 raw 可达（应 200 + 正确 MIME）
curl -sI https://openi.pcl.ac.cn/jingjiangze/Stronghold-Protocol/raw/branch/assets-raw/assets/char/avatar/char_1016_agoat2.png | grep -iE "HTTP|content-type"

# 2. 字节保真：raw 取回与本地 git blob sha256 一致
git -C <本地仓> cat-file blob $(git -C <本地仓> rev-parse assets-raw:assets/char/avatar/char_1016_agoat2.png) | sha256sum
curl -s https://openi.pcl.ac.cn/jingjiangze/Stronghold-Protocol/raw/branch/assets-raw/assets/char/avatar/char_1016_agoat2.png | sha256sum

# 3. CORS（应看到写死的第三方域，证明它不能当运行时源）
curl -sI -H "Origin: https://weishucdn.jiangjiangze.icu" https://openi.pcl.ac.cn/jingjiangze/Stronghold-Protocol/raw/branch/assets-raw/assets/char/avatar/char_1016_agoat2.png | grep -i "access-control-allow-origin"
```
