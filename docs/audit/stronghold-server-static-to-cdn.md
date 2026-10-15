# 把 stronghold-server 的客户端静态托管到 CDN（R2 weishucdn + Pages spages）

审计日期 2026-10-11 · 对象仓库 `jingjiangze/stronghold-server`（审计基线 HEAD `d70d3e8`）· 目标源 **只有两个：R2 `weishucdn` 与 Pages `spages`**
状态：**S0 + S1 已实作并验证（见 §7）**；S2–S5 未做。本仓（stronghold-cdn）只写审计文档，未改 stronghold-server 之外的任何东西。

---

## 0. 结论先行

1. **"版本 tag 每个源都能同步"这件事，收敛到两个源之后就不再是协调问题，而是结构问题**：R2 与 Pages 由 CDN 仓的**同一次 `sync.mjs` 运行**写入（同 staging 树，一次 putObject + 一次 pages deploy），两个源之间**在构造上不可能漂移**。五个源会漂，是因为它们由不同的流水线在不同时刻喂；两个源不会。
2. **真正会漂的是"容器 vs CDN"这一对**：`index.html`、`/data.js`（运行时生成）、`/data/*.json` 必须留在容器上，所以客户端包的版本必须**由容器钉住**，而不是由 CDN 自己往前滚。
3. **可以托管的是约 11.4 MB/冷启动**：`js` 2631K + `sim` 4795K + `vendor` ≈2.9M + `css` 444K + `i18n` 436K + `shared` 301K + `icons` 40K。今天这些文件全部以 `no-cache` 由创空间容器发出（见 §2），每次刷新要对容器做约 480 次条件请求——这才是这条线"慢"的真实机制，比带宽更致命。
4. **现有引用图比预期干净，但被打断的面比初稿说的宽**：相对引用全部与真实目录深度一致（前缀安全）；根绝对的**模块 specifier 实测 17 处**（不是 3 处：`public/dev/game-mock.js` 一个文件就 16 处），另有 `board3d/load.js` 的 `THREE_URL` **字符串常量** 1 处（静态提取器看不见，必须单独处理）。加上 5 处"文档 origin 根绝对"（会被容器 302 兜住，不受影响）。清单在 §2.2/§2.3。**17+1 处已全部改为前缀安全（§7）。**
5. **`buildTag.js` 不能当跨源 tag**：指纹含 `mtimeMs`，跨机器不可复现，而且它从未进入任何 URL。跨源 tag 必须是**纯内容 sha256**，并且用**路径段**而不是 `?v=`（R2 的 `?v=` 不改对象键，`files.js` 里 `?v=` → 1 年 immutable 的头只有在"盒子上换文件"这一种情况下才成立）。

---

## 1. 事实基线（BASELINE，均已实测）

### 1.1 这个部署是什么

- 单容器 Node，镜像内**没有 nginx**：`Dockerfile` → `CMD ["node","server/index.js"]`，`PORT=7860`（创空间硬约束），`EXPOSE 7860`。
- 静态由 `server/http/files.js` + `server/http/static.js` 发出。
- 素材**已经不在容器上**：`d70d3e8` 把 `data/assets.json` 换成 weishucdn 的 v0.2.4 清单（11637 条绝对地址、0 条相对），art 已走 CDN。

### 1.2 今天的缓存策略（`server/http/files.js`）

| 类别 | 策略 | 后果 |
|---|---|---|
| `*.html` | `no-cache` | 每次导航都问容器 |
| 带 `?v=` | `IMMUTABLE_CACHE` | **没有任何东西生成 `?v=`**，等于失效 |
| `assets/ fonts/ vendor/`（`LONG_CACHE_DIRS`） | 1 天 | vendor 是唯一被缓存的应用代码 |
| 其余（`js` `css` `sim` `shared` `icons` `i18n`） | `no-cache` | **每个文件、每次刷新都回容器** |

### 1.3 `/fonts/fonts.css` 在这个部署里 404

- `public/index.html:27` → `<link rel="stylesheet" href="/fonts/fonts.css" />`
- `public/fonts` **不在仓库里**，`tools/vendor.mjs` 不生成它，只有 `FETCH_ASSETS=1` 时 `tools/fetch-assets.mjs` 才会落 `public/fonts/**`。
- 仓库自己的 `tools/doctor.mjs:249-250` 就承认这件事：`warn / 字体 public/fonts / 未生成（随素材下载一起生成；缺失时用系统字体）`。
- 而 **weishucdn 上已经有 `fonts/fonts.css`**（前一轮已实测 200），清单里 7 条字体的 URL 也是绝对的。
- ⇒ 每次冷启动都白搭一个 404 样式表请求 + 18 条 CSS 之后的字体回退。**这是零风险、零依赖的止血项。**

### 1.4 客户端的版本敏感面（`public/index.html`）

```
:18  <link rel="manifest" href="/manifest.json" crossorigin="use-credentials" />
:19-23 icons（favicon / app.svg / apple-touch-icon）
:27  /fonts/fonts.css
:29-46  18 条 CSS（theme, components, screens/{title,lobby,room,game,game-shop,game-panels,
        briefing,draft,result,guide,loadout,stats,alliance,damage-board}, emotes, devices）
:48  <script type="importmap">              → 裸标识符 preact / hooks / htm
:51-54 modulepreload: /vendor/preact.module.js, hooks.module.js, htm.module.js, /js/main.js
:57-58 prefetch: /vendor/pixi.min.js, /vendor/pixi-spine.js
:101 <script type="module" src="/js/main.js" onerror="...__spBootFail('load')">
```

**`:101` 已有的 `__spBootFail` 钩子就是现成的回退挂点**——CDN 不可达时可以在这里改注同源 `/js/main.js`，不需要新机制。

### 1.5 已有的、可复用的东西

- `tools/check-imports.mjs`：import 边界检查器，带 `--strict`，并导出了 `maskComments()`（去注释保字符串、保行号）——做"根绝对 specifier"门禁可以直接复用。
- `deploy/stardust/tools/prepare-static-release.mjs` + `deploy/stardust/nginx/ark-proto.conf`：Stardust 那条线**已经**有一套 `releases/<release>/` 钉版 + nginx 302 到静态源的机制；本方案是同一形状，只是静态源换成 R2+Pages。
- CDN 仓 `tools/verify-mirrors.mjs`：逐源 size/sha 校验（判定用解码后的 body，`content-encoding` 存在时跳过 content-length）——**这就是"两个源真的同步了吗"的现成门禁**。

---

## 2. 引用图：哪些动、哪些必须一起动

### 2.1 相对引用全部"深度正确"（⇒ 前缀安全）

实测写法（不是我以为的 `../../../data.js`）：

- `public/js/ui/*.js` → `from '../data.js'`，落到 **`public/js/data.js`**（25 KB，懒加载 `/data/*.json` 的加载器 + 缓存）。深度 2 的文件写 1 个 `..` → 精确，无 clamp。
- `server/sim/*.js` → `from '../shared/tier*.js'`，共 **233 处**（tier1 124 / tier6 28 / tier4 27 / tier5 25 / tier3 22 / tier2 4）。`/sim/x.js` → `../shared/` → `/shared/`，深度 1 写 1 个 `..` → 精确。

⇒ **任何路径前缀下，这 234 处相对引用都自动正确**，因为它们只依赖"两棵子树是兄弟"这个关系。

### 2.2 会打断的只有 3 处（模块来源 origin 根绝对）

| 位置 | 写法 | 为什么被打断 |
|---|---|---|
| `js/render/fx.js:40` | `import('/sim/constants.js')` | 模块 specifier 的根绝对按**模块自身 URL 的 origin**解析 |
| `js/render/fx/speeds.js:25` | `import('/sim/constants.js')` | 同上 |
| `js/render/board3d/load.js:17` | `export const THREE_URL = '/vendor/three.module.js'` | 该常量接下来被 `import()`，同样按模块 origin |
| `public/dev/game-mock.js:6-21` | `import '/js/ui/…'` / `'/vendor/…'` / `'/shared/…'` **16 行** | 同上；该文件是 `game-mock.html` 的夹具，被 `test/ui/{hotkeys,resultbox,devices,facing}.e2e.test.js` 使用 |
| `public/vendor/**`（生成物） | — | **实测 0 处**根绝对（`three.module.js` 用 `'./three.core.js'`，`hooks` 被 `vendor.mjs` 重写为 `'./preact.module.js'`）⇒ vendor 可随前缀发布 |

（`importmap` 里的裸标识符不同：importmap 是**文档**级解析，所以只要 index.html 在容器上，`/vendor/*` 指的是**容器**。这正是"vendor 动、index.html 不动"会静默失效的地方——importmap 必须写成绝对 CDN URL。）

### 2.3 受影响的 5 处"文档 origin 根绝对"（容器 302 可兜住，不用改）

| 位置 | 写法 | 机制 |
|---|---|---|
| `js/render/app/pixi.js:5` | `VENDOR = { pixi: '/vendor/pixi.min.js', spine: '/vendor/pixi-spine.js' }` | 注入 `<script>` → 文档 origin |
| `js/ui/emotes.js:33` | `EMOTE_CSS_HREF = '/css/emotes.css'` | 注入 `<link>` → 文档 origin |
| `js/assets.js:745-746` | `/data/assets.json`、`/data/local-assets.json` | `fetch` → 文档 origin，且 `data/` 本来就在容器上 |
| `js/battle/runner.js:143` | `loadBrowserSim({ base = '/sim/', dataBase = '/data/' })` 默认值 | `/data/` 留容器；`/sim/` 需看调用点是否覆盖 |
| `js/data.js:128` | `base = opts.base ?? '/data/'` | 留容器 |

### 2.4 必须留在容器上的

- `index.html`（版本敏感面见 §1.4）
- `/data.js`：由 `server/http/static.js` 的 `DATA_SHIM_JS` **按请求生成**，磁盘上没有这个文件 → 不能当静态文件发到 R2
- `/data/*.json`：游戏数据
- `/manifest.json`：**`crossorigin="use-credentials"`**（`index.html:18`）。搬到 CDN 就要 `Access-Control-Allow-Origin: <精确 origin>` + `Access-Control-Allow-Credentials: true`；发 `*` 会让 manifest 请求直接失败。**建议留在容器上（同源）。**

---

## 3. tag 怎么才能真正"每个源都同步"

三件事分开看，混在一起谈就会一直漂：

1. **源与源之间（R2 ↔ Pages）**：同一次 `sync.mjs` 运行、同一棵 staging、一次写两边 ⇒ 构造上同步。**你选两个源是对的；五个源之所以会漂，是因为它们由不同流水线在不同时刻喂。** 剩下的只是"发布后验证"：发布完用 `verify-mirrors.mjs` 对两个源跑一遍 size/sha，任一不过就**不写指针**（不对外宣告新 gen）。
2. **容器 ↔ CDN**：`index.html` / `/data.js` / `/data/*.json` 在容器上，客户端包在 CDN 上。⇒ **版本必须由容器钉住**：容器知道自己要哪个 gen，CDN 只负责按 gen 提供不可变字节。这样就不会出现"容器数据 + 新版客户端"的错配。
3. **tag 本身**：必须
   - **纯内容**（sorted path + content 的 sha256，截 12 hex），**不能含 `mtimeMs`**——`buildTag.js` 的 `[rel,size,mtimeMs]` 跨机器不可复现，拿它当跨源 tag 就是假的；
   - 作为**路径段** `/app/<tag>/…`，不是查询串——R2 的 `?v=` 不改对象键，旧 URL 会静默拿到新字节；
   - 由**发布方**计算一次，两个源写同一棵树。

---

## 4. 推荐方案（Option A：容器钉 gen）

```
CDN   https://weishucdn.jiangjiangze.icu/app/<gen>/{js,css,icons,i18n,vendor,sim,shared}/…
      https://spages.jiangjiangze.icu/app/<gen>/…            ← 逐字节相同，同一次发布
容器  index.html + /data.js + /data/*.json + /manifest.json  ← 不动
      SP_APP_BASE=https://weishucdn.jiangjiangze.icu/app/<gen>/
      启动时改写 index.html 的 25 处引用（18 CSS + importmap + 4 preload + 2 prefetch + script src）
      __spBootFail 里回退同源 /js/main.js（容器仍持有整棵树，作为 CDN 不可达时的兜底）
```

**执行前提（按序，每步有独立门禁）**

| 阶段 | 做什么 | 门禁 |
|---|---|---|
| **S0** | `/fonts/fonts.css` 指向 CDN 或补 `public/fonts` | `tools/doctor.mjs` 字体行转 ok；冷启动再无 404 |
| **S1** | 改 §2.2 的 **3 处**为前缀安全（`new URL(...)` / `import.meta.url`） | `check-imports.mjs --strict` 通过 + 新增"无根绝对模块 specifier"检查（复用 `maskComments`） |
| **S2** | 新增 `tools/app-tag.mjs`：对发布子集算纯内容 sha256 | 同一棵树在两台机器/CI 上算出**同一个值**（这才是"可跨源"的证明）；`buildTag.js` 职责不变，勿替换 |
| **S3** | 发布方：CDN 仓 `sync.mjs` 增 `app` 源，按**钉住的 commit** 取 stronghold-server、用同一个 `tools/vendor.mjs` 生成 `vendor/`、写 `/app/<tag>/` 到 R2+Pages | 写完立刻两源各跑 `verify-mirrors.mjs`，**全过才写 `gen` 指针**；`vendor/` 必须与镜像内那份逐字节一致 |
| **S4** | 容器消费：`SP_APP_BASE` + 启动改写 + 回退 | 改写后 25 处引用全部可解析；**黑洞测试**：屏蔽 CDN 仍能启动（走同源回退） |
| **S5** | 线上冷却验证：冷启动瀑布图 | 容器只服务 html/data，其余命中 CDN 边缘 |

**为什么是 Option A 而不是"CDN 指针 + 运行时解析"（Option B）**：B 能做到"只动 CDN 就更新客户端"，但它把客户端与容器的 `/data.js` + `/data/*.json` 解耦——`/data.js` 是按请求生成的、数据和代码本来是一版锁死的。要走 B，就得连 `index.html` 和 `/data/*.json` 一起搬上 CDN（变成一个完全静态的应用壳），那是另一个量级的改造。**在当前约束下 A 已经吃掉了带宽和缓存两处收益，且完全可回退。**

---

## 5. 风险与待验（PENDING）

| # | 项 | 影响 | 怎么验 |
|---|---|---|---|
| R1 | `vendor/` 跨机器逐字节可复现 | tag 撒谎 / 两源字节不一致 | 同 lockfile 下 CI 与本地各跑 `tools/vendor.mjs`，比 sha256。**前缀安全那一半已实测通过**（§2.2 末行）；逐字节复现仍未验 |
| R2 | R2 上 `.js` 的 `Content-Type` | 错即模块加载失败 | `curl -sI` 看 `content-type` 是否 `text/javascript`（不是 `application/octet-stream`） |
| R3 | Pages 的 CORS | 模块是 CORS fetch，缺 ACAO 直接失败 | 两源各 `curl -sI -H 'Origin: https://<容器域>'` 看 ACAO（weishucdn 已实测 `*`） |
| R4 | `manifest.json` 的 `use-credentials` | 搬到 CDN 会失败 | 本方案留在容器，无需处理；若将来要搬，ACAO 必须精确 + ACAC:true |
| R5 | `/sim/` 的 base 调用点 | `runner.js:143` 默认值可能被调用方覆盖 | 读调用点确认 `loadBrowserSim` 的实际 base |
| R6 | **线上容器行为未证实** | 我只能推断 | 创空间 `proxy/7860/` 对**任何路径**都返回平台 SPA（含 `/js/main.js`），本机探不到容器的真实静态行为。S5 需要在能直连容器的地方做 |

---

## 6. 明确不做的事

- 不改 apk 线（用户已明确）。
- 不用盒子更新器。
- 不引入第三、第四个源；tag 同步的前提就是**只有一条发布流水线**。
- 不改 `buildTag.js` 的既有语义（它给 `/client-build` 和 `buildGuard.js` 用），只**新增**一个纯内容 tag 给 CDN 用。

---

## 7. 实作记录（S0 + S1，2026-10-11）

### 7.1 S0 —`/fonts/*` 不再 404

**新增** `server/http/asset-cdn.js`：从 `data/assets.json` 的 `fonts.css` 绝对 URL **推导**基址（不硬编码主机），把 `fonts.faces.*` 的绝对 URL 建 `path → URL` 表；清单解析结果按 `size + mtime` 记忆（清单 5+ MB，不能按请求解析）。

**改** `server/http/static.js`：ENOENT 分支对 `/fonts/*` 先问 `asset-cdn`，有 URL 就 `302` + `Cache-Control: public, max-age=86400`（**必须给 302 带缓存头**，否则每次冷启动都回容器——这是 `/dl/` 路由踩过的同一个坑），否则维持 404。**本地优先**：`public/fonts` 存在时仍走本地文件（自包含部署行为不变）。

两条关键依据：`public/fonts` 只在 `FETCH_ASSETS=1` 时由 `tools/fetch-assets.mjs` 生成，镜像里没有；而 CDN 上的 `fonts.css` 内部用根绝对 `url('/fonts/…')`，**按样式表自身 URL 的 origin 解析**，所以从 CDN 取它是对的。

**新增测试** `test/fonts-cdn-fallback.test.js`（5 个）：样式表保留清单里带 `?v=` 的 URL；命中的 face 走清单 URL；未命中的字体按"样式表旁边"解析；**本地文件不被遮蔽**；自包含清单/无清单仍 404；`fontUrlsFrom` 对畸形清单的容忍与"镜像搬到路径前缀也跟随"。

### 7.2 S1 —根绝对 specifier 清零

改动：`public/js/render/fx/speeds.js`、`public/js/render/fx.js`（注释）、`public/js/render/board3d/load.js`、`public/dev/game-mock.js`（16 行）。全部改为**webroot 兄弟相对**（`js/`、`sim/`、`vendor/`、`shared/` 是同级子树），容器根布局与 CDN 前缀布局下**同一写法都成立**；`speeds.js`/`load.js` 的动态 `import()` 按模块 URL 解析，Node 下行为不变（`public/sim/` 本就不存在 → 与改前的失败方式一致，都被 catch）。

**新增门禁** `test/module-specifiers.test.js`（4 个）：复用 `tools/check-imports.mjs` 已导出的 `findSpecifiers()` 扫 `public/js`、`public/dev`、`shared`、`server/sim`，断言零根绝对；含**反向用例**（喂一个含 `/js/other.js` 的夹具，证明检查器真会报）和**覆盖度用例**（>100 文件 / >500 specifier，防止 walk 坏掉后"静默全绿"），外加 `THREE_URL` 的定点用例（提取器看不见字符串常量，只能这样钉）。`node --test` 本身就是 CI 的一步，所以没有改 `ci.yml`。

### 7.3 验证

| 项 | 结果 |
|---|---|
| 新增 9 个测试 | `PASS` |
| `ci.mjs --only imports,typecheck` | `PASS`（两步 ok） |
| 改动/新增的 8 个文件 eslint | `PASS`（0 error；`public/dev/*` 在本仓 eslint ignore 之外） |
| `ci.mjs` 全量 `test` | `FAIL`：2 个失败，**均既有** |
| `ci.mjs` `lint` | `FAIL`：22 个 error，**均既有** |

**两条既有的红**都来自 `d70d3e8`——它的提交消息写着"素材清单改用 weishucdn"，实际是 **1676 文件 / 591,174 行插入的整树导入**：`test/ui/localArt.test.js:139`、`test/ui/playtest3.test.js:343` 断言清单是根相对路径（`/assets/…`），而同一提交把 `data/assets.json` 钉成绝对地址；`eslint` 的 22 个 error 全在导入进来的 `server/sim/content/kits/tier[2-6].js`（用了 `Math.hypot/pow/sin/cos`，违反本仓"确定性数学走 `server/sim/detmath.js`"的规则）。**修这两条不在 S0/S1 范围内，且该仓当时有并发会话在动，故未改。**

### 7.4 状态与未做项

- 这 8 个文件**没有由我提交**：并发会话（`forge-sync` 那条线，"保存上游合并前工作状态"）把工作区整体存档成 `1505aa2`（作者 `agent <forge-sync@users.noreply.github.com>`，**本地、未推送**，内容已逐项核对完整）。
- **S2**（`tools/app-tag.mjs` 纯内容 tag + 跨机器复现验证）、**S3**（发布流水线）、**S4**（容器 `SP_APP_BASE` + index.html 改写 + `__spBootFail` 回退）、**S5**（线上冷却验证）未做。S3 需要 CF 凭据与写入授权；S4 的改写面见 §1.4 的 25 处引用。
- ⚠️ S1 改的正是上游合并最容易冲突的文件（`public/js/render/*`、`server/http/static.js`）——下一次 forge-sync 合并前需确认这三个文件的归并。
