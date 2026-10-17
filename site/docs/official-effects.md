# 官方战斗特效（本地抽取素材）

> 这一页说明本站托管的那批**官方战斗特效**文件是什么、怎么组织、以及客户端靠哪份清单把它们认出来。
> 它们来自游戏客户端的解包抽取，不是本仓库的代码资产；版权归原权利方所有，仅供非商业同人使用。

## 目录与体量

全部位于 `assets/local/fx/`：

| 子目录 | 内容 | 文件数 | 体积 |
|---|---|---|---|
| `prefabs/` | 特效预制体（每个文件描述一套粒子/网格的组合） | 4,518 | 118.1 MiB |
| `tex/` | 贴图（WebP，完整尺寸） | 3,388 | 33.9 MiB |
| `tex/half/` | 同上的半分辨率副本（低配/触屏用） | 3,347 | 14.7 MiB |
| `mesh/` | 网格（技能弹道、技能范围等用的几何） | 1,279 | 10.8 MiB |
| `index.json` | 抽取器产出的**总索引**：单位 / 弹道 → 哪个 prefab | 1 | 6.5 MiB |
| `textures.json` | 每张贴图的尺寸与格式（`w` / `h` / `format` / `wrap` / `filter`） | 1 | 870 KiB |

合计约 **9,200 个文件 / 184 MiB**，全部已进 `cdn/v1/tree.json`（`totals.files` 41,945 里的 `assets/local/fx/**` 部分）。

## 清单文件（`local-fx.json`）

客户端不直接扫目录，它只读一份清单位于 `/data/local-fx.json`，形状是：

```json
{
  "groups": {
    "fx":         { "index": {"path": "/assets/local/fx/index.json"},
                    "textures": {"path": "/assets/local/fx/textures.json"} },
    "fx/prefabs": { "<小写键>": { "path": "/assets/local/fx/prefabs/<file>.json", "size": 1234 } },
    "fx/tex":     { "<贴图键>": { "path": "/assets/local/fx/tex/<file>.webp", "w": 256, "h": 256, "format": "DXT5" } },
    "fx/mesh":    { "<网格键>": { "path": "/assets/local/fx/mesh/<file>.json" } }
  }
}
```

要点：

- **键必须小写**。客户端 `has(key)` 会先 `String(key).toLowerCase()` 再查表，键大写等于查不到。
- `fx/tex` 的条目**必须带 `w`/`h`**，贴图打包与 atlas 计算要用；尺寸可从 `textures.json` 直接取（本站在生成清单时就是这么做的）。
- 只要 `groups['fx/prefabs']` 非空，客户端的 `fxAvailable()` 就返回 true，设置里的「官方特效」开关才会出现。

本目录下的 `local-fx.json` 是**这一批素材对应的正式清单**，可直接下载后放到任意部署的 `/data/local-fx.json`：

```
https://speedcdn.jiangjiangze.icu/assets/local/fx/local-fx.json
```

## 客户端如何消费

- `public/js/render/vfx/available.js` —— 拉清单、判断 `available`；
- `render/vfx/library.js` —— 按 `groups[组][键].path` 取 prefab / 贴图 / 网格；
- `render/vfx/tier.js` —— `resolveOfficialFx(设置值, available)`，`available === false` 时整层为 `off`。

**降级行为**：清单缺失、某个 prefab 或贴图 404、浏览器没有 WebGL2，都会退回**程序化特效**（`public/js/render/fx/` 那套运行时画的图元），战斗不受影响。所以「没有官方特效」不是故障，是这一层关闭。

## 生成方式（复现用）

上游仓库不发布这份清单（抽取器在本地客户端上跑）。本站的做法是：

1. 从 `assets/local/fx/prefabs|tex|mesh` 的文件清单建立各组条目（键 = 文件名去扩展名并小写）；
2. 从 `textures.json` 取每张贴图的 `w`/`h`/`format`；
3. 拼成上面的 `groups` 结构，写成 `data/local-fx.json`。

没有本地客户端时，这是唯一可行路径 —— 尺寸信息不需要下载图片本体，`textures.json` 里已经带了。

## 与其它素材层的关系

| 层 | 路径 | 说明 |
|---|---|---|
| 上游素材树 | `assets/**` | 官方包内容，逐文件镜像 |
| 官方特效 | `assets/local/fx/**` | 本类，客户端解包抽取，**不在**上游包里 |
| 皮肤素材 | `assets/skins/**` | 逐套头像/立绘/半身像/前后 Spine |
| 动画/音效 | `assets/spine/**`、`assets/audio/**` | 上游包内容 |

特效与皮肤是两套独立系统：皮肤换的是单位模型，特效是技能/攻击/受击的粒子与网格，互不影响。
