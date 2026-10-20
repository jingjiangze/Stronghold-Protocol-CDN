# 逐源素材清单（每个源实际有什么）

> 日期：2026-10-12（晚间修订版）· 全部数字为本机实测，不是估算。
> 权威清单（真源）：`https://speedcdn.jiangjiangze.icu/cdn/v1/{index,tree,mirrors}.json`（2026-10-14 口径：规范门牌 speedcdn）
> **测量口径**：一律 `curl --noproxy '*'` / `--noproxy` + 浏览器 UA。
> **不绕过本地代理会得到假 000**（本机 Clash）；**不带 UA 会被 ms-edge 平台门禁挡成 403**。
>
> ⚠️ **本文件当日中午那版的覆盖率结论是错的，已作废**：首轮把 `tree.json` 的代表文件直接当探针，
> 混进了 `mod=1` 的 hosted 自有内容（7,547 个），而 hosted **不在任何 git 分支上**，
> 拿它要求 git 挂载源「提供」是错误口径。**本版只从 `index.json`（= 上游同步内容）取样**，
> 这才是 `coverage` 声明所描述的集合。修订后的结论见第三节。

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
>
> **这也正是首轮覆盖率实测翻车的原因**：`coverage` 声明描述的是**上游集合**（12,583），
> 而我从 `tree.json` 取样（20,130）—— 等于要求 git 挂载源提供只在 R2 托管的内容。

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

### 上游口径（`index.json`）下的分类：15 类

| 分类 | 文件数 | | 分类 | 文件数 |
|---|---:|---|---|---:|
| audio | 6,352 | | token | 50 |
| spine | 2,021 | | band | 40 |
| local | 1,614 | | bond | 23 |
| char | 808 | | fonts | 7 |
| ui | 602 | | docs | 6 |
| skill | 525 | | **合计** | **12,583** |
| enemy | 252 | | | |
| module | 130 | | | |
| prof | 94 | | | |
| item | 59 | | | |

> **注意 `local` 有 1,614 个上游文件**（`assets/local/`）—— 这是首轮把它误判成「git 源全缺」的类别。

---

## 三、逐源清单：每个源实际能提供什么（上游口径，本版为准）

实测方法：从 `index.json` 的 **12,583 个上游键**按分类各取 **2 个代表文件 = 30 个探针**
（每类首 / 中，避免单文件偶发），逐源取字节（`redirect: follow`），判据是 **HTTP 200 且字节数与 `index.json` 记录的 `size` 完全相符**。

**「30/30」= 覆盖全部 15 个上游分类。**

| 源 id | 类型 | 上游覆盖 | 中位时延 | p90 时延 | `mirrors.json` 声明 | 是否一致 |
|---|---|---:|---:|---:|---|---|
| **r2** | r2 | **30/30** | 430 ms | 3.4 s | （r2 无 coverage 字段） | ✅ 权威 |
| **r2-alt** | r2 | **30/30** | 619 ms | 1.9 s | （同上） | ✅ 同桶 |
| **ms-dataset** | cdn | **28/30**（缺 2 docs；local/ 2026-10-13 已补传） | **107 ms** | 297 ms | full | ✅ 见 3.2（已恢复） |
| **openi** | git | **28/30**（缺 2 docs） | **255 ms** | 341 ms | full | ⚠️ 见 3.1 |
| **ghfast-assets** | git | **28/30**（缺 2 docs） | 595 ms | 1.7 s | full | ⚠️ 见 3.1 |
| **jsdelivr-assets** | git | **28/30**（缺 2 docs） | 2,047 ms | 11.3 s | full | ⚠️ 见 3.1 |
| **ms-edge** | cdn | **28/30**（同 ms-dataset） | 315 ms | 2.2 s | full | ✅ 见 3.2 |
| **pages** | pages | **30/30**（字节全对） | **7.0 s** | **93.1 s** | （pages 无 coverage 字段） | ⚠️ 慢，不缺 |
| **gitcdn-own** | git | **17/30**（13 条超时） | **10.6 s** | **30.0 s** | full | ⚠️ 见 3.3 |
| **speedcdn** | r2 | 与 r2 字节全同 | — | — | — | 见第五节（2026-10-13 已登记，order 第一位） |

### 3.1 唯一真正的缺口：`docs/`

**四个源缺的都是同一批文件，且只有 `docs/` 这一类**：

```
openi / ghfast-assets / jsdelivr-assets：缺 docs/DEPLOY.md、docs/research/05-enemies.json
ms-dataset / ms-edge：额外还缺 assets/local/emoticon/basic/pic_cooperate_battle.png
                                      assets/local/ui/common/icon_bldsk.png
```

`docs/` 在 `index.json` 里只有 **6 个键**、共 **32.8 MiB**，且 `tree.json` 的 `docs` 目录
（3 目录 / 46 文件）标注为**只在 R2 / Pages**。所以这不是「源坏了」，
而是 **`docs/` 从来没进 `assets-raw` 孤儿分支** —— 分支同步只搬 `assets/` 与 `fonts/`。

> **所以准确的说法是**：`assets-raw` 挂载的三个源（openi / ghfast / jsdelivr）**覆盖了除 `docs/`
> 以外的全部上游内容**，`fonts/` 也在内（`fonts/bender-regular.woff2` 200，字节相符）——
> 这一条推翻了早期文档里「`docs` / `fonts` 只在 R2/Pages」的说法，`fonts` 那半句是错的。

### 3.2 ms-dataset / ms-edge：**已补齐整棵 `assets/local/`**（2026-10-13 根治）

> ⚠️ **本节原结论作废**。原版把探针里 `local` 抽的 2 个文件都 404 读成了「只差这 2 个具体文件」，
> 实际语义相反：**这两个源对 `assets/local/` 是整类缺失**。2026-10-13 已 git-lfs 推送 1,611 个文件，数据集恢复为可用主源。

**实测（2026-10-13，本机 `--noproxy` + 浏览器 UA）**：

- 定向探针 22 条 `assets/local/**` 路径（UI/battle/token/spine/module/guide），
  **ms-dataset 22/22 全部 404**；同批 `assets/char|skins|spine|audio|ui|…` 全部 200。
- 直接查数据集目录（`/repo/tree?Root=releases/v1-trial/assets`）：顶层 13 个目录
  **没有 `local`** —— `assets/local/` 从来没进过数据集（10-11 那次快照没带它）。
- `ms-edge` 继承同一缺口：容器默认 302 到 ms-dataset，所以 `/assets/local/**` 也是 404。

`assets/local/` 在上游口径下有 **1,614 个文件 / 282.7 MiB**（见第二节），是第三大类别。
**所以这不是「零星缺失」，是一整个类别的缺口。**

另有一个**真·单文件**例外：平台审核拒收 `assets/skins/char_340_shwaz_snow_1/illustration.png`
（提交被 reverted），ms-edge 的 `sources.json` 例外表把它改道 r2 —— 这一条才是「单文件」。

**处置（已执行 2026-10-13）**：

1. `origins.json` 把 ms-dataset **降级**（`enabled:false` + disabled 名单 + order 队尾），
   并把它的 probe 从 200 的 char 路径改成实测 404 的 `assets/local/…` 小图 ——
   这样**客户端 `pickFastest` 会把它判为坏源**，不再选中（见 3.2.1）。
2. 重发 `rank.json`（排除 ms-dataset）→ ms-edge 容器读 rank 动态重排为 `r2 > modelscope`，
   `/assets/local/**` 改道 r2，实测 200。**两个源都不再吐 404。**
3. **根治（已完成）**：把 `assets/local/` 补传进数据集 —— 1,611 文件 / 72 MB，
   经 `git-lfs` 推送（`aef2493c..cf52aabb`），逐字节核验通过；随后**摘除 park、移回 order 首位**。
   现在 `assets/local/**` 在 ms-dataset 上 200，ms-dataset 恢复为可用主源。

#### 3.2.1 为什么「降级」之前一直没生效

`cdn/v1/pick.js` 的 `pickFastest` **从不读 `enabled`** —— 被 park 的源照样参与测速、照样可能被选中。
所以只改 `enabled:false` 而不动探针，线上选源器无感。真正的修法是让 `pickFastest` 读 `enabled`
（2026-10-13 已修并重发，`requireEnabled` 默认 true）。同一缺陷此前也让站点首页选中
**openi**（ACAO 写死第三方域，浏览器跨域取 WebGL 贴图被拒 → 立绘加载不出来）。

### 3.3 gitcdn-own：不是「缺」，是「取不动」

13 个探针在 30 s 超时内没回来，但成功的 17 个**字节全部与 `index.json` 相符**。
中位 10.6 s、p90 30 s。它是**自有域中转**（`sp-git-mount-relay`），按 jsdelivr → ghfast 顺序回退，
所以它同时继承了这两条链路在本机网络下的抖动。**记「慢/不稳」，不记「缺」。**

### 3.4 pages：**慢，但不缺**（2026-10-12 明确改判）

首轮我用 25–30 s 超时，把 3 个超时读成了「缺 8 类」。**改判证据**：

| 路径 | 期望字节 | pages | r2 |
|---|---:|---|---|
| `assets/band/band_justin.png` | 64,563 | 200 · 64,563 B · 2.6 s / 16.5 s / 11.1 s（重试）· `HEAD` 200 `cf-cache-status: HIT` | 200 · 64,563 B · 1.1 s |
| `assets/module/lib-x.png` | 1,586 | 200 · 1,586 B · 1.7 s | 200 · 1,586 B · 208 ms |
| `assets/ui/bandChoose/btn_comfirm_check.png` | 556 | 200 · 556 B · 0.7 s | 200 · 556 B · 412 ms |
| `assets/audio/bgm/m_bat_abyssalhunters_intro.mp3` | 854,143 | 200 · 612 s（一次成功，其余超时） | 200 · 154 s |

**结论**：pages **覆盖全部 30 个上游探针、字节逐一相符**，只是**极慢且极不稳**
（中位 7 s、p90 93 s、9/30 超过 10 s；854 KB 的 mp3 取到 612 s）。
按用户口径记为 **「慢」而非「缺」**。它仍是文档中 major-gripes 的部署面，也是 `docs/` 的可用出口。

---

## 四、与声明不符的问题（本次审计的新发现，已按修订口径校正）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | **`gitcdn-own` 声明 `full`，实测 17/30 全因超时** | 中位 10.6 s / p90 30 s；成功的 17 条字节全对 | 慢到不可用作运行时主源；`enabled` 未据此关闭 |
| 2 | **`ms-dataset` / `ms-edge` 声明 `full`，实测曾 26/30** | 缺 2 个 `docs` + **整类 `assets/local/`**（1,611 文件，从未进数据集） | 客户端选源曾导向整类 404 的源；2026-10-13 已补传 local 并恢复 |
| 3 | **四个 git/cdn 源都缺 `docs/`**（声明 full 者亦含） | `docs/` 从未进 `assets-raw` 分支 | `docs/` 只能走 r2 / r2-alt / pages |
| 4 | **`src/rank.mjs:28` 把 r2 写成 `coverage:'full'`，而 `mirrors.json` 里 r2 没有 coverage 字段** | 代码 vs 已发布清单 | 两份口径打架；线上 `rank.json` 里 r2 确实是 `full`，r2-alt 是空 |
| 5 | ~~speedcdn 已可用但未登记~~（2026-10-13 已登记进 `origins.json` `extraOrigins`，并提为 `order` 第一位） | 见第五节 | 客户端自动挑它；与 r2 同桶同字节 |

第 4 条：`rank.mjs` 是**发布到线上 `rank.json` 的生成器**，它硬编码 r2 为 `full`，
而 `mirrors.json` 的 r2 条目没有 `coverage`（r2-alt 同样没有）。实测证明 r2/r2-alt **确实是 full**，
所以这里不是「声明错了」，而是**两份文件对同一事实的记录方式不一致** —— 应统一写法。

---

## 五、speedcdn：已登记为发布源（2026-10-13 收口）

**结论：dns/http 层面完全可用，2026-10-13 已登记进 `origins.json`，并提为 `order` 第一位。**

- **可用**：`speedcdn.jiangjiangze.icu` 与 `weishucdn` 解析到同一个 IP
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

- **2026-10-13 已登记**：`origins.json` 的 `extraOrigins` 新增 `speedcdn`（kind:r2、root 指向 speedcdn.jiangjiangze.icu），
  `order` 末位追加 `speedcdn`。重发 `mirrors.json` 后，它会进入 `flat[]`，客户端与站点测速都能看到它；
  `rank.json` 也会为它排名（与 r2 同桶，实测并列）。**它不是 docker 中转 CDN**，就是同一个桶的第三个门牌。
- **2026-10-19 变动**：`speedcdn` 提为 `order` 第一位（最优先）。`r2-alt`（weishucdn2）于 2026-10-20 删域，
  现只返回 Cloudflare 的 639 B 占位外壳，已从 `order` 摘除并登记 `retired`，不再作为可用门牌。

> **此前状态（已更正）**：域名早已生效但从未进源清单，客户端不会自动挑它、`rank.json` 也不会为它排名。
> 2026-10-13 补登后，两个可用 R2 入口（weishucdn / speedcdn）在清单里并列，客户端按实测任选其一（**2026-10-14 口径：speedcdn 为规范门牌**）。weishucdn2（r2-alt）曾并列，2026-10-20 删域后已下线与 retired。

---

## 六、魔搭社区（ModelScope）两份东西的状态

会话 `doker服务器审计` 里的魔搭文件是**两个不同的东西**，上线状态完全相反：

### 6.1 数据集 `Stronghold-Protocol-Assets` —— 🔒 2026-10-18 起转私有；所有者会话仍可用，公开字节走 speedcdn

> **2026-10-18 变更**：数据集已转为私有（`Visibility: 1`），描述同步更新。

> **可用性（2026-10-19 复核）**：
> | 通道 | 结果 |
> |---|---|
> | 匿名 `resolve` / `api/repo` | **404** `不存在的数据集` |
> | 匿名 `repo/tree` | **403** `无权访问该数据集` |
> | 所有者会话（token 换 cookie 后）`resolve` / `api/repo` | **200**，`char_003_kalts.png` = 56,617 字节真 PNG |
> | 所有者会话 `repo/tree` | **200** |
> | 公开分发（speedcdn / weishucdn） | **200**，同路径同 56,617 字节 |
>
> 结论：数据集对所有者与同步链仍然可用，只是不再作为匿名可取的公开镜像——所以它已从 `origins.json` 的 `order` 里移出，并以 `enabled:false` **保留在候选列表中**（不是 retired）：CDN 的服务端链路仍在调用它，玩家侧统一走 speedcdn（同一份对象、同字节）。下面这一节保留作历史记录，**其中「无鉴权直取字节」现在只对所有者会话成立**。
>
> - 页面 `modelscope.cn/datasets/jingjiangze/Stronghold-Protocol-Assets` → **200**（转私有前）
> - API `Visibility: 5`（公开）、`Downloads: 1,316`（转私有前；现为 `Visibility: 1`）
> - **无鉴权直取字节**：200，`char_1016_agoat2.png` = 65,270 字节（转私有前）
> - **字节真实性核过**：sha256 = `77f17e188890a775b16769f63f1423f6b2b0c2df745c5bd04e9eec552ef922d3`
>   = r2 `index.json` 里记录的值 ✅
> - 顶层结构：`releases/v1-trial/assets/`、`state/`、`.gitattributes`、`dataset_infos.json`、`README.md`
- **实测缺口（2026-10-13 更正并已修复）**：曾缺 2 个 `docs/` + **整棵 `assets/local/`（1,611 个文件，从未进数据集）**（见 3.2）。
  **是整类缺口，不是零星缺失**；当日已用 git-lfs 补传（`aef2493c..cf52aabb`）并恢复选源。现仅缺 2 个 `docs/`（`docs/` 从未进 `assets-raw`）。

### 6.2 创空间 `jingjiangze/Stronghold-Protocol`（ms-edge）—— ✅ 已上线，但视角依赖 UA

这轮的教训：**我用 curl 默认 UA 测得到处 403，一度误判它挂了**。

- 平台 `Status: Running`，`LastDeployConfig` 镜像时间戳 **2026-10-12 01:15:33**，
  `DeployedTime` → 北京时间 **2026-10-12 01:16:31**
- **带浏览器 UA**：首页 200（6,445 字节 HTML）、`/healthz` 200、`/packs/index.json` 200、
  `/shared/packs.js` 200
- **素材分流确实在工作**：`/assets/char/avatar/char_003_kalts.png` → **302**，三种参数都通：

  | 请求 | 302 目标 |
  |---|---|
  | 默认 | `modelscope.cn/datasets/…/v1-trial/assets/…`（数据集） |
  | `?sp_source=r2` | `speedcdn.jiangjiangze.icu/assets/…` |
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
3. **从 `index.json` 取样，不从 `tree.json` 取样** —— 这是本轮翻车的根因。
   `coverage` 声明描述的是上游集合（12,583）；`tree.json` 多出的 7,547 个是 hosted，
   **不在任何 git 分支上**，拿它要求 git 挂载源是错误口径。
4. **超时不等于缺失**：至少重试一次，并用 `HEAD` / `Range` 交叉验证再下「缺」的结论。
   pages 的 3 个「超时」全是 200 + 字节相符，只是慢到 612 s。
5. **区分「潜在可用性」与「实际可用性」**：302/301 要 `redirect: follow` 后再判；
   gitcdn-own 那种 30 s 没结果的，记为「慢」而不是「通」。

### 7.2 复跑脚本（已落盘 `_tmp/`）

```bash
cd stronghold-cdn/_main-fix/_tmp/per-source-inventory-2026-10-12
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy all_proxy ALL_PROXY

node probe-upstream.mjs       # 从 index.json 按分类挑代表文件（15 类 × 2 = 30 探针）→ probes-upstream.json
node probe-up1.mjs <源名>     # 单源 30 探针实测 → up-<源名>.json
node msds-local.mjs           # ms-dataset 的 local 缺口是整类还是个别
node pages-verify2.mjs        # pages 的「超时」路径：重试 + HEAD + Range 交叉验证
node diff-tree-index.mjs      # tree vs index 口径对齐（7,547 hosted 差额）
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
| 取样口径 | 探针只来自 `index.json` | ✅ PASS（本版已修正） |
| 声明 vs 实测 | 每个源的 `coverage` 声明 == 30 探针实测 | ⚠️ 4 处不符：gitcdn-own（超时） / ms-dataset / ms-edge / 四个源共缺 `docs/` |
| 代码 vs 发布清单 | `rank.mjs` 的 coverage == `mirrors.json` 的 | ⚠️ r2 一处写法不一致（实测都是 full） |
| 域名可用性 | 接口+素材均 200 | ✅ PASS（r2 / r2-alt / speedcdn / pages） |
| 已注册性 | 已用域名是否在 `origins.json` 登记 | ✅ PASS：speedcdn 已登记（2026-10-13，order 第一位），r2-alt（weishucdn2）已 retired |

### 7.4 建议的修复顺序（按风险从高到低）

1. **统一 `rank.mjs:28` 与 `mirrors.json` 的 r2 coverage 写法**（一个硬编码 full、一个没字段）。
2. **把 `docs/` 补进 `assets-raw` 分支**，或在四个 git/cdn 源的 note 里写明「不含 `docs/`」
   —— 现在声明 `full` 而实际缺一类。
3. **gitcdn-own**：中位 10.6 s / p90 30 s，不适合做运行时主源；
   要么修回源链路，要么在文档写明「仅作兜底」。
4. **ms-dataset / ms-edge**：补那 2 个 `local` 文件，或在 note 里点名列名。
5. ~~把 speedcdn 登记进 `origins.json`~~（2026-10-13 已完成：登记为 `extraOrigins` 并提为 `order` 第一位）。
6. **修正文档里「`docs` / `fonts` 只在 R2/Pages」** —— `fonts` 那半句已被实测推翻（git 源也给）。
7. **ModelScope 部署仓**：提交那 24 行 README，并修正 404 的公告源地址。

> 以上 1–5 都涉及发布面改动；按既有纪律，改完要走 **sync interface-only 重发**，不在本机直写 R2。
