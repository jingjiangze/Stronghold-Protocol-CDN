# 审计：把素材树镜像到 OpenI（openi.pcl.ac.cn/jingjiangze/Stronghold-Protocol）

日期：2026-10-11（实测 2026-10-11 02:20–03:10 CST）
状态词：`BASELINE` / `PASS` / `FAIL` / `PENDING` / `[ASSUMED]`，每条结论附证据。

---

## 0. 结论摘要（先读这里）

| 问题 | 结论 |
|---|---|
| 内容能不能传上去？ | **能**。`915 MiB / 12,706 文件`已推送到分支 `assets-raw` |
| 字节对不对？ | **对**。raw 取回与本地 git blob 逐字节一致（sha256 核对） |
| 快不快？ | **很快**。TTFB ~0.25s；同一文件在 R2 主源是 **1.1–8.1s** |
| 能不能给玩家当运行时源？ | **不能（默认停用）**。CORS 是硬伤，见 §4 |
| 那它用来干什么？ | 直链下载 / 构建期取源 / 国内快速回源；已入 `origins.json` 但 `enabled: false` |

**一句话**：OpenI 是这次测过**最快的**源，也是**唯一 CORS 不可用**的源。快是它的价值，
CORS 是它的边界。它已被接入并默认停用，改一行就能启用 —— 前提是先把 CORS 问题绕过去。

---

## 1. 这次和上次审计（2026-10-11 早些时候）的区别

`BASELINE`：本仓已有一份审计 `docs/audit/modelscope-openi-hanabi-sources.md`，结论是「**OpenI 不接入**」。

那次与这次不是同一件事，不要混为一谈：

| | 上次审计 | 这次 |
|---|---|---|
| 目标仓库 | **别人的** `Stardust/arknight-assets` 数据集 | **我自己的** `jingjiangze/Stronghold-Protocol` |
| 依赖 | fork 自部署的 resolver（302 到签名 OBS） | 平台自带的 raw 端点 |
| 否决理由 | 公开路径 404；要依赖第三方解析器存活 | 不适用——自有仓库，路径我定 |

`PASS`：上次的两条否决理由对本次**均不成立**（自有仓库、平台原生 raw）。
因此本次结论是对上次的**范围修正**，不是推翻：上次否的是「借别人的 OpenI 数据集」，
这次做的是「在自己的 OpenI 仓库上放一份自己的镜像」。

---

## 2. 平台能力实测

`BASELINE`：仓库 2026-10-11 01:59 建好，初始仅一个模板 README；`push/admin = true`（API 实测）。

| 能力 | 实测结果 | 判定 |
|---|---|---|
| 匿名 git 只读 | `git clone --depth 1` 成功 | `PASS` |
| SSH 推送 | `git@code.openi.org.cn` 认证通过（`Hi there, jingjiangze!`） | `PASS` |
| raw 挂载 | `/raw/branch/<branch>/<path>` → 200，MIME 正确（`image/png`） | `PASS` |
| **字节保真** | 65,270 B PNG 往返，sha256 **逐字节一致** | `PASS` |
| **TTFB** | 5 次：0.245 / 0.251 / 1.140 / 0.269 / 0.261 s | `PASS` |
| Range | 文本 206（`bytes 0-4/17`）；**二进制（png）返回 200 并忽略 Range** | `FAIL` |
| **CORS** | `ACAO: https://experience.pro.iflyaicloud.com` **写死，不反射 Origin** | `FAIL` |
| Git LFS | `/info/lfs/objects/batch` → 401/400，未启用 | 不适用 |
| 单文件 | 最大 11.2 MB，推送无报错 | `PASS` |

### 2.1 延迟对比（同一台机器、同一时段）

```
OpenI  raw   ttfb 0.245–0.261 s   （65 KB PNG）
R2     主源  ttfb 1.15–8.07 s     （同一路径 /assets/char/avatar/char_1016_agoat2.png）
gitcdn 自有  ttfb 1.16–2.03 s
```

`PASS`：OpenI 比现有主源快**一个数量级**。这解释了为什么值得为它花 915 MiB 的推送成本。

---

## 3. 为什么用 git push，而不是「从 CDN 回读再上传」

`ASSUMED` 被否决的设计：读 CDN → 写镜像。

三条理由，按重要性：

1. **它把 CDN 变成自己副本的真源**。CDN 每次抖动都会被镜像出去，一次部分故障会被当成内容发布。
2. **素材本来就在 git 里**。`assets-raw` 孤儿分支就是 CDN 当初发布所依据的那批字节，
   直接推这个 commit 即可，一个字节都不用从网络取。
3. **重造轮子会出错**。第一版脚本用 `hash-object --stdin` 逐文件重建 commit，
   实测写出的是**空 blob**（`e69de29…`），靠断言才拦住。git 自己的 pack 传输更快也更可靠。

`PASS`：脚本 `src/openi-mirror.mjs` 因此只做三件事：解出 `assets-raw` 的 commit sha、
与远端比对、相同就退出。

### 3.1 为什么默认推 `assets-raw` 分支而不是 `master`

`BASELINE`：远端 `master` 上有一份人类可读的 README。

`FAIL`（一次已发生的误操作）：审计过程中我曾用 `--force` 把探针分支推到 `master`，
覆盖了那份 README。已**完整还原**——用 API 取回原 base64 重建提交，
还原后 blob sha `687c67cb4ea976fee424ab5243681b9a080d88a9` 与原始值**逐字相同**，
README 重新 200。教训写进了脚本默认值：默认分支改为 `assets-raw`，
README 所在分支不再被任何自动化触碰。

---

## 4. CORS：为什么默认停用（`enabled: false`）

实测（带 `Origin: https://weishucdn.jiangjiangze.icu` 与不带，结果一致）：

```
Access-Control-Allow-Origin: https://experience.pro.iflyaicloud.com
```

`FAIL`：这是**写死的第三方域**，不反射请求方，也没有 `Vary: Origin`。后果是浏览器
跨域拿不到响应 —— 对本项目就是那句老问题：**WebGL 贴图被污染，棋盘静默变白**。
（既有记录见：网页端棋盘无贴图（CDN 跨域污染），根因是缺 `crossOrigin` +
源站没给对的 ACAO。本源的 ACAO 给的是**别人的域**，等于没给。）

因此 OpenI **不能作为玩家运行时源**。它在 `origins.json` 里带 `enabled: false`：

- 站点与选源器会照常列出它、照常测速（数据有用），但**不会被选中**；
- 想启用时只需把那一处改成 `true` **并且**先把 CORS 绕过去。

绕过的两条路（`PENDING`，都不在本次范围）：

1. **自有域中转**：让 `git-mount-relay` 增加 OpenI 后端，由 Worker 补 `ACAO: *`。
   与现有 `gitcdn-own` 同一套路，代价是 Worker 请求预算。
2. **等平台修**：OpenI 修好 ACAO 反射后改一行即可。

---

## 5. 接入形态

| 形态 | 判断 |
|---|---|
| A. 运行时默认素材源 | **否决**：CORS 硬伤（§4） |
| B. 不接入 | **否决**：它是实测最快的源（§2.1），且已建成自有仓库 |
| **C. 镜像 + 入 origins.json（默认停用）+ 每天四次自动同步** | **采纳** |

`PASS`（已落地）：

- `src/openi-mirror.mjs` —— 幂等推送器；远端已是同一 commit 时直接退出，不传 915 MiB。
- `.github/workflows/openi-mirror.yml` —— `cron: '47 0,6,12,18 * * *'`，每天四次；
  与既有 `sync.yml`（每 6 小时 :17）错开，避免读到对方发布到一半的状态。
- `origins.json` —— 新增 `openi` 条目，`coverage: full`、`enabled: false`、原因写进 `note`。
- `tests/openi-mirror.test.mjs`（8 项）、`tests/origins.test.mjs` 新增 2 项，全绿。

---

## 6. 已知待办（`PENDING`）

- **CORS 绕过**：§4 的两条路，未做。做完后 OpenI 就是最快的可用运行时源。
- **Range 缺失**：二进制忽略 Range。对本项目影响有限（客户端按整文件取），
  但音频 seek 场景不能用它。
- **CI 凭据**：workflow 需要仓库 secret `OPENI_TOKEN`（用账号 Access Token）。
  未配置时定时任务会在 `git ls-remote` 处失败 —— 失败是安全的（不会误发），但要配了才跑得起来。
- **配额**：未验证仓库容量上限。当前 915 MiB；若后续加皮肤可能到 ~2.1 GiB，
  届时需确认平台是否仍接受。
