# 审计：OpenI 的 CORS 能否绕过（2026-10-11）

**问题**：`openi.pcl.ac.cn` 实测是最快的源（TTFB ~0.28s），但 `Access-Control-Allow-Origin`
写死成第三方域 `experience.pro.iflyaicloud.com`，浏览器跨域取不到 → 贴图被污染、棋盘白屏
（机理同 [[web-cdn-art-webgl-taint]]）。要不要上一台服务器转发来补 `ACAO`？

**结论：`BASELINE` 不需要转发。** 转发要花 Worker 请求数 + 双倍出网 + 一跳延迟，
而收益（OpenI 相对 R2 的速度优势）被重测**证伪了一半**。真正该做的是把
**不需要 CORS 的通道**切到 OpenI。下面按证据展开。

---

## 1. 源头没有任何 CORS 出口（`FAIL`，穷举过）

2026-10-11 试了 5 种 URL 形态，全部返回同一个写死的头：

| 形态 | 结果 |
|---|---|
| `/raw/branch/<b>/<path>` | 200，`ACAO: https://experience.pro.iflyaicloud.com` |
| `/media/branch/<b>/<path>` | 200，同上 |
| `/raw/branch/...?raw=1` | 200，同上 |
| `/raw/commit/<sha>/<path>` | 404 |
| `/api/v1/repos/.../raw/<path>?ref=` | 404 |

两条判据钉死结论：

1. **不带 `Origin` 请求也返回 `ACAO: https://experience.pro.iflyaicloud.com`**
   → 证明是**写死**，不是反射。反射源在不带 Origin 时不该回 ACAO。
2. **`OPTIONS` 预检直接 401**
   ```
   curl -X OPTIONS -H "Origin: https://weishucdn.jiangjiangze.icu" \
        -H "Access-Control-Request-Method: GET" <url>   →  HTTP/1.1 401 Unauthorized
   ```
   平台把预检当鉴权请求挡了。

也试过换主机（`raw.` / `git.` / `cdn.openi.pcl.ac.cn`、`code.openi.org.cn`）——
除 `openi.pcl.ac.cn` 外**全部 `000`**（不存在或不可达）。

**这是平台级配置缺陷**（漏 `Vary: Origin` + ACAO 反射，被某个第三方业务钉死），我们改不了。

## 2. 收益被重测证伪了一半（推翻我自己上一份审计的数字）

上一份审计写「R2 1.1–8.1s vs OpenI 0.25s，快一个数量级」。
那份数是**走本机 Clash 代理**测的。直连（`--noproxy '*'`）重测：

| 源 | 走代理 | 直连 |
|---|---|---|
| R2 主源 `weishucdn.jiangjiangze.icu` | 1.18–1.23 s | **0.62–0.65 s** |
| OpenI | 0.26–0.28 s | 0.27–0.41 s |

**直连下差距只有 ~2.5×，不是 10×。** 8.1s 那个数是 Clash 节点的锅，不是 R2 的。
（本机代理会显著放大跨境时延，见 [[new-provider-relay-flaky]] 同族。）

## 3. 中继的实际开销（实测，非估算）

现有自建中继 `gitcdn.jiangjiangze.icu`（`worker/git-mount-relay.worker.mjs`）
本来就发 `ACAO: *`，加一组 openi 后端即可 —— 技术上可行。但实测开销：

| 源 | TTFB（3 次） |
|---|---|
| R2 直连 | 0.624 / 0.645 / 0.638 s |
| OpenI 直连 | 0.299 / 0.269 / 0.409 s |
| 现有 relay | **1.920 / 0.785 / 0.712 s** |

**中继一跳就把 OpenI 的优势吃光了**（0.28s → ~0.7s，与 R2 持平甚至更差），
还要付 Worker 请求数翻倍 + 出网流量走一遍 CF。

### 附带发现：relay `/assets` 间歇 502（`PENDING`，非稳定故障）
首轮测量时：
```
GET https://gitcdn.jiangjiangze.icu/assets/...   → 502
GET https://gitcdn.jiangjiangze.icu/README.md    → 200
```
怀疑后端 `jsdelivr-assets` 对该路径返回 301（跳 raw.githubusercontent.com）而 relay 未跟随。
但**紧接着连续 5 次复测全部 200**，TTFB 0.65 / 0.92 / 0.70 / 0.66 / 0.66 s。
→ 判定为**间歇性**故障，不是稳定的 301 处理缺陷。记 `PENDING`：
需要一次带时间戳的记录确认它与「jsdelivr-assets 后端抖动」同相（该后端本来就最慢、
已被 `disabled` 停用，见 `origins.json`）。**本次不据此改 relay。**

## 4. 第三方 git-mount CDN 帮不上

`jsdelivr.net/gh/` 只能挂 GitHub —— 对 OpenI 仓库名返回 301（跳 GitHub，仓库不存在）。
`cdn.statically.io` 已死（`000`）。**OpenI 只能靠自建转发**，没有白嫖路径。

## 5. 另一条路：ModelScope 的 dataset/model 有 `ACAO: *`

实测对照组：
```
GET https://www.modelscope.cn/models/<x>/<y>/resolve/master/... → 404
Access-Control-Allow-Origin: *
```
**`ACAO: *` 是真的**（虽然这个具体仓库 404）。但注意
[[modelscope-studio-no-raw-urls]]：你现有的 ModelScope 镜像是**创空间（studio）**，
studio 的 `/resolve/` `/raw/` 全返回 8.6 KB SPA HTML，**没有直链**。
只有 **dataset / model** 类型才有真实字节。

→ 想走这条路，得**另开一个 dataset 或 model 仓**（不是把现有 studio 改类型）。
这是本次审计外的新增项，列 `PENDING`。

---

## 6. 决策

| 方案 | 判定 | 理由 |
|---|---|---|
| A. 上 Worker 转发 OpenI | **不做** | 一跳吃掉全部速度优势，还要付请求数+出网 |
| B. 维持 `enabled:false`，只当冷备/直链 | **采纳（现状）** | R2 直连 0.64s 够用，不值得折腾 |
| C. **非浏览器通道直接用 OpenI** | **降级为 `PENDING`** | 本仓内**没有真实调用点**，见 §6.1 |
| D. 等平台修 CORS | 记 `PENDING` | 可提 issue，别指望 |
| E. ModelScope dataset 仓 | `PENDING` | 有 `ACAO: *`，但需另开仓 |

### 6.1 方案 C 的修正（审计过程中自我推翻）

初稿说「非浏览器通道现在就能指向 OpenI，白捡 2.5×」。**查证后这话在本仓不成立**：

- `src/sources.mjs` 的 `fetchSourcePackage()` 走 `gh release download` —— 从 **GitHub**
  拉发布包，**不从我们的 CDN 拉**。切到 OpenI 无从谈起。
- `SP_ASSET_CDN` 看起来是服务端开关，但按 `docs/INTEGRATION.md`：它把清单里的
  `/assets/…` **改写成绝对 CDN URL**，客户端（浏览器）随后**直取**该 URL。
  → 取字节的仍是浏览器，**照样要 CORS**。不能算非浏览器通道。
- 真正不受 CORS 约束的只有 **`packs/*.zip` 给人下载**（下载站 / 用户点击 / curl），
  但那走的是 R2 与 GitHub release 双写，与 OpenI 无关。

**结论：本仓范围内没有可切的非浏览器素材通道。** 方案 C 只有在 APK 打包仓
（`stronghold-apk`）或盒子侧存在「Node 拉取素材」流程时才成立 —— 那是跨仓事项，
不在本次改动范围内，记 `PENDING` 并写明需要什么前提。

---

## 7. 真 bug：自动同步从未真推过（`IMPLEMENTED` 已触发）

审计触发的验证跑暴露：本地 `assets-raw` 已 **14,043 文件 / 1,727.1 MiB**，
而 OpenI 远端仍停在上次手推的 **915 MiB**（commit `7663627cb6`）——
也就是素材翻了近一倍，自动同步一次都没真推过。

**这不是 bug，是设计如此**：workflow 的 `workflow_dispatch` 默认 `write=false`（dry-run），
只有 `schedule` 才自动带 `--write`。而定时任务配好之后还没到点。
已手动触发 `write=true`（run 38080231681）验证。

### 顺带证伪/证实
- **凭据链路 `PASS`**：dry-run 那次读到 `OPENI_TOKEN`，`ls-remote` 成功，0 字节传输退出。
- **1.7 GiB 能否推进去**：`PENDING` → 该 run 正在验证（本次审计时已跑 11.7 分钟）。
- **耗时约束**：1.7 GiB 全量传需 ~12 分钟以上，`timeout-minutes: 90` 有余量，
  但每次素材变更都要全量重传（孤儿分支无增量）。四次/天意味着**最坏 4×12 分钟**的上传。
  幂等比较（commit sha 相同即退出）保证**没变更时 0 字节**，这是成本控制的关键。

Related: [[openi-mirror]]、[[modelscope-studio-no-raw-urls]]、[[web-cdn-art-webgl-taint]]、
[[stronghold-cdn-git-relay]]、[[stronghold-asset-cdn-reconcile]]
