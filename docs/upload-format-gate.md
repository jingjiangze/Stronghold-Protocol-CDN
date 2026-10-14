# 上传后台的格式闸门（静态素材直发，其它先暂存）

落地日期 2026-10-14。影响面：`https://downcdn.jiangjiangze.icu/admin` 与 agent 上传通道
（`/api/cdn/upload/begin|put|commit`）、发布轮 `src/promote-uploads.mjs`。

## 规则

对外键（玩家会下载的地址）只发**静态素材**。一条上传属于静态素材，必须同时满足两条：

1. **格式**在名单里：`png jpg jpeg webp gif`、`atlas skel obj bin json`、`mp3`、`woff2 otf ttf`；
2. **落点**在素材树：`assets/**` 或 `fonts/**`。

两条缺一不可，判据在 `src/upload.mjs` 的 `formatVerdict()`：

- `.json` 两边都是。素材面有 26 个 `materials.json/tiles.json`、scene 导出的 `scene.json`；
  元数据面有 `packs/mod-assets/index.json`、mod 的 `manifest.json`。**只看扩展名就分不开这两种。**
- `.zip`（按需素材包、mod 分卷）、`.txt`、`.ogg`、`.wav`、`.m4a`、`.woff`、`.xml`、`.data` 这类
  名单外的格式：**照旧收进暂存区，但不上线**。以前它们会被发布轮直接搬到对外键。

名单外的危险扩展名维持**当场拒绝**（不是暂存）：`html`、`svg`、`js` 等。这个桶的自定义域名对全世界
发 `Access-Control-Allow-Origin: *`，在自己的域名上放一个可执行内容位等于开 XSS 面。

### 已知盲点（写清楚，不含糊）

落在 `assets/**` 里的素材格式**一律当素材直发**，包括别人塞进树里的元数据 —— 例如
`assets/local/<source>/config-*.json` 这类 mod 配置。没有任何「前缀 + 扩展名」规则能把它们和
`materials.json` 分开，所以这一版的取舍是：**要经审计的东西请放 `packs/<source>/`**（`tools/agent-upload.mjs`
的默认键就是这个形状），别往 `assets/**` 里塞清单。这条由
`tests/upload-format-gate.test.mjs` 钉住（它断言的是「选定的行为」，不是「完美的行为」）。

## 状态与放行

| 阶段 | 谁写 | 内容 |
|---|---|---|
| 上传 | `begin` / `put` | 响应里带 `tier: "asset" \| "hold"` 和 `holdReason`，agent 在传之前就看得见 |
| 收下 | `commit` / `put` | 写 `claim.json`，带上 `tier`。**待审的这份不叫发布轮**（叫了也只会被跳过，白烧一轮 Actions） |
| 发布 | `promote-uploads.mjs` | `asset` → 逐字节核对 sha256 后 CopyObject 到对外键；`hold` → 跳过，**暂存字节保留不动**，不进 hosted.json、不进 upload-log，对外零影响 |
| 放行 | `POST …/release {id, note}` | 人工审计之后一次性、单向地给 claim 打 `releasedAt/releasedNote/releasedBy/releasedVia`，然后叫一轮发布；上线验收与直发走同一套 sha256 核对 |

放行不做批量：一个 id 一次请求。放行也不降低标准——字节仍由 Actions 逐字节核对才落到对外键。
清理待审件仍走既有通道：`DELETE …/staging?id=<上传 id>`（立即真删，只动暂存区）。

## 两条实现上的「为什么」

- **待审的 claim 不引入新 `state` 值。** `claimIsPublishable` 对不认识的 state 返回「不合格」，
  而不合格的处理是**删掉暂存字节**。上线间隙里如果还有旧版发布轮在跑，新状态值会让它把人刚传上来的
  东西删掉。所以待审用 `tier` 字段表达，state 只用老值；发布轮按 `verdict.hold` 分流。
- **待审的组不计入 `PENDING_LEFT`。** 触发式发布是「PENDING_LEFT>0 就自己再投一轮」。
  待审件如果算进剩余量，就会永远投下去。

已知间隙：Pages 边缘（新代码）与发布轮（同一 commit 的 Actions checkout）之间有几分钟的部署窗口。
窗口内若有旧版发布轮跑完，它会把待审的那一份当成正常件发出去（**fail-open**，不会丢字节）。
宁可这几分钟漏一道闸门，也不要旧代码误删暂存的字节。

## 前端

`site/js/admin.js` 的「待审计」面板列在暂存区树顶上，每行一个「审计后放行」按钮。
页面自己按同一套规则判一次（`awaitingAudit`），因为 status 接口回的是 claim 的 `state`、不含 `tier`。
判得不一致也不会误上线：放行端点自己会说「这一份是静态素材，不需要放行」。

## 还差一行（这次没做：避开并发会话的未提交改动）

`site/docs/agent-upload.md` 里那句「扩展名 只收素材：… zip bin data xml」现在只描述了
**暂存区收不收**，没描述**上不上线**。那一行要改成两份名单（直发 / 待审），但本次 `agent-upload.md`、
`site/admin.html`、`functions/api/cdn/upload/status.js`、`src/api-contract.mjs`、`hosted.json` 在另一会话里
有未提交改动，不去抢写。等那边的改动落地后补这一行即可（改文档不动逻辑）。
