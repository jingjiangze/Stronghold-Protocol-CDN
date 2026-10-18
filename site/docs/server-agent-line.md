# 服务端 agent 线：三分支、布阵学习、离线聚合、客户端评分与重连

> 这篇把服务端 agent 仓（`jingjiangze/stronghold-server-server-agent`）在 2026-10-18 这一轮的全部改动收在一页：
> 仓库为什么拆成三条分支、学习库怎么按「玩法 + 难度」分开、上传时机与默认值、R2 历史怎么聚合、
> 客户端怎么在托管/房间里跑评分模拟、以及服务器重启后的重连与「用本地状态反推」的可行边界。
> 常量与文件路径都取自源码；「未接线」的项在第六节逐条列出。

## 一、三条分支，各管一种部署形态

| 分支 | 形态 | 关键差异 | 适用 |
|---|---|---|---|
| `master`（默认） | 通用服务器 | `Dockerfile` 直接 `HOST=0.0.0.0 / PORT=3000`、无边缘层、无 `tools/deploy-ms/` | 自己机器 / VPS 长期开服 |
| `docker` | 魔搭创空间 | 容器内 nginx 占 7860、游戏退 3120、`HOST=127.0.0.1`、`tools/deploy-ms/`（14 个文件）+ `deploy-ms.yml` | 创空间（容器易失） |
| `p2p` | 通用 + openp2p 接入 | `server/platform.js`（开房登记、`room.state.inviteUrl`、`GET /api/platform`）、邀请框优先用平台链接 | 房主自建服，玩家经隧道直连 |

三条分支都过同一套 CI（tooling + ubuntu/windows × node 22/24），改动逐条 cherry-pick 保持一致。

## 二、学习库：按「玩法 + 难度」分开

存储从「每玩法一个文件」改成「每玩法 + 每难度一个文件」：

```
<库目录>/lineups_<modeId>__<DIFFICULTY>.jsonl
例：lineups_mode_single_hard__HARD.jsonl / lineups_mode_single_hard__NORMAL.jsonl
```

- 分隔符是**双下划线**：`modeId` 自身含单下划线（`mode_single_hard`），单下划线分不开模式与难度；
  难度固定大写（`TRAINING/FUNNY/NORMAL/HARD/ABYSS`），两侧字符集都不会自然出现 `__`。
- 一条改动穿透四条链：库读写（`lineupFile/appendLine/library/humanPlans`）、下发同步（`lineupSync`
  的同步单位 = 库键）、上行发布（`publishOneMode({key})`，键 `packs/lineup-library/<key>-<日期>.jsonl`）、
  增量补传（`lineupOutbox` 按「玩法 + 难度」分组）。
- **老布局仍可读**；升级用 `node tools/migrate-lineups.mjs <库目录> --apply` 拆分（旧文件改名
  `.migrated` 保留，幂等，有 3 例测试）。

## 三、默认值与上传时机

| 项 | 现在 |
|---|---|
| `SP_LINEUP_MODE` | **默认 `local`**：本机记录真人布阵并上传（`SP_LINEUP_PUBLISH_URL` 默认 `downcdn` = R2 前置）；`public` = 只读（R2 稳定别名 → GitHub 镜像兜底）；`off` = 关闭 |
| 上传时机 | **对局结算后立即**（`flushMatchLineups` → `flushHook` → `outbox.requestFlush()`，3 秒合并窗口），15 分钟定时器降级为兜底 |
| 只上传训练文件 | 专用通道 `/api/lineup/{begin,put,commit}` 只接受 `packs/lineup-library/*.jsonl`；⚠️ 同一把 `CDN_ADMIN_KEY` 仍可走主通道传素材，**钥匙级隔离未做** |
| 409 语义 | 同日键已存在 = 今日键位已占 ⇒ **保留队列、推到次日**（不能当「已上传」删行，否则丢数据） |
| 滚动窗口 | 每库最多 4000 行 / 3 MiB，重写用 `.partial` + `rename`（原子，读者看不到半截库） |

## 四、离线聚合：R2 的日期键就是语料库

日期键**只增不改**，`listKeys` 可分页枚举（1000/页、最多 60 页）⇒ R2 里是完整历史。
聚合工具 `tools/lineups-aggregate.mjs`：

```bash
node tools/lineups-aggregate.mjs <同步下来的目录…> [--since 2026-10-01] [--max-lines 20000] [--out <目录>]
```

- 认 `<模式>__<难度>-<日期>.jsonl` 与 `lineups_<模式>__<难度>.jsonl` 两种名字（可重复跑）；
- 按 `sig` 去重（与写库端 `sigOf` 逐字同构）、坏行计数丢弃；
- 输出每库一份合并文件 + `stats.json`（行数 + 几何特征汇总）；
- 不联网、不进游戏进程，可进 CI 做数据集快照。

## 五、客户端：特征化与评分调度

**特征化**（`shared/lineupFeatures.mjs`，纯函数，浏览器/Worker 直接可用）：
棋子数、金色数、行/列跨度、朝向分布、纵深占比、质心距离；`summarizeFeatures()` 做均值/中位数汇总。
**强度不在这里算**——rehearsal 的模拟结果（leaks 少者胜、再比 kills）才是质量口径。

**评分调度**（`shared/scoringPolicy.mjs` + `shared/scoringQueue.mjs` + `public/js/ai/scoringRunner.js`）：

| 条件 | 行为 |
|---|---|
| 托管（`away` / `autoplay`） | 最高优先跑 |
| 房间界面（`room` / `lobby`） | 次优先 |
| 对局内 + 高配 + 页面空闲 | 低优先 |
| 低配机 / 页面忙 / 不可见 / 离线 / 队列满 | 不跑 |

机器档位 `deviceTier()` 支持核数/内存或实测微基准；队列有 20 秒预算、`pause/resume`、
`abort()`（全清）/`abort(id)`（单条）与 `isAborted()` 协作式中断；Worker 新增 `t:'score'` 模式，
逐条返回 `{index, built, leaks, kills, score}`。

## 六、重连与「用本地状态反推」

审计结论：**对局状态 100% 在服务端内存**，客户端本地没有可复原的副本——能复用的是**身份与房间**，
不能是「接着上一局」。

- 已实现：会话重置（服务器重启后 playerId 变化）时，客户端读本地 `sp.matches`（带时间戳），
  用 `shared/resumeTarget.mjs` 在 10 分钟重连窗口内挑一条，设 `pendingJoin` 自动回房间；
  房间不在则按原路径回大厅（安全降级）。
- 反推方案（`docs/RECONNECT-LOCAL-REBUILD.md`）：客户端手里有每个玩家自己的棋盘/手牌/资金/商店/生命/阶段，
  没有共享卡池剩余、seed、RNG 状态、AI 布阵序列。可行形态是「按所有玩家上报的状态重组一局，
  在下一个 PREP 接着打」，容差显式标注（玩家数据精确、卡池与 AI 布阵漂移、进行中的战斗丢弃）。
  快照格式与校验已实现（`shared/matchSnapshot.mjs`：白名单、16 KB/人、越界丢弃、整组一致性）。
- 魔搭版（`docs/RECONNECT-MOTA.md`）：容器重启即清盘 ⇒ 服务端落盘房间壳无效，改为**客户端携带恢复包**
  （`sanitizeBundle` / `agreeOnBundles`，多份包 seed/房间/模式必须全等，否则拒绝恢复）。需要新增
  `m.private.seed` 下发与 `b.recover` 上报两处协议。

## 七、未接线清单（明确没做的）

| 项 | 状态 |
|---|---|
| 客户端评分闭环的任务来源（服务端下发批次 / 客户端拉公共库）与回报通道 | 注入点已留（`nextTask()` / `report()`），未接线 |
| 房间壳持久化（含 seed）与服务端 Match 重建器 | 设计完成，未实现 |
| `m.private.seed` 下发、`b.recover` 协议 | 设计完成，未实现 |
| 「只能传训练文件」的钥匙级隔离 | 需 CDN 后台签发限定来源的口令 |
| 真·模型训练 | 当前方案到「质量表 + 候选择优」为止，不做梯度训练 |

## 八、验收口径

- 三分支 CI 全绿（tooling + 四矩阵）；学习库全套 46 例、快照/恢复包 9 例、评分调度 8 例、
  聚合工具 5 例、迁移 3 例。
- 线上验证一律看**内容**而不是状态码：`/docs/<file>.md` 要 `text/plain`，并与本地逐字节比 sha256。
