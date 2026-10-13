# 审计：上游素材 vs CDN 源是否一致（2026-10-13）

对象：线上 CDN（`weishucdn` / `weishucdn2` / `spages` / ModelScope 数据集）与本地各棵素材树。
触发：第三方服（leio 服）反馈「你们 CDN 里是旧的模型，分辨率较低，我们拉的是新模型，不能套用」。
结论：**CDN 与上游整体一致（CDN 是超集、共有路径逐字节相同），但确实存在一处被规则压住的"新版素材"——机制已定位到行。**

---

## 1. CDN 现状（BASELINE，实测）

| 项 | 值 | 出处 |
|---|---|---|
| 主素材上游 | `sganggs/Stronghold-Protocol` | `src/upstream.mjs:12`（硬编码默认，无 env 覆盖） |
| ref 解析 | 上游 **latest release**（动态） | `src/upstream.mjs:27-31` |
| 线上水位 | token **`v0.2.5-72d6ad63`**，tag **v0.2.5**，publishedAt **2026-10-12T10:57:30Z** | `GET /cdn/v1/mirrors.json`、`/cdn/v1/art.json` |
| 包校验 | `zipSha256 e44bff11…` | 同上 |
| 桶清单 | `tree.json` = **21,333 文件 / 3.19 GB / 3,341 目录**，其中 `mod=1`（本站有意托管）**8,658** | `GET /cdn/v1/tree.json` |
| 附加源 | `fusion` = `Paper-Yuan/Stronghold-Protocol` @ `feature/v0.2.1-fusion-master`（release `v0.2.1-fusion`） | `sources.json` |
| 发布链校验 | 包级 digest + 逐文件 size/sha256 + 验收门禁（失败则不发布、保留上一版） | `src/sync.mjs:207/219/624`、`src/verify-*.mjs` |

**⚠️ 仓库内的记录滞后于线上**：`_t.json` 仍写 `v0.2.3`；`site/index.html` 等 9 处文案仍写 sganggs（这条是对的，上游确实是 sganggs）；下载页两个包仍标 `v0.2.2`。引用版本请以线上 `art.json`/`mirrors.json` 的 `token` 为准。

## 2. 一致性：CDN 是上游的严格超集

**（a）与本地上游解压树**（`dl-cache/upstream-extracted/Stronghold-Protocol/public`，0.2.3，12,574 个 assets+fonts 文件）：

```
上游有 / CDN 缺     : 0        ← 一条不缺
两边都有但体积不同   : 0        ← 共有路径体积全部相同
CDN 有 / 上游没有   : 8,759    ← fusion 皮肤/语音/骨架（mod=1）
```

**（b）与客户端清单**（`data/assets.json`，13,429 条素材路径）：抽样 35 条（含 25 条不在 `tree.json` 里的）**全部 HTTP 200**。

**（c）活源之间**：`weishucdn` / `weishucdn2` / ModelScope 数据集，9 个抽样文件（3 角色 × skel/atlas/png）**size 与 sha256 完全相同**，且与本地 0.2.3 树相同 → **无镜像分歧**。

**（d）结构自洽**：4 组 spine/skin 抽查，`.atlas` 里声明的贴图页与 `.skel` 在 CDN 上**全部 200**。

**（e）无多分辨率机制**：全树没有 `@2x`/`_hd` 之类变体（那 42 个命中只是文件名里含 "hd"，如 `char_373_lionhd.png`）。每个素材只有一种分辨率。

## 3. ★ 根因：`sources.json` 的"只加不覆盖"把新版素材压住了

`sources.json` 的设计声明：

> "only paths the main (upstream) tree does not have are written, **so an extra source can never overwrite the authoritative bytes**"

`src/sources.mjs:8-10` 同一语义：

> "Uploads are ADDITIVE. A path the main tree already has is never written from a source — **the upstream bytes stay authoritative** — and any same-path difference is reported instead"

**后果（实测）**：上游树 vs fork 树 7,968 条共有路径中，**恰好 2 条体积不同**，都在同一个敌人模型：

| `assets/spine/enemy/enemy_10138_xdsnow/` | 上游 0.2.3 | fork 0.13.0 | **CDN 实际发的** |
|---|---|---|---|
| `.skel` | 55,783 | 55,783 | 55,783（相同） |
| `.atlas` | 1,825 | **1,853** | **1,825** ← 上游版 |
| `.png` | 26,989 | **72,530** | **26,989** ← 上游版（低清） |

`tree.json` 里这条也记的是上游那份（`{"bytes":84597,"files":[[…atlas,1825],[…png,26989],[…skel,55783]]}`），与实测 200 返回的体积一致。

→ 玩家的四句话全部对上：**"CDN 里是旧的"**（上游那份）、**"分辨率较低"**（26,989 vs 72,530，2.7×）、**"不匹配"**（atlas 1,825 vs 1,853，是另一代）、**"不能套用"**（把 CDN 这份拿去配新版客户端，atlas/png 不是同一代）。

**注意口径**：上面这条是用本地 `Stronghold-Protocol-Forge`（0.13.0）作 **fusion 源的代理**测的（本地没有 Paper-Yuan 那棵树，`work/v0.2.2/` 只有上游包）。**权威的完整差异清单必须来自真正的 fusion 包**——而发布链本身就会算并报告这份差异（`src/sources.mjs:9` "any same-path difference is reported instead"）。玩家说"有很多"，说明真源里的差异条数可能远多于代理测出的 2 条。

## 4. 顺带查出的第二个缺陷：`tree.json` 滞后且无版本标识

- 客户端清单里有 **620 条 `assets/skins/**` 路径不在 `tree.json` 里，但 CDN 实际都发得出来**（抽样 25/25 → 200）。`tree.json` 只列了 **1,856** 个皮肤文件，而另一处记录显示 **2,476 live on weishucdn** —— 差的 ≈620 与本次实测吻合。
- `tree.json` **不带任何版本/token 字段**（`mirrors.json`/`art.json` 都有 `token`）→ 消费方**无法分辨它是不是旧的**。
- 谁按 `tree.json` 判断"CDN 有没有这个素材"，就会得出"没有 → 不能套用"。
- `index.json`（哈希清单，1.77 MB）在本机这条链路拉不通（>1 MB 传输间歇 http=000），**哈希级全量核验未做，标 PENDING**。

## 5. 修法（建议，未执行）

**A. 给附加源加"强行覆盖"能力**（对应本次诉求）
1. `sources.json` 的 source 条目加一个显式覆盖字段（如 `"force": ["assets/spine/enemy/enemy_10138_xdsnow/**", …]`，默认空）。
2. `src/sources.mjs` 的 `readSources()` 目前**白名单式复制字段**（只收 id/repo/ref/release/package/manifest/note）→ 必须同时放行新字段，否则静默丢弃。
3. 上传阶段：被 `force` 命中的路径**允许用附加源字节覆盖主树字节**，并在报告里单列"被强行替换"清单（保留可审计性）。
4. 重发：`node src/sync.mjs --write`（若只改清单不动素材，用 `--interface-only`，见 `promote-uploads.yml:129`）。

**B. 让 `tree.json` 与桶对齐**
重跑发布链的 interface 生成，并把 `assets/skins/**` 实际在桶里的那部分纳入；同时**给 `tree.json` 加 `token`**，否则下次仍然分不清新旧。

**两个前置**：① 权威差异清单要跑一次真 fusion 源（需下载 `Stronghold-Protocol-v0.2.1-Server.zip`）；② 以上都是**写线上**，需明确授权。

## 6. 不是根因的三件事（已排除）

- **镜像分歧**：三个活源字节一致（§2c）。
- **CDN 比本地旧**：线上是 v0.2.5，本地树是 0.2.3/0.13.0，CDN 更新。
- **CDN 缺素材**：0 条缺失（§2a），清单承诺的路径全部 200（§2b）。

## 7. 给玩家的排查建议（他们那侧的可能性）

客户端取素材是**容器本地盘优先**（`stronghold-server/server/http/static.js`：本地命中就发本地，只有 ENOENT 才 302 到 CDN）。若他们服务器自带一份旧 `public/assets`，**永远看到的是本地那份，与 CDN 无关**。一步定案：让他们给一条客户端实际请求的素材 URL，或他们服务器 `data/assets.json` 的 `hash`。

---

## 8. 实作记录（2026-10-13，仅改 CDN 仓）

### 8.1 待覆盖的权威清单 = 2 个文件

用 CDN 自己的桶清单（`cdn/v1/tree.json` 带体积）与**我们四棵高清树**全量比对（同路径体积不同才算）：

| 路径 | 我们（Forge / _stardust-deploy / sp-workers-pr 三棵一致） | CDN 实发 |
|---|---|---|
| `assets/spine/enemy/enemy_10138_xdsnow/enemy_10138_xdsnow.atlas` | 1,853 | 1,825 |
| `assets/spine/enemy/enemy_10138_xdsnow/enemy_10138_xdsnow.png` | **72,530** | 26,989（2.69×） |

`stronghold-cdn/_skins-wt`（CDN 自己的 worktree）与 CDN **0 条差异**——它也是低清那一侧。除这 2 条外，全部共享路径体积一致。

### 8.2 落地内容

| 文件 | 改动 |
|---|---|
| `sources.json` | source 条目新增 `force: []`；新增 `_force` 说明（语义 + 为什么不能直接覆盖） |
| `src/sources.mjs` | `readSources()` 放行 `force`（**原先是白名单式复制，不加放行就静默丢弃**）；新增 `forceMatches()`（`*` 段内、`**` 跨段、其余字面）与 `planSourceWrite({add,change,force})` → `{write,forced,kept}`；头部注释更新 |
| `src/sync.mjs` | 用 `planSourceWrite` 出日志与报告；报告新增 `divergentKeys`（差异清单，cap 200）与 `forcedKeys`；**声明了 `force` 就在写任何字节之前硬停**（见 8.3） |
| `src/tree-index.mjs` | `buildTree(files,{hosted,token})` / `readTree(root,files,{token})`，published `tree.json` 现在带 `token`；`sync.mjs` 两处调用点传 token（主路径 `version`、快路径 `published.art.token`） |
| `tests/sources.test.mjs` | +3 测：`force` 透传与默认空、`forceMatches` 语义（含 `*` 不跨 `/`、点号是字面）、`planSourceWrite` 三分支 |
| `tests/tree-index.test.mjs` | +1 测：带 token 则写入、不带则不出现空 token |

验证：`node --test tests/sources.test.mjs tests/tree-index.test.mjs` = **15/15 PASS**；全量 `node --test tests/*.test.mjs` = 191 测试 / 184 通过，**7 个失败全部来自并发会话正在改的文件**（`docs-index.mjs` 缺 `buildDocsIndex` 导出、admin 页 6 测），与本次改动无关。

### 8.3 最终实现：显式 pin（用户 2026-10-13 选定方案 A「改流水线」）

**为什么不能简单覆盖**：published `index.json` 必须等于上游树（`src/tree-index.mjs` 的设计注释），且验收门禁按**上游尺寸**核对每个 URL（`sync.mjs` 把 `expected[url]` 建成上游清单里的 size）。所以"直接覆盖同名路径"会 ① 让 index.json 描述上游没有的东西；② 让门禁失败、整个 interface 不发布。

**方案 A 的做法 = 把"我们有意发这批字节"变成一等公民**，让 index 与门禁一起跟着变：

- **声明形式**：`sources.json` 的 `sources[].force` = **pin 列表**，每项 `{ path, size, sha256, why }`。pin 必须自带字节身份（size+sha256），因为 **published index 与 cache token 都在取任何源包之前就生成**——值不可能在运行时才发现。
- **应用时机**（这是关键，`sync.mjs`）：插在**主树 diff 之后、`indexDocument`/`version` 之前**。于是 cache token、`urls/expected`（门禁期望）、`tree.json`、字节抽样**全部自动描述我们要发的字节**；而 pin 的路径不在主树 diff 里，所以**绝不会被上游自己的字节覆盖**（否则 pin 会被撤销）。
- **字节来源**：由声明它的那个源包提供。sync 校验 `pinSatisfied()`（源包里必须有**完全一致**的 size+sha256）后才上传；不满足就报错停下（fail-closed，且指名路径与两边的尺寸/指纹）。
- **审计**：`art.json.art.overrides` 列出每条覆盖（双方 size/sha256 + 提供它的源 + `why`），sync 报告里也有 `overrides`；`sources[].pinned`/`pinnedKeys` 记在源报告里。
- **不变量**：pin 一个**上游没有的路径**直接报错（那是"新增"，归 additive 通路）；`force` 非空但 `--sources` 关闭也报错（字节必须来自源包）。
- **契约**：`src/api-contract.mjs` 的 art.json 描述已补 `art.overrides`。

改动文件：`src/sources.mjs`（`parsePin`/`pinSatisfied`/`applyOverrides`，替换掉临时的 glob 版 `forceMatches`/`planSourceWrite`）、`src/sync.mjs`（pin 应用 + 源侧校验上传 + 报告 + publishArt）、`sources.json`（`_force` 说明 + `_force_pending` 待填清单）、`src/api-contract.mjs`、`tests/sources.test.mjs`（pin 解析/校验/`applyOverrides` 三分支，替换旧 glob 测试）。

验证：`node --test tests/sources.test.mjs tests/tree-index.test.mjs tests/api-contract.test.mjs` = **19/19 PASS**；`node --check` 全绿；全量 `node --test tests/*.test.mjs` = 192 测试 / 185 通过，**7 个失败与改动前逐条相同**（并发会话的 admin 页 + site-data 半重构）。

### 8.4 仍未落地：pin 还空着（有意为之）

`sources[].force` **故意留空**。两个 pin 的值已算好并写进 `sources.json` 的 `_force_pending`：

| path | 上游 | 我们要发 | sha256 |
|---|---|---|---|
| `assets/spine/enemy/enemy_10138_xdsnow/enemy_10138_xdsnow.png` | 26,989 B | **72,530 B** | `195f2142…d7d4` |
| `assets/spine/enemy/enemy_10138_xdsnow/enemy_10138_xdsnow.atlas` | 1,825 B | **1,853 B** | `a38f2b30…841e` |

**为什么不填**：pin 要求**声明它的源包真的含这些字节**，而现有的 `fusion` 源（`Paper-Yuan/Stronghold-Protocol` v0.2.1-fusion）note 写的是 `spine/op`，我们要的是 **`spine/enemy`** —— **无法本地验证它是否含这个 enemy 骨架**。填上去而源包不含，会让**此后每一次 sync 都失败**（fail-closed 是我故意设计的，但对定时任务就是停机）。高清字节目前只存在于我们自己的四棵树（`Stronghold-Protocol-Forge` / `_stardust-deploy/src` / `sp-workers-pr` / `stronghold-worker`），它们**都不是已声明的源**。

⇒ **落地只差一步**：确定一个能提供这 2 个字节的源（给我们那几棵树里任一个的 release，或给它加一条 `sources` 条目），把 `_force_pending` 里的两项复制进 `force`，然后 `node src/sync.mjs --write --sources`（本机无 R2 凭据，实际在 CI 跑）。

### 8.5 仍未做

- **推字节**：本机无 R2/CF 凭据；发布只能在 CI（`sync.yml` / `promote-uploads.yml`）。
- **`tree.json` 纳入桶里那 620 条皮肤**：依赖 `hosted.json`/上传表 + 一次桶列举（本机无凭据）；本次只解决了"tree.json 无法自证新旧"（补了 `token`）。`hosted.json` 当时**正被并发会话修改**，故未动。
