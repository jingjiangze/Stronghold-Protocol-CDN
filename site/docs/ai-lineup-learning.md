# AI 布阵学习库

> 这篇讲服务器怎么把真人玩家的最终布阵攒成本地库，并让 AI 队友在整备时检索同玩法 / 同关卡 / 同难度的真人布阵作额外候选。它是 `server/lineupLibrary.js` / `lineupSync.js` / `lineupPublish.js` 三件套的行为说明，续「服务器部署」里「AI 布阵学习库」两节。常量直接取自源码；代码已实现，但真实玩家数据尚未产生——首次真实数据要等某台服务器跑够一局并正常结算。

## 一、它是什么，默认是开的（`SP_LINEUP_MODE=local`）

学习库由 `SP_LINEUP_MODE` 决定形态（2026-10-18 起**默认 `local`**）：`local` = 本机记录真人布阵并走专用通道上传（`SP_LINEUP_PUBLISH_URL` 默认 downcdn，即 R2 前置）；`public` = 只读远端（R2 稳定别名优先、GitHub 镜像兜底，适合魔搭等易失容器）；`off` = 彻底关闭（不记录、不读、不上传）。显式设了 `SP_LINEUP_LIBRARY`（目录 / 文件 / `remote:...`）时以它为准。上传时机是**对局结算后立即**（3 秒合并窗口），15 分钟定时器只作兜底。

## 二、数据从哪来（记录时机）

记录分两步，中间隔着一道内存暂存，目的是「未成功结算的对局不进入存储」：`MatchPrep.endPrep` 调 `recordPrepLineups`，把每个**真人座位**（`alivePlayers()` 里 `botControlled` 为 false）的最终棋盘暂存到内存（`staged`），只记不写；`MatchSettle.finish` 调 `flushMatchLineups` 才把暂存布阵 append 到文件；半路消亡（dispose）调 `dropStagedLineups` 清空暂存。因此开了局却没打出结果的对局（断线、全员离开、被清理）不会留痕——库里只有「真的结算过」的对局。

## 三、哪些对局算数（结算原因白名单）

落盘前先按结算原因过滤，只有白名单里的原因才会被学习：

```js
const USABLE_REASONS = new Set(['victory', 'defeat']);
```

不在白名单里的三种原因一律不学，各自含义：

| 原因 | 含义（为什么不学） |
|---|---|
| `error` | 开局 / 运行期数据坏掉，没打出有效布阵 |
| `abandoned` | 全员离开，或冻结超时，对局半途而废 |
| `eliminated` | 被淘汰，半路出局 |

`defeat` **算数**：正常打到 Boss、只是最后输，是一局真实完整的对局。`victory` 同理。

## 四、记的是什么（记录字段）

每条记录是 JSON 对象，固定带这些顶层字段：`t`（记录类型，恒为 `"lineup"`）、`at`（`new Date().toISOString()`）、`modeId`/`stageId`/`difficulty`/`round`（玩法 / 关卡 / 难度 / 回合，检索键来源）、`sig`（布阵签名，用于去重与 farm 判定）、`cells`（棋盘上每个棋子的明细数组）。每个 `cell` 形如 `{ id, golden, row, col, dir }`：`id` 是棋子种类（`piece.id`）、`golden` 是否金牌（`m.gd.isGolden(piece.id)`）、`row`/`col` 是坐标、`dir` 是朝向。

**为什么 `dir` 要单独取**：结果摘要里的 `lineup` 不含朝向，但 AI 重放布局要按朝向摆（攻击、技能朝向都依赖它），所以记录阶段用 `pieceDir(piece)` 把朝向一起存下，否则布阵无法正确重放。

**隐私相关的事实**：记录里**没有任何玩家身份**——无玩家名、账号、session id，只有「某局某座位」的棋子 id 与坐标。这是设计使然，也是可对外说明的真实事实。

## 五、异常数据过滤

数据入库前过几道关，「异常的素材不要」：

- **近乎空盘**：`recordPrepLineups` 阶段就丢——`cells.length < 2` 的座位直接跳过。
- **越界坐标**：`validCells` 用 `inField` 判定，战场范围来自 `server/match/board.js` 的 `FIELD = { r0: 9, r1: 12, c0: 2, c1: 10 }`，超出算损坏、丢弃。
- **非法朝向**：`validCells` 用 `isDir` 判定，合法值只有 `UP` / `RIGHT` / `DOWN` / `LEFT`（见 `server/sim/dir.js`），其它丢弃。注意记录阶段 `pieceDir` 会把非法朝向**归一为 `RIGHT`**（`board.js` 的 `DEFAULT_DIR`），所以本机记录的朝向本身永远合法；这条检查真正挡住的是**外部同步进来的**坏行。
- **刷分 / 脚本（farm）**：`flushMatchLineups` 阶段用 `isFarm` 判定，同一布阵签名（`sig`）在 `FARM_WINDOW_MS = 60 * 60 * 1000`（1 小时）窗口内出现超过 `FARM_MAX_PER_WINDOW = 40` 次即丢弃。判定只看速率、不看人气——真正常见、被很多不同玩家各用一次的布阵仍正常；一个座位 1 小时内刷同一盘面 40+ 次才是异常。
- **发布侧再挡一层**（`publishableFile`）：空文件不发、单文件超 `MAX_BYTES_PER_FILE = 3 MiB` 不发、名字含 `.partial` 的中间文件不发。

## 六、AI 怎么用它

检索与重放的边界：**键**由 `keyOf` 拼出 `modeId|stageId|difficulty|round`（单文件旧布局 `modeId` 为空串 `NO_MODE`），只取「同玩法 + 同关卡 + 同难度 + 同回合」的真人布阵；**按棋子 id 映射**——每局 `uid` 重置（`Match.js` 的 `uidSeq`），映射靠**棋子种类 id** 不靠 uid，`humanPlans` 把记录 `id` 映射成本局抽到、同名且未用的棋子，抽不到的丢弃，空位由 `applyPlanSteps` 第二遍兜底；**插入位置**作为**额外候选**插在默认方案之后——`plans.splice(1, 0, ...humanPlans(m, chosen))`（`server/match/bot.js:1619`），默认方案仍是 `plans[0]`（rehearsal 还在跑时就先落地的那套），每个 bot 每次 prep 最多取 `PLANS_PER_PREP = 2` 条；**谁判断质量**——「记录」不判断质量、「模拟」才判断，真人布阵只是多一个候选，最终由试算（rehearsal）裁决，模拟不占优就永远不选，库里可能有平庸甚至很差的布阵，经不起模拟就不会被 AI 采用。

## 七、存储布局与上限

**推荐布局（分玩法 + 分难度目录）**：`SP_LINEUP_LIBRARY=/app/lineups` 指向目录时，库写成 `<dir>/lineups_<modeId>__<DIFFICULTY>.jsonl`（例：`lineups_mode_single_hard__HARD.jsonl`）——**每个「玩法 + 难度」组合一个文件，互不串味**；双下划线是因为 `modeId` 自身含单下划线。老布局（每模式一个文件）仍可读，升级用 `node tools/migrate-lineups.mjs <库目录> --apply` 拆分。**兼容布局（单文件）**：指向具体文件路径时，不分模式、写进同一文件，检索键里 `modeId` 为空（`NO_MODE = ''`）。这是分模式拆分前的旧布局，升级部署后仍能读回自己写的东西。

**滚动窗口（库不会写满磁盘）**：

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_LINES` | `4000` | 单文件最多保留的行数 |
| `MAX_BYTES` | `3 MiB` | 单文件最多保留的字节数 |
| `READ_LIMIT` | `MAX_BYTES * 2 = 6 MiB` | 启动只读文件尾部这么多 |
| `PER_KEY_KEEP` | `6` | 每个键最多保留的不同布阵数 |
| `PLANS_PER_PREP` | `2` | 每个 bot 每次 prep 最多取几条 |

超出 `MAX_LINES` / `MAX_BYTES` 任一项时，就地丢弃最老 10%（`roll` 重写文件），保留最新 90%——代价是会慢慢忘掉老布阵，这是有意取舍，不是 bug。启动只读尾部 `READ_LIMIT` 是为已超上限的文件也能装满窗口。

## 八、部署形态：普通服务器 vs 魔搭创空间

两种部署的差别来自「有没有持久卷」，直接决定库能否长期存在：

```bash
# 普通服务器：库目录挂一个持久卷
docker run -d --name stronghold -p 3000:3000 --restart unless-stopped \
  -v "$PWD/lineups:/app/lineups" -e SP_LINEUP_LIBRARY=/app/lineups \
  stronghold-protocol
```

```bash
# 魔搭创空间：镜像里 SP_LINEUP_LIBRARY 默认 /app/lineups 只是易失目录，重启即清空；
# 要学到东西只能当只读消费者（不要配 CDN_ADMIN_KEY）：
SP_LINEUP_LIBRARY=remote:<镜像或CDN地址>|/tmp/lineups
```

要点：

- **普通服务器挂 `/app/lineups` 而非 `/app/data`**：空卷会遮住镜像 `COPY` 进的内容；但镜像本身不含学习库文件，挂空卷安全。挂别处也行，`/app/lineups` 只是镜像已声明的默认值。
- **魔搭创空间无持久卷**：平台每次 push 重建镜像，容器内写的东西随旧容器销毁，只能当**只读消费者**，从 CDN / 镜像拉别人发布的库，自己不回写。
- **魔搭不要配 `CDN_ADMIN_KEY`**：无持久化，发出去的是每次重启都丢的样本，还把凭据塞进公开平台环境变量。

| | 普通服务器 | 魔搭创空间 |
|---|---|---|
| 本地库 | 有（挂卷后跨重建保留） | 无（容器易失，重启即丢） |
| 读取 | 本地库优先，可按需叠加 remote | 只能 remote 只读拉取 |
| 写回 CDN | 支持（需 `CDN_ADMIN_KEY`） | 不支持（不发凭据、样本也会丢） |
| 适用场景 | 自有机器 / VPS，长期开服 | 公开展示、体验一局就走 |

## 九、远端只读读取

当一个服务器不想暴露自己的布阵数据、只想学别人发布到 CDN 的库时，用远端规格（`server/lineupSync.js`）：

```bash
SP_LINEUP_LIBRARY=remote:<url1,url2,...>|<cacheDir>
```

行为细节：对每个待同步库键拉 `<url>/lineups_<modeId>__<DIFFICULTY>.jsonl`（与本地布局同前缀）；多个 URL 逗号分隔、按序回退、第一个完整取到的即停；默认 `6` 小时一次（`SP_LINEUP_SYNC_MS` 可改；底层 `DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000`），带 ETag / `304`；先写 `<dest>.partial` 再 `rename`，半截文件不会被 `lineupLibrary` 看见；每次拉到新字节后 `reloadLibrary()` 丢缓存，下次 bot 查询直接读新字节、无需重启；`SP_LINEUP_SYNC=0` 关掉本模块（本地路径语义不受影响）；默认同步 `DEFAULT_SYNC_KEYS` 六个「模式__难度」键（`mode_single_normal__NORMAL` … `mode_multi_abyss__ABYSS`），可用 `SP_LINEUP_SYNC_KEYS` 覆盖（旧名 `SP_LINEUP_SYNC_MODES` 仍兼容）。

## 十、写回 CDN（R2 promote 通道）

有持久库、且配了口令的服务器，可把库发到 CDN 供别的服务器与公开镜像学习。开关与配置：

- `SP_LINEUP_PUBLISH=0` 关闭（不设且没口令时本模块无事可做——没有 `CDN_ADMIN_KEY` 整条跳过，不是错误）。
- 口令 `CDN_ADMIN_KEY`：环境变量优先，否则读 `~/.cdn_admin_key`；**绝不进命令行参数与日志**。
- **时机**：启动时发一次 + 之后每 `LINEUP_PUBLISH_INTERVAL_MS = 24 * 60 * 60 * 1000`（24 小时）一次。
- **键名与只增不改**：键为 `packs/lineup-library/<modeId>-<YYYY-MM-DD>.jsonl`（UTC 日期）；同一天重复发布同键名会收 `409`，这是特性不是错误——当天该模式已发过，镜像那份即答案。
- **上传端点 / 分组**：默认端点 `https://downcdn.jiangjiangze.icu`（`SP_LINEUP_PUBLISH_URL` 可覆盖），hosted.json 分组默认 `lineup-library`（`SP_LINEUP_PUBLISH_SRC` 可覆盖）。
- **只有本地库会发布**：`remote:` 规格的服务器是读者，index.js 里 `lineupPublishDir` 仅在非 remote 且有本地库目录时非空，故远端规格不回写。

## 十一、怎么在素材清单里看到

发布后文件落在 `packs/lineup-library/…`。promote 登记 `hosted.json` / `hosted-index.json`，再由 `sync.mjs` 合并进 `tree.json`；站点素材浏览面读 `tree.json`，故库文件自动出现在素材清单里。公开字节由 CDN 域名按路径提供：`speedcdn.jiangjiangze.icu`（备用 `weishucdn.jiangjiangze.icu`），路径即 `packs/lineup-library/<modeId>-<YYYY-MM-DD>.jsonl`。

## 十二、失败语义（为什么它不会拖垮对局）

学习库是纯增强，所有错误都只记日志、不进对局：

- **记录 / 读库异常**：`recordPrepLineups` / `flushMatchLineups` / `library()` 的异常都包在 `try/catch` 里，不会进入对局 `errors`（结算页字段），更不会让一局游戏崩。
- **同步失败**：只记日志，按指数退避（上限 1 小时，`lineupSync.js` 的 `backoffUntil`）。
- **发布单文件失败**：只累加 `failed` 计数，整次发布照常走完其它文件。
- **定时器**：`setInterval` 都 `unref()`，不吊住进程退出。

缺了学习库，AI 只是回到默认布阵，对局照常进行。

## 十三、最小可验证

下面是一段本机验证命令，让人能自己确认链路通不通。**注意：构造的是假的本机库，仅用于验证服务器能读、能发日志；不要把它发布到 CDN。**

```bash
# 1) 造一个假库：两条同模式同关同难度同回合、且能通过 validCells 过滤的记录
mkdir -p /tmp/fake-lineups
cat > /tmp/fake-lineups/lineups_mode_single_normal__NORMAL.jsonl <<'EOF'
{"t":"lineup","modeId":"mode_single_normal","stageId":"stage1","difficulty":"normal","round":1,"cells":[{"id":"a","row":10,"col":3,"dir":"RIGHT"},{"id":"b","row":11,"col":4,"dir":"UP"}]}
{"t":"lineup","modeId":"mode_single_normal","stageId":"stage1","difficulty":"normal","round":1,"cells":[{"id":"c","row":9,"col":5,"dir":"LEFT"},{"id":"d","row":12,"col":6,"dir":"DOWN"}]}
EOF

# 2) 用假库启动服务器（只验证读路径，不开发布——没有 CDN_ADMIN_KEY 发不出去）
SP_LINEUP_LIBRARY=/tmp/fake-lineups node server/index.js

# 3) 看日志标记：[lineup-library] 只在出错时打印（正常记录/追加/滚动不写日志）；
#    [lineup-sync] 仅配了 remote 时出现；只要本地库目录存在就会有一行 [lineup-publish] 汇总，
#    没有口令时那行写「没有上传口令」。

# 4) 确认本篇文档能按纯文本取回：
curl -I https://downcdn.jiangjiangze.icu/docs/ai-lineup-learning.md
#    预期 Content-Type 含 text/plain，且不 404。
```

要验证「远端只读」链，把第 2 步换成 `SP_LINEUP_LIBRARY=remote:http://127.0.0.1:<静态服务>/lineups|/tmp/lineup-cache`，再起静态服务把假库挂在 `/lineups/lineups_mode_single_normal__NORMAL.jsonl`，观察 `[lineup-sync]` 拉取日志。验证「写回 CDN」需另配 `SP_LINEUP_PUBLISH`（非 `0`）与 `CDN_ADMIN_KEY`——真实口令不在本机，这一步需部署到有凭据的服务器执行。

## 状态词

- `BASELINE`：源码 `server/lineupLibrary.js` / `lineupSync.js` / `lineupPublish.js` 及 `server/index.js`（30–145 行）、`server/match/bot.js`（95、1616–1619 行）、`docs/DEPLOY.md` 的「AI 布阵学习库」两节。常量逐条核对源码：`MAX_LINES=4000`、`MAX_BYTES=3 MiB`、`READ_LIMIT=6 MiB`、`PER_KEY_KEEP=6`、`PLANS_PER_PREP=2`、`USABLE_REASONS={victory,defeat}`、`FARM_WINDOW_MS=1h`、`FARM_MAX_PER_WINDOW=40`、`FIELD={r0:9,r1:12,c0:2,c1:10}`、`isDir∈{UP,RIGHT,DOWN,LEFT}`、`DEFAULT_SYNC_MODES`（六个 mode）、`LINEUP_PUBLISH_INTERVAL_MS=24h`、发布端点 `https://downcdn.jiangjiangze.icu`、分组 `lineup-library`。
- `IMPLEMENTED`：三件套与装配逻辑已在仓库内实现；本篇文档写入 `stronghold-cdn` 仓库 `site/docs/`。
- `PENDING`：真实玩家数据尚未产生——首次真实库内容要等某台配了 `SP_LINEUP_LIBRARY` 的服务器跑够一局并正常结算（`victory` / `defeat`）。仓库内附单测（未在本机运行验证）。
- `FAIL`：未跑真实部署验证（无控制台操作、无 `CDN_ADMIN_KEY`），上述验收命令需部署后执行。
