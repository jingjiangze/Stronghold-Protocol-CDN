# WS 压缩：独立库与工坊兼容包

> 这一份讲**复用与分发**：压缩模块已经从游戏服务器里抽出来独立发布，
> 并且做成了 Forge 工坊的兼容包。**重点是那个"兼容"到底能做到什么程度** —— 比很多人预期的要少。
> 日期：2026-10-12 · 配套：[《WS 链路压缩（当前已上线）》](./ws-link-compression.md)

---

## 一、独立库

<https://github.com/jingjiangze/stronghold-ws-compression> · MIT · 零依赖（`ws` 是唯一 peer）

```
src/wsCompression.mjs      档位 + 选项集 + 白名单 —— 零依赖，可单独用
src/plumbing.mjs           sendFrame（两个背压护栏）+ TransportStats
src/readonlyRoutes.mjs     只读 HTTP 接口
integration/               ③④ 帧瘦身 / 快照节奏 / 会话路由（叠加层）
test/                      28 项
docs/FORGE-COMPAT.md       与 Forge 工坊包 / mod 管理器的边界
docs/PULL-VS-PUSH.md       拉模式审计（只审计，未实施）
```

用法：

```js
import { WebSocketServer } from 'ws';
import { resolveWsCompression, createCompressFilter, describeWsCompression } from 'stronghold-ws-compression';
import { createSender, TransportStats } from 'stronghold-ws-compression/plumbing';
import { createReadonlyRouter } from 'stronghold-ws-compression/readonly';

const mode = process.env.WS_COMPRESSION ?? 'off';
const isCompressible = createCompressFilter();
const stats = new TransportStats();

new WebSocketServer({ port: 3000, perMessageDeflate: resolveWsCompression(mode) });

const sender = createSender(socket, { isCompressible, stats });
sender.send(encoded, 'm.public');

const readonly = createReadonlyRouter({
  mode, stats, compressibleTypes: ['m.public', 'm.private'],
  describe: describeWsCompression, sockets: () => wss.clients.size,
});
```

### 三条必须遵守的约束

1. **不要**显式声明 `serverNoContextTakeover: false` 或 `serverMaxWindowBits`。
   `ws` 会把不可接受的协商变成 **HTTP 400 —— 客户端完全连不上**，不是降级。
2. **跳过一帧要在 `ws.send` 之前跳**。上下文保持下，进了 deflate 上下文却没送达的帧会让客户端解压错位，
   之后**整条连接**的帧全坏。`sendFrame` 已按此实现。
3. `threshold` 是**硬开关**：低于它的帧整帧不压（且只在 `safe` 档生效，见《当前已上线》§3.2）。

---

## 二、🔴 工坊包**开不了**传输层压缩（这条决定"兼容"的含义）

Forge 工坊包在服务端的声明只有两种：

| 声明 | 能力 | 时机 |
|---|---|---|
| `server.preDispatch` | 拦**入站 C2S 消息** | 消息到达时 |
| `routes` | 服务包内只读 `.json` | HTTP 请求时 |

而压缩是 `new WebSocketServer({ perMessageDeflate })` 的**启动选项**，作用在建连时的**扩展协商**上 ——
`preDispatch` 拿到消息时，握手早在一个世纪前就完成了。

⇒ **没有任何 `pack.json` 写法能让一个包打开压缩。** 声称能做的包，只会被 Forge 的纪律**整包拒**。

⇒ 所以「兼容」只能是两件事：

1. **读写同一套只读路由约定** —— 逐条抄 `docs/WORKSHOP.md` §1.9.2，别人问「接口有哪些」时有同一份答案；
2. **可共存** —— 装上它不影响运维手动开的压缩。

**分发 ≠ 安装。** mod 管理器负责分发字节；真正启用压缩是运维改环境变量重启服务。这两件事别混为一谈。

---

## 三、兼容包 `ws-compression-reference`

5 个文件，层 **C**、`content: []`、`combat: false`、MIT、**零游戏素材**：

| 文件 | 作用 |
|---|---|
| `pack.json` | 声明（`api: ">=1 <2"`、`routes` + `client.panels` 挂 `root.guide`） |
| `ws-compression.json` | `routes` 声明的只读数据 —— 可核对的事实 |
| `ui/wsCompression.js` | `export function mount(ctx)` 自查面板 |
| `css/ws-compression.css` | 面板样式 |
| `NOTICE-来源说明.md` | 来源与授权 |

**它提供**：档位表的实际内容、两个「故意不声明」的参数、白名单、验收命令 —— 让你能**自查**自己那台服务器
跑的是不是这套配置。
**它不提供**（写进备注的四条）：开/关压缩、改档位、改白名单、读实时协商参数（面板 `ctx` 只有会话态，
**拿不到网络层**）。

### 投递

| 去处 | 状态 |
|---|---|
| mod 站 <http://47.103.14.217:25570/> | v1 `20a46941c219` · v2 `7bf0bd0e56fd`，均 `pending` 待维护者审 |
| [PR #1 → `XiaMo233M/Stronghold-Protocol-Forge-Mods`](https://github.com/XiaMo233M/Stronghold-Protocol-Forge-Mods/pull/1) | `open` / `mergeable=true` / 5 文件 / +407 行 |

> 站点 `UPLOAD.md` 写得很清楚：**已经能装的包不要传到投递口，那种直接提 `packs/`**。
> 这个包过了引擎装载器（`✓ ws-compression-reference 1.0.0 层 C api=>=1 <2`），所以两条路都走了。

---

## 四、写给工坊包作者：格式约定（别重新摸）

- 字段全集就是 `PACK_FIELDS`：**多一个键就被 `PACK_UNKNOWN_FIELD` 整包拒**（不是丢弃）。
- `id` **必须与目录名一致**；`api` 是闸门（当前 `MOD_API_VERSION = 1`，写 `">=1 <2"`）；
  `game` 只是信息、**不比对**。
- **面板契约**：`export function mount(ctx)`，`ctx.host` 是本次挂载专用的 `<div>`，返回 `{ unmount() }` 可选。
  9 个闭枚举槽位里 `root.guide` 是「说明层之上、浮层之下」。
- **`routes`**：只 `GET` / `HEAD`（其余 `405 Allow: GET, HEAD`）、**精确匹配**、**只服务包内 `.json`**
  （`.js` / `.html` 一律拒），`cache` 三选 `no-cache`（缺省）/ `no-store` / `public`。
- **素材红线**：不许夹带任何游戏素材；自制的要逐条写来源与授权。
- 验包：`node tools/check-packs.mjs --engine <引擎目录> --root packs` —— **用引擎自己的装载器**，
  规则抄一份就会漂。

---

## 五、独立库在服务器里的落地

`stronghold-server` 已把三个源文件**逐字节** vendored 进 `server/ws-compression/`
（`git hash-object` 逐个比对一致，附 MIT LICENSE + `SOURCE.md` 记上游 commit）。

`server/wsCompression.js` 退化成一个 **adapter**：

- env 名 `WS_COMPRESSION` / `WS_COMPRESS_EXTRA` 优先，**保留**旧名 `SP_WS_COMPRESSION` /
  `SP_WS_COMPRESS_EXTRA` 作别名（**已上线的部署不用改**）；
- 报错**不回显配置值**（配错时日志里不会漏出那是哪一行配的）；
- 暴露进程级 `TransportStats` 单例 + 只读路由工厂；
- 白名单收敛为 6 类基础集（fork 自己的 `m.damage` 随伤害板下线一起去掉了）+ `b.start` 额外集。

测试：`test/ws-compression.test.js` **26/26**，加上库自带的 3 个测试文件共 **28/28**。
