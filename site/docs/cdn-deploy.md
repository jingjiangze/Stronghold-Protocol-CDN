# CDN 部署文档

> 非官方同人作品，仅供学习交流。素材版权归 Hypergryph / Yostar 所有。

这个 CDN 不存素材字节的「原稿」——它把上游 `sganggs/Stronghold-Protocol` 的 Release 整包解出的同一批静态文件，镜像到多个边缘源（R2 私有桶 + 自有域、Cloudflare Pages、以及从本仓库 git 挂载的镜像），并对外发布接口文件（`mirrors.json` / `pick.js` / `index.json`）。本页记仓库结构、自动同步链路、ModelScope 创空间镜像与验收。全部来自仓库源码与线上实测（2026-10-11）。

## 一、结论先行

玩家客户端取素材的唯一来源是清单（`data/assets.json`、`local-assets.json`、`emotes.json`），清单里的 URL 指向主源；客户端 / 站点再按设备自身链路用 `pick.js` 测速，选最快的那个，把基址整体换掉——换源只改一次清单，不动客户端代码。本 CDN 就是这套清单与多源背后的基础设施。

- 这是一个**静态镜像体系，不是服务端**：它分发上游 Release 包里的同一批静态文件，逐文件校验，不做任何转码。游戏 WebSocket / 页面不在这里，它们在另一个仓库（`Stronghold-Protocol` 服务端，部署在 ModelScope 创空间）。本页只写「素材 CDN 怎么部署」。

## 二、整体拓扑

写入端（我们只写的）：

- **R2 私有桶** `stronghold-assets`：对外域名 `weishucdn.jiangjiangze.icu`（主），第二个域名 `weishucdn2.jiangjiangze.icu`（同桶）。
- **Cloudflare Pages**：项目 `stronghold-cdn-site`，第二个 origin，上传目录是 `site/`。
- **ModelScope 创空间镜像**：一个 git 镜像（不是运行时源），见第五节。

读取端（玩家 / 客户端用的）：

- **接口只有一个域名**：`weishucdn.jiangjiangze.icu`。其它主机名是素材镜像，没有 `/cdn/v1/` 接口文件。
- **素材多源**：R2 主源 + Pages + 从本仓库 git 挂载的源（jsDelivr / ghfast / 自有中继）。客户端按设备挑最快。
- **文档站**：`downcdn.jiangjiangze.icu`（Cloudflare Pages），就是当前这个页面。

```sh
# 接口一律从这个域名取
curl "https://weishucdn.jiangjiangze.icu/cdn/v1/mirrors.json"
curl "https://weishucdn.jiangjiangze.icu/cdn/v1/pick.js"

# 素材再从各镜像里挑最快的（下载页已按实测自动选）
curl "https://weishucdn.jiangjiangze.icu/assets/spine/op/char_1016_agoat2/front/char_1016_agoat2.skel"
```

## 三、仓库结构

仓库：`jingjiangze/Stronghold-Protocol-CDN`

| 路径 | 作用 | 是否随部署发布 |
|---|---|---|
| `site/` | 文档站（本页所在）。`site.yml` 上传的就是这个目录。 | 是（Pages） |
| `src/sync.mjs` | 主同步脚本：解上游包 → 哈希校验 → 上传 R2 → 发布接口文件。 | 否（构建期跑） |
| `tools/push-modelscope.mjs` | 把素材树推成 ModelScope 创空间的 git 镜像。 | 否 |
| `origins.json` | 附加只读镜像（`extraOrigins` / `gitOrigins`）。只加数据，不碰代码。 | 否（被 sync 读取） |
| `mirrors.json` | GitHub Release 下载镜像前缀（打包通道用）。 | 否 |
| `network.json` | 三运营商到各源的实测（决策证据，非运行时配置）。 | 否 |
| `hosted.json` | 本仓刻意托管的第三方 mod 素材登记。 | 否（登记进 git） |
| `assets-raw` | **孤儿分支**：618 MiB 素材树，2026-10-09 提交，专供 git 挂载源。 | 否（git 挂载） |

- `assets-raw` 是关键：素材树进 git 之前，git 挂载源只能给出本仓几十 KB 工具文件、请求素材 404（那时它们被标 `coverage:"partial"`）。现在素材树在 `assets-raw` 分支，各源都能给全部素材；唯一例外是 `docs/`（官方文档只发布到 R2 / Pages，不在本仓）。

## 四、自动同步链路

`sync.yml` 是主同步工作流：定时（`17 */6` 五分一次）或手动触发。它把上游 Release 完整包镜像到 R2 并发布接口文件，便宜时无变化时几秒退出（读上次发布的接口，比对 tag 与校验）。

`workflow_dispatch` 输入：

| 输入 | 含义 |
|---|---|
| `tag` | 要镜像的上游 tag（空 = 最新 Release） |
| `write` | true = 把差异上传到 R2 并发布接口文件 |
| `pages` | true = 也把扁平树部署到 Cloudflare Pages（第二 origin） |
| `packs` | true = 也构建 zip 打包通道、发布到 R2 并附到 GitHub Release |
| `sources` | true = 也镜像 sources.json 里的附加源（叠加） |
| `interface_only` | true = 只重发 mirrors.json + pick.js（秒级，改过发布产物后用它重发） |
| `force` | true = 忽略水位线（改代码后重发 Pages 要用） |

- 改完 CDN 发布产物要重发：只改了 `site/` 以外、随 R2 发布的东西（接口 / tree / 包），跑一次 `sync.yml` 带 `interface_only=true` 即可，不要从本机直接写 R2，也不要跑 pages deploy——本机没有 R2 凭据，且会把分支上所有发布产物一并带上。

## 五、ModelScope 创空间镜像（git 挂载）

`mirror-modelscope.yml` 把素材快照推到 ModelScope 创空间，每天四次。它**不是运行时源**——创空间不提供原始文件 URL（任何路径都返回 ~8.6 KB 的 SPA HTML），所以这个镜像是 **git 镜像**：让素材树能被 git 挂载型 CDN 克隆 / 挂载，而不是让浏览器直接取字节。

| 项 | 值 |
|---|---|
| 源仓库 | 本仓库的 `assets-raw` 孤儿分支（618 MiB 素材树） |
| 目标 | `jingjiangze/Stronghold-Protocol-Assets`（ModelScope 数据集） |
| 排除 | 默认排除 `assets/skins/**`（除非上游集合完整，手动带 `include_skins`） |
| 凭据 | `MODELSCOPE_URL`（仓库 secret，内嵌 token 的 git 远程） |
| 幂等 | 比对树哈希与 `assets.summary.json`，相同则不推 |

- 这与游戏服是两套东西：游戏服（`Stronghold-Protocol`）部署在 ModelScope **创空间**（Docker 容器，跑服务端）；这里的 `mirror-modelscope.yml` 是把素材树推到 ModelScope **数据集**做 git 挂载镜像。两者都在 modelscope.cn，但一个是容器、一个是 git 仓库，不要混。

## 六、部署触发（谁来做）

所有写操作（R2 上传、Pages 部署、ModelScope 推送）都在 GitHub Actions 里用仓库 secret 完成，本机没有这些凭据，也不应该把 token 落到本机。本地只做「写文件 + 提交 + 推 GitHub」。

| 动作 | 怎么触发 | 需要的 secret |
|---|---|---|
| 文档站上线（本页） | push `site/**` → `site.yml` 自动跑（或手动 dispatch） | `CLOUDFLARE_API_TOKEN` / `ACCOUNT_ID` |
| 素材同步到 R2 | `sync.yml` 定时 / 手动（带 write） | `R2_*` 系列 |
| 素材推 ModelScope | `mirror-modelscope.yml` 定时 / 手动 | `MODELSCOPE_URL` |
| 游戏服重新部署 | 推到创空间 git 远程后，在控制台点「重新部署」 | ModelScope Access Token |

- push ≠ 部署（两处都成立）：推 GitHub 只是把代码落地；文档站要 `site.yml` 跑完才上线，游戏服要控制台点「重新部署」才重 build。改完记得确认对应的工作流跑绿。

## 七、验收

```sh
# 1. 文档站（本页）已部署：应 200，且标题是 CDN 部署文档
curl -fsS https://downcdn.jiangjiangze.icu/cdn-deploy | grep -o '<title>[^<]*</title>'

# 2. 接口清单里有 pick.js 与 mirrors.json
curl -s https://weishucdn.jiangjiangze.icu/cdn/v1/api.json | grep -oE '"/cdn/v1/(pick\.js|mirrors\.json)"'

# 3. 某素材在 R2 主源 200（首字节时间）
curl -sI https://weishucdn.jiangjiangze.icu/assets/char/avatar/char_1016_agoat2.png | grep -iE 'HTTP/|content-length'

# 4. git 挂载源（assets-raw 分支）也能给同一文件（任选其一）
curl -sI https://cdn.jsdelivr.net/gh/jingjiangze/Stronghold-Protocol-CDN@assets-raw/assets/char/avatar/char_1016_agoat2.png | grep -iE 'HTTP/|content-length'

# 5. 镜像树与 R2 逐字节一致（抽样 sha256）
node -e 'fetch("https://weishucdn.jiangjiangze.icu/cdn/v1/index.json").then(r=>r.json()).then(j=>console.log(j["assets/char/avatar/char_1016_agoat2.png"]))'
```

## 状态词

- `BASELINE`：当前线上 = R2 主源 `weishucdn.jiangjiangze.icu` + Pages 第二 origin + 从 `assets-raw` 挂载的 git 源；文档站 `downcdn.jiangjiangze.icu`。
- `IMPLEMENTED`：本页与 `cdn-deploy.md` 已写入 `stronghold-cdn` 仓库 `site/` 与 `site/docs/`。
- `PENDING`：推 GitHub 触发 `site.yml` 上线——需本机有 GitHub 写权限（当前 shell token 失效、无可用 SSH key），在 CI 跑或刷新 `gh auth` 后执行。
- `FAIL`：当前未跑部署验证（凭据不在本机）；上述验收命令需部署后执行。
