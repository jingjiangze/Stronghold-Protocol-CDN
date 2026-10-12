# 逐源素材清单（每个源实际有什么）

> 日期：2026-10-12 · 全部数字为本机实测，不是估算。
> 权威清单（真源）：`https://weishucdn.jiangjiangze.icu/cdn/v1/{index,tree,mirrors}.json`
> 内容令牌：`v0.2.4-12de1b73`（index.json / tree.json 带头ängerfield-consistent token 版本）
> **测量口径**：一律 `curl --noproxy '*'` + 浏览器 UA。**不绕过本地代理会得到假 000**；
> **不带 UA 会被 ms-edge 挡成 403**（curl 默认 UA 命中平台拦截）。

---

## 一、先把「清单」这个词拆开：三份文件不是同一件事

最容易搞混的一点：仓里有**三份**都叫「清单」的东西，口径互不相同。混用就会得出错误结论。

| 文件 | 内容 | 键数 / 文件数 | 谁用 |
|---|---|---|---|
| `index.json` | `{路径: {size, sha256}}` | **12,583** | 逐字节校验、做二级镜像 |
| `tree.json` | `dirs[目录] = {bytes, files:[[名,体积,mod?]]}` | **20,130** / 3,243 目录 | 浏览目录、算体积 |
| `mirrors.json` | `flat[]` 源清单 + `packs[]` 打包通道 | 11 个源 | 客户端选源 |

### 为什么两个数字差了 7,547 —— 这是设计，不是缺陷

```
index.json (12,583)  ⊂  tree.json (20,130)
差额 = 7,547 = tree.totals.hosted（完全一致，逐条比对）
```

`mod=1` 标记 = **本站刻意托管、上游永远不会收录的内容**（替 mod 代的美术等）。
`src/hosted.mjs` 的注释写明了原因：prune 清理会把它当残余删掉，所以它必须单独登记（附理由），
否则「一次例行清理会顺手毁掉别人的内容」。

**逐条验证结论**（三者完全重合，无例外）：

- `tree.json` 里 `mod=1` 的条目：**7,547**，其中在 `index.json` 里的 **0**；
- `tree.json` 里无 `mod` 标记的：**12,583**，全部都在 `index.json` 里；
- 只在 `index.json` 里、而不在 `tree.json` 里的：**0**。

> **所以**：拿 `index.json` 做「校验清单」是对的；拿它当「桶里有什么」的清单是错的 ——
> 会漏掉 7,547 个自有文件（含 **1,856 个皮肤文件 / 1,158 MiB**，这是本站最值钱的自有内容）。
> 要「全量」用 `tree.json`；要「校验」用 `index.json`。

---

## 二、桶里到底有什么：20,130 个文件的分类

数据来自 `tree.json`（全量口径，`assets/` 下 19,976 个 / 2,849.5 MiB）：

| 分类 | 目录数 | 文件数 | 体积 | 备注 |
|---|---:|---:|---:|---|
| skins | 625 | 1,856 | **1,158.4 MiB** | 全部属 `hosted`，不在 index.json |
| spine | 1,554 | 4,880 | 534.8 MiB | 含较多 hosted |
| packs | 1 | 23 | 464.8 MiB | 打包通道产物 |
| local | 529 | 3,142 | 282.7 MiB | 含较多 hosted |
| audio | 408 | 6,488 | 194.1 MiB | p_atk/p_imp 等音效多属 hosted |
| char | 5 | 1,393 | 100.3 MiB | |
| ui | 45 | 606 | 39.2 MiB | |
| docs | 3 | 46 | 32.8 MiB | **只在 R2 / Pages** |
| enemy | 1 | 502 | 21.1 MiB | |
| skill | 1 | 573 | 10.5 MiB | |
| band / pack / token / relics / item / prof / bond / module / icons | — | 377 | 10.8 MiB | 合计 |

另有 **`packs/`**（非 `assets/`）的内容包目录，以及 `index.json` 里 **13 个非 `assets/` 键**
（`docs/*.md`、`fonts/*.ttf|woff2|otf`、`fonts/fonts.css`）。

---

## 三、逐源清单：每个源实际能提供什么

实测方法：19 个分类各取一个代表文件，逐源取字节（`redirect: follow`），看最终是否 200。
**「19/19」= 该源覆盖全部 19 个分类。**

| 源 id | 类型 | base | 实测覆盖 | mirrors 声明 | 是否一致 |
|---|---|---|---:|---|---|
| **r2** | r2 | `weishucdn.jiangjiangze.icu` | **19/19** | partial | ⚠️ 见下 |
| **r2-alt** | r2 | `weishucdn2.jiangjiangze.icu` | **19/19** | partial | ⚠️ 同上 |
| **ghfast-assets** | git | `ghfast.top/…@assets-raw` | **19/19** | full | ✅ |
| **jsdelivr-assets** | git | `cdn.jsdelivr.net/…@assets-raw` | **19/19** | full | ✅ |
| **gitcdn-own** | git | `gitcdn.jiangjiangze.icu` | 19/19（但极慢） | full | ⚠️ 性能问题 |
| **openi** | git | `openi.pcl.ac.cn/…/assets-raw` | **12/19** | full | ❌ 声明不实 |
| **ms-dataset** | cdn | `modelscope.cn/datasets/…/v1-trial` | **11/19** | full | ❌ 声明不实 |
| **ms-edge** | cdn | `jingjiangze-…ms.show` | **11/19**（302 层） | full | ⚠️ 依赖下游 |
| **pages** | pages | `spages.jiangjiangze.icu` | **11/19** | partial | ❌ 比 r2 少 |
| **speedcdn** | （未注册） | `speedcdn.jiangjiangze.icu` | 与 r2 字节全同 | — | 见第五节 |

### 各源逐条说明

**r2（`weishucdn`）** — 唯一权威。19/19 全通，含 `docs/`、`fonts/`、`assets/packs/`。
也是唯一的接口真源（`/cdn/v1/**`）。`index.json` 的 sha256 以它为准。

**r2-alt（`weishucdn2`）** — 第二个 R2 自定义域，19/19 全通，与 r2 同桶。

**ghfast-assets / jsdelivr-assets** — 都是 19/19。挂载 `assets-raw` 孤儿分支。
注意：它们**也提供 `fonts/`**（实测 `fonts/bender-regular.woff2` 200），
与文档里「`docs`/`fonts` 只在 R2/Pages」的说法不符 —— 那条结论需要更正。
`docs/` 确实 404。

**gitcdn-own** — 自托管 git-mount。可取全部分类，但速度很差：
`assets/band/band_amedic.png` 4.6s、`char_002_amiya.png` 14.1s、
`packs/audio.bgm-4.zip` **90 秒未完成**。覆盖是覆盖住了，实际可用性低。

**openi** — **12/19，与 `mirrors.json` 声明的 `full` 不符**。缺 7 类，且**恰好是打开 numpy 的包**：
`char`、`docs`、`icons`、`item`、`pack`、`packs`、`relics`。

**ms-dataset** — **11/19，同样与声明的 `full` 不符**。
这些文件有一部分本就不在 index.json（属 hosted），但也有确属缺口的部分。
数据集本身**已公开可读**（见第六节）。

**ms-edge** — **不是素材源，是 302 分流层**。自己不存字节；
它的 11/19 是「它指到的下游（默认 = ms-dataset）能给多少」的镜像值。
这一点必须说清：`?sp_source=r2` 能让它指到 r2 拿到全量，但这不代表 ms-edge 自己有。

**pages** — **11/19，比 r2 少 8 类**（缺 `char`/`docs`/`icons`/`item`/`pack`/`packs`/`relics`/`local`）。
重要：pages 是**文档中 major-gripes 的部署面**，但它比 r2 少东西 ——
如果客户端降级到 pages，这几类素材会 404。

---

## 四、三个「声明与实测不符」的问题（本次审计的新发现）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | **openi / ms-dataset 声明 `full`，实测只有 12/19 与 11/19** | 7 类 404 | 客户端选源时会选中这不完整的源；`enabled` 未据此关闭 |
| 2 | **pages 比 r2 少 8 类**（同为 `partial` 但覆盖面不同） | 8 类 404 | 降级到 pages 会缺素材 |
| 3 | **`src/rank.mjs:28` 把 r2 写成 `coverage:'full'`，而 `mirrors.json` 里 r2 是 `partial`** | 代码 vs 已发布清单 | 两份口径打架，选源逻辑可能用到错的那份 |

第 3 条尤其危险：`rank.mjs` 是**发布到线上 `rank.json` 的生成器**，
它声明的 coverage 与 `mirrors.json` 不一致时，取决于客户端读哪份，行为会不同。

---

## 五、speedcdn 到底算不算「上线」

**结论：dns/http 层面已完全可用，但没有被登记为发布源。**

- **可用**：`speedcdn.jiangjiangze.icu` 与 `weishucdn2` 解析到同一个 IP
  （`2606:4700:3035::6815:5782`）。
- **同桶同字节**：7 个文件逐个比对 sha256 全部一致（含 `index.json` 1,770,937 字节）：

  | 路径 | 字节 | sha256 前 16 位 |
  |---|---:|---|
  | `/cdn/v1/api.json` | 5,732 | `14691796aa94ab44` |
  | `/cdn/v1/mirrors.json` | 19,609 | `70d48c7591acc2ff` |
  | `/cdn/v1/rank.json` | 2,672 | `9da3c1228aee57c9` |
  | `/cdn/v1/index.json` | 1,770,937 | `12de1b7346ecdef7` |
  | `/cdn/v1/tree.json` | 887,741 | `5e0a03a55afb5af6` |
  | `/assets/char/avatar/char_002_amiya.png` | 56,957 | `373399462e2210a6` |
  | `/assets/audio/bgm/m_bat_abyssalhunters_intro.mp3` | 854,143 | `c30569ed3f403c0e` |

- **但未注册**：`origins.json` 里 0 命中；`mirrors.json` 的 `flat[]` 里 0 命中；
  `api.json` 里 0 次提及。仓库里只在两处**文档/注释**出现过
  （`site/docs/mirror-selection.md:149-151`、`src/rank.mjs:10` 的注释）。

> **所以准确的说法是**：speedcdn 是一个**已生效但未被登记**的第三个 R2 自定义域。
> 取字节完全正常，但它不在任何机器可读的源清单里 —— 客户端不会自动挑它，
> `rank.json` 也不会为它排名。**它不是 docker 中转 CDN**，就是同一个桶的另一个门牌。

---

## 六、魔搭社区（ModelScope）两份东西的状态

会话 `doker服务器审计` 里的魔搭文件是**两个不同的东西**，上线状态完全相反：

### 6.1 数据集 `Stronghold-Protocol-Assets` —— ✅ 已上线公开可用

- 页面 `modelscope.cn/datasets/jingjiangze/Stronghold-Protocol-Assets` → **200**
- API `Visibility: 5`（公开）、`Downloads: 1,316`
- **无鉴权直取字节**：200，`char_1016_agoat2.png` = 65,270 字节
- **字节真实性核过**：sha256 = `77f17e188890a775b16769f63f1423f6b2b0c2df745c5bd04e9eec552ef922d3`
  = r2 `index.json` 里记录的值 ✅
- 顶层结构：`releases/v1-trial/assets/`、`state/`、`.gitattributes`、`dataset_infos.json`、`README.md`
- **不足**：只覆盖 11/19 类（见第三节），且这批缺失与 index.json 的 hosted 缺口部分重合。

### 6.2 创空间 `jingjiangze/Stronghold-Protocol`（ms-edge）—— ✅ 已上线，但视角依赖 UA

这轮的教训：**我用 curl 默认 UA 测得到处 403，一度误判它挂了**。

- 平台 `Status: Running`，`LastDeployConfig` 镜像时间戳 **2026-10-12 01:15:33**，
  `DeployedTime` → 北京时间 **2026-10-12 01:16:31**（约 3.5 小时前刚部署）
- **带浏览器 UA**：首页 200（6,445 字节 HTML）、`/healthz` 200、`/packs/index.json` 200、
  `/shared/packs.js` 200
- **素材分流确实在工作**：`/assets/char/avatar/char_003_kalts.png` → **302**，三种参数都通：

  | 请求 | 302 目标 |
  |---|---|
  | 默认 | `modelscope.cn/datasets/…/v1-trial/assets/…`（数据集） |
  | `?sp_source=r2` | `weishucdn.jiangjiangze.icu/assets/…` |
  | `?sp_source=openi` | `openi.pcl.ac.cn/…/assets-raw/assets/…` |

- **不带 UA / 用 SDK token 风格请求** → 403，返回
  `10010101007 "当前接口不支持通过SDK Token直接访问"` + 一个 `api-inference.modelscope.net` 地址
  （那个地址同样 401）。**这是平台的 UA/Token 门禁，不是服务故障。**

> 判断 ms-edge 是否在线，**必须用浏览器 UA 探测**，否则会把平台拦截读成 403 宕机。

### 6.3 顺带：那批魔搭文件里有一份未提交的 README 改动

`C:\DDDD\Agent Work\Stronghold-Protocol-Server-Deploy` 的 `README.md` 有 **24 行未提交**
（working tree 脏文件或数 = 1），内容是 `SP_ANNOUNCEMENTS_URL` 变量说明。

**该功能已实装**（`server/http/announcements.js`，环境变量名 `SP_ANNOUNCEMENTS_URL`，
另有 `test/announcements-proxy.test.js` 覆盖），但 **Dockerfile 里尚未设置这个变量** ——
也就是说「发公告不用重新部署」这条路**代码就绪、尚未接线**。

⚠️ 且 README 里推荐的源 `arknights.jiangjiangze.icu/api/announcements/game` 目前**返回 404**
（`/admin` 也 404）。照文档配会拿到一个不存在的 URL（带兜底，不会崩，但公告拉不到）。

---

## 七、审计方案（可重复执行）

### 7.1 原则

1. **一律绕过本地代理**（`unset HTTPS_PROXY…` 或 `--noproxy '*'`）——本机 Clash 会把可用域名读成 000。
2. **一律带浏览器 UA** —— 否则 ms-edge 这类源会被平台门禁读成 403。
3. **区分「潜在可用性」与「实际可用性」**：302/301 要 `redirect: follow` 后再判；
   gitcdn-own 那种 90 秒没结果的，记为「慢」而不是「通」。
4. **不假设、逐源实测** —— 这次的教训就是 three sources 声明 `full` 而实际不全。

### 7.2 复跑脚本（已落盘 `_tmp/`）

```bash
cd stronghold-cdn/_main-fix/_tmp
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy all_proxy ALL_PROXY

node coverage-matrix.mjs      # 从 tree.json 归纳分类 + 挑代表文件 → probes.json
node probe-one.mjs <源名>     # 单源 19 类实测 → coverage-<源名>.json
node follow.mjs    <源名>     # 302 跟进判定 → coverage-final-<源名>.json
node diff-tree-index.mjs      # tree vs index 口径对齐
node speedcdn-verify.mjs      # speedcdn 与 weishucdn 字节一致性
node ms-ds-verify.mjs         # 数据集字节 vs index.json sha256
```

源名取值：`r2` `r2-alt` `pages` `gitcdn-own` `jsdelivr-assets` `ghfast-assets`
`ms-dataset` `ms-edge` `openi` `jsdelivr` `ghfast-raw`

### 7.3 验收判据

| 检查项 | 判据 | 本次结果 |
|---|---|---|
| 清单口径一致性 | `index.json ⊆ tree.json`，差额 == `tree.totals.hosted` | ✅ PASS（0 例外） |
| 权威字节真实性 | r2 实际下载字节的 sha256 == `index.json` 记录 | ✅ PASS（多份抽样） |
| 声明 vs 实测 | 每个源的 `coverage` 声明 == 19 类实测 | ❌ FAIL：openi / ms-dataset / pages 不符 |
| 代码 vs 发布清单 | `rank.mjs` 的 coverage == `mirrors.json` 的 | ❌ FAIL：r2 一处打架 |
| 域名可用性 | 接口+素材均 200 | ✅ PASS（r2 / r2-alt / speedcdn） |
| 已注册性 | 已用域名是否在 `origins.json` 登记 | ❌ FAIL：speedcdn 未登记 |

### 7.4 建议的修复顺序（按风险从高到低）

1. **对齐 `rank.mjs:28` 与 `mirrors.json` 的 r2 coverage**（两者打架，影响选源逻辑）。
2. **更正 openi / ms-dataset 的 `coverage` 声明**（实测不全却声明 full，会把客户端导向缺素材的源）。
3. **pages 缺 8 类**：要么补齐，要么在文档明确「降级到 pages 会缺哪些类」。
4. **把 speedcdn 登记进 `origins.json`**（或明确决定不登记，并在文档写明它是别名）。
5. **修正文档里「docs/fonts 只在 R2/Pages」** —— git-mount 源实给 `fonts/`。
6. **ModelScope 部署仓**：提交那 24 行 README，并修正 404 的公告源地址。

> 以上 1–5 都涉及发布面改动；按既有纪律，改完要走 **sync interface-only 重发**，不在本机直写 R2。
