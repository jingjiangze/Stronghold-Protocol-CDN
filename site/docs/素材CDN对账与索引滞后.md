# 素材 CDN 对账：索引滞后、tree.json 漏目录、HEAD 实测反查（2026-10-10）

> 续《上行带宽最大化压缩》的「措施 1 · `SP_ASSET_CDN`」。那篇只说「把清单里的 `/assets/…`、`/fonts/…`
> 改写成 CDN 绝对地址、盒子出口砍掉 462.6 MiB/人」。本篇记**上线后对账**发现的坑：
> 桶里实际有的，比清单索引登记的**多**——按清单会少卸 178 MiB。
> 日期：2026-10-10 · 全部数字来自生产响应头与逐对象 `HEAD` 实测，不是估算。

---

## 一、结论先行

- **线上改写已生效**：生产服务端响应头 `X-Asset-CDN: 22103cdn/1872local`。
  即 22,103 条素材改写走 CDN、1,872 条（313.8 MiB）仍留本机上行 —— **可走 CDN 占比 86.8%**。
- **但「留本机 1,872 条」是误判**：对这 1,872 个逐一带 `HEAD` 实测，**1,294 个（178 MiB）CDN 上其实是 200**，
  纯因清单/索引滞后被当成缺失。用 `HEAD` 实测当权威，能**再多卸 1,294 个素材（178 MiB）**。
- **spine 安全**：1,159 个 spine 目录，**0 个混用**（整目录一致地在 CDN 或整目录在本地）。
  所以按**单文件**改写是安全的——atlas 按相对路径找同目录 png 不会断。
- **最终方案**：索引（`index.json`）+ `HEAD` 实测 + 持久缓存 + 后台核对（backfill）；
  判定以 `HEAD` 实测为权威，后台核对异步收敛到真值。

---

## 二、对账过程

| 阶段 | 计数 | 说明 |
|---|---|---|
| 改写上线初值 | `22103cdn / 1872local` | `X-Asset-CDN` 头实测，JSON 结构不变 |
| 1,872 个「留本机」里 `HEAD` 实测 | **1,294 在 CDN**（178 MiB） | 索引滞后造成的假缺失 |
| 剩真·本机 | 578 个 / ~135.8 MiB | 才是真的 CDN 没有 |
| 预期收敛 | `~23397cdn / 578local` | 后台 1,872 个 HEAD 跑完后 |

抽样 CDN URL 实测 `200` + `Access-Control-Allow-Origin: *` 通过。

---

## 三、关键发现：清单不是真源

原方案把 `index.json` / `tree.json` 当「CDN 上有哪些文件」的权威，实测推翻：

1. **`index.json` 滞后**：桶里有些文件索引未登记（上传晚于索引生成）。
   →「`index.json` 是唯一真源」这句话**不实**，桶实况才是真源。
2. **`tree.json` 漏目录**：它列了文件却漏了目录；这些目录下的文件在 CDN 上其实是 `200`。
   → 用 `tree.json` 的目录清单判断会漏掉整批文件。
3. **`HEAD` 实测反查**：对「缺失」列表逐一带 `HEAD` 实测，才发现大量文件已在 CDN。

**处置**：以**桶实况（`HEAD` 实测）为准**，弃用 `index.json` / `tree.json` 作为「有没有」的判断依据。

---

## 四、风险排查：spine atlas 相对路径

spine 的 `atlas` 按相对路径找同目录 `png`。若「同一 spine 目录里部分文件走 CDN、部分留本机」会渲染失败。
排查结果：**1,159 个 spine 目录，0 个混用**（整目录一致地在 CDN 或整目录在本地）。

→ 按**单文件**改写是安全的，不必强求整目录一致。

---

## 五、最终实施方案（已部署生产）

服务端改写最终版（生产 PID 96676）：

1. **真源顺序**：索引（`index.json`）+ `HEAD` 实测 + 持久缓存 + **后台核对（backfill）**。
2. **判定逻辑**：以 `HEAD` 实测为权威；索引滞后的文件经实测在 CDN 即改写，不在才留本机。
3. **缓存**：改写结果与 HEAD 判定做持久缓存，避免每次请求都打 `HEAD`；
   后台核对异步回填，逐步收敛到真值。
4. **分流头**：响应 `X-Asset-CDN: <cdn 条数>cdn/<local 条数>local`，便于线上验收。

> ⚠️ **HEAD-reconcile 版 `static.js` 尚未提交回 `master-play`**：它只在远程盒子
> `D:\stronghold\sp_current\server\http\static.js` 跑。`_sp-wt` 与 `C:\DDDD\game\servers` 仍是旧的
> 「三清单路径改写 + `/assets`、`/fonts` 302」版本（commit `05d57654`）。下次盒子自动更新
> （`sp_update_zip.ps1`）会覆盖掉这套改写——代码回仓前应保留 `update\PAUSE_AUTOUPDATE`，并尽快把改动合回主线。
> 客户端拿清单的两个入口：`data/assets.json`（主清单，改写 `/assets|fonts/` 绝对 URL，随 ETag 缓存）与
> `data/local-assets.json`（本地客户端美术覆盖，同上）；`emotes.json` 同机制。

---

## 六、验收（三条命令）

```bash
# 1. 改写是否生效（应见 X-Asset-CDN 头，且 cdn 条数远大于 local）
curl -sI https://weishu.jiangjiangze.icu/data/assets.json | grep -i "x-asset-cdn"

# 2. 清单条目是否都指向 CDN（应几乎 100% 命中）
curl -s https://weishu.jiangjiangze.icu/data/assets.json \
  | grep -o '"https://[^"]*weishucdn[^"]*"' | wc -l

# 3. 单文件 HEAD 实测（挑一个"疑似缺失"的，应 200）
curl -sI https://weishucdn.jiangjiangze.icu/assets/char/avatar/char_002_amiya.png \
  | grep -i "^HTTP"
```

---

## 七、状态词小结

- `BASELINE`：CDN 侦察（CORS `*`）、改写上线、入口确认、目录一致性（0 混用）。
- `IMPLEMENTED`：服务端改写（生产 PID 96676）；索引 + HEAD + 缓存 + 后台核对方案已部署。
- `PASS`：改写验证（结构不变、抽样 CDN 200 + CORS、`X-Asset-CDN` 头生效）。
- `PENDING`：代码入仓、ASSETS.md 同步、后台核对最终计数确认。
