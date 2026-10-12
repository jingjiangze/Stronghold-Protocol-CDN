import io, sys

p = r"C:\DDDD\Agent Work\stronghold-cdn\_main-fix\site\docs\bandwidth-max-compression.md"
lines = io.open(p, encoding="utf-8").read().split("\n")

# locate section 9 start and section 10 start (0-based)
start = next(i for i, l in enumerate(lines) if l.startswith("## 九、"))
end = next(i for i, l in enumerate(lines) if l.startswith("## 十、"))

new = """## 九、稳态口径：本节点名的旧数字全部作废（2026-10-12）

> ⛔ **本节不再承载 WS 稳态容量。** 它原先写的「98% 是 `m.public`」「2,048 → 505 B/s」「610 → 2,475 人」
> 已于 2026-10-12 被整局实测推翻，相关正文已从本文件移除，以免被当成事实继续引用。
> **现行口径只有一份**，见 [`ws-link-compression.md`](./ws-link-compression.md)。

### 为什么那组数字不能用

1. **样本本身是残缺的**：那次测量跑在**机器人座位**上。`messaging.js` 的 `sendTo()` 首行就
   `if (!ps || ps.isBot || ps.left) return false` —— 机器人收不到任何单播，所以 `m.private` 与
   `b.start` **根本不在样本里**。「98% 是 `m.public`」是在一个只剩 `m.public` 的集合里算出来的百分比。
2. **那套参数线上没在跑**：对公网 WS 做真实 Upgrade 握手，服务端回的是
   `permessage-deflate; client_no_context_takeover` —— 既没有 `server_no_context_takeover`、
   也没有 `server_max_window_bits=12`。所以「阈值 512 / 关上下文接管 / 窗口 pin 12」是旧配置，
   不是今天的线上配置。

### 现行数字（整局逐字节实测，人类座位 + AI 托管）

| | 值 |
|---|---|
| 每席位稳态 | **57.5 B/s**（压 `b.start` 前 105 B/s，A/B 实测 125.3 → 57.5 B/s，−54.1%） |
| 10 Mbps 容纳 | **≈21,000 人**（留 20% 余量约 17,000） |
| 构成 | `b.start` **69%** / `m.private` 22% / `m.public` **只剩 3%** |
| 真瓶颈 | **冷启动 5.4 MB** 客户端代码 = **1,573 B/s**，比稳态贵 **27×** |

省带宽的优先级因此重排为：① 把客户端静态交给 CDN（现在盒子自己发、CF 实测 `MISS`）
→ ② `b.start` 进白名单（已做）→ ③ 隐藏标签页停推 → ④ 才轮到改拉模式。

### 继续读哪一份

- 今天在跑的配置（三档 `off/on/safe`、两个「故意不声明」的参数、白名单 + `b.start`、广播漏压的真 bug）：
  [`ws-link-compression.md`](./ws-link-compression.md)
- 待执行的三步与各自的准入条件、验收判据、退路：
  [`ws-link-compression-next.md`](./ws-link-compression-next.md)
- 零依赖库与工坊兼容包（MIT · 28 项测试）：[`ws-compression-library-and-pack.md`](./ws-compression-library-and-pack.md)
"""

lines[start:end] = new.split("\n")
io.open(p, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
print("replaced lines %d..%d" % (start + 1, end))
