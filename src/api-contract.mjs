// The API contract, as a published document.
//
// The endpoints were described in prose on the site and in this repository's README, in three
// places that could drift from each other and from what the sync actually writes. A consumer (or an
// agent) then has to read all three and hope. This is the one machine-readable description, served
// from the same origin as the endpoints themselves, so "what can I fetch" has a single answer.
//
// The table is authored rather than derived, because it is the contract: deriving it from whatever
// the sync happens to upload would make it a description of the implementation instead of a promise
// to callers. A test asserts the two agree, which is what keeps an authored table honest.
export const API_SCHEMA = 2;

/** Endpoints of the interface, in the order they are worth reading. */
export const API_ENDPOINTS = [
  {
    path: '/cdn/v1/art.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '契约：上游版本、缓存令牌、来源列表、包列表、校验结果；art.overrides = 本站有意发非上游字节的路径（含双方尺寸与提供它的源）',
  },
  {
    path: '/cdn/v1/mirrors.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '聚合清单：全部来源与预载通道（含各源前缀 URL）',
  },
  {
    path: '/cdn/v1/index.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '全量键表 { size, sha256 }，用于逐文件校验或做二级镜像',
  },
  {
    path: '/cdn/v1/index-<token>.json',
    contentType: 'application/json',
    cache: 'public, max-age=31536000, immutable',
    what: '同上，按内容令牌冻结的副本；令牌变了 URL 就变',
  },
  {
    path: '/cdn/v1/tree.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '目录树：dirs[<目录>].files = [[名, 体积, 是否托管?], …]，不放 sha256',
  },
  {
    path: '/cdn/v1/tree-<token>.json',
    contentType: 'application/json',
    cache: 'public, max-age=31536000, immutable',
    what: '同上，按内容令牌冻结的副本',
  },
  {
    path: '/cdn/v1/network.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '内地三运营商到各源的实测时延（决策证据，不是运行时配置）',
  },
  {
    path: '/cdn/v1/pick.js',
    contentType: 'text/javascript',
    cache: 'public, max-age=300',
    what: '零依赖 ES 模块：pickFastest() 测速并返回最快来源；rebaseManifest() 改一次清单换源',
  },
  {
    path: '/cdn/v1/probe.bin',
    contentType: 'application/octet-stream',
    cache: 'public, max-age=31536000, immutable',
    what: '256 KiB 不可压缩测速探针；每个源都有一份',
  },
  {
    path: '/cdn/v1/api.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '本文件：接口清单（路径 / 类型 / 缓存 / 用途）',
  },
  {
    path: '/data/<manifest>.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '上游三张清单（assets / local-assets / emotes），素材地址已改写为绝对 CDN 地址并带 ?v= 令牌',
  },
  {
    path: '/assets/**',
    contentType: '按扩展名',
    cache: '带 ?v= 令牌 1 年 / 裸路径 1 小时',
    what: '素材本体。键 = 上游 public/assets/** 去掉 public/。支持 GET / HEAD / Range',
  },
  {
    path: '/fonts/**',
    contentType: '按扩展名',
    cache: '带 ?v= 令牌 1 年 / 裸路径 1 小时',
    what: '字体本体（woff2 为主）。与 /assets/** 同构：键 = 上游 public/fonts/** 去掉 public/',
  },
  {
    path: '/packs/assets-<tag>/<id>.zip',
    contentType: 'application/zip',
    cache: 'public, max-age=31536000, immutable',
    what: '预载通道：同一批字节按目录打成 ~96 MB 的包，预载或安装期用',
  },
  {
    path: '/dl/<tag>/<file>',
    contentType: '—',
    cache: 'public, max-age=3600',
    what: 'Release 资产的自有域短链，302 到镜像（不代理，避免用请求配额换字节）',
  },
  {
    path: '/cdn/v1/hosted-index.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '托管对象补摘要：后台上线的每一组键的 { size, sha256 }（上游清单里没有的那些，mod 素材与包存档都在这）。做二级镜像或逐文件校验的，把这份与 /cdn/v1/index.json 合起来才是全集',
  },
  {
    path: '/cdn/v1/upload-log.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '上传后台的上线记录（谁传的、何时、组 id、字节、下线留痕 removedAt）——「这个键为什么在这里」的唯一答案',
  },
  {
    path: '/packs/mod-assets/index.json',
    contentType: 'application/json',
    cache: 'public, max-age=3600',
    what: 'mod 素材权威键索引：sha256 → 唯一 canonical 键（含 size / 来源 / aliases）。上传前先在这里按哈希查一次，命中就指现有键，别再传第二份；aliases 是历史同字节副本，暂时保留但新包不许指',
  },
  {
    path: '/packs/mod-assets/README.txt',
    contentType: 'text/plain; charset=utf-8',
    cache: 'public, max-age=3600',
    what: '给 mod 作者的说明书（同文源码在本仓 docs/MOD-AUTHORS.md）：路径规则与 ?v= 令牌、唯一能吃绝对 URL 的两个字段、指不过去的字段与行号、上传通道、高清与去重政策、交付闸门。用 .txt 是因为 .md 不在上传白名单里',
  },
  {
    path: '/packs/<自定义组>/<文件>',
    contentType: '按扩展名',
    cache: 'public, max-age=31536000, immutable',
    what:
      'mod 作者的命名空间：上传后台（/admin 或 tools/agent-upload.mjs）上线的任意对象——工坊包存档、外部素材、清单都放这里。' +
      '键只允许 assets/ fonts/ packs/ 三个前缀、扩展名走白名单（png jpg webp atlas skel json txt mp3 ogg wav m4a woff woff2 ttf otf zip bin data xml），' +
      '上线即带 immutable 与 sha256 元数据，逐键摘要见 /cdn/v1/hosted-index.json。' +
      '**mod 能用绝对 URL 指过来的只有两处**：pack.json 的 voices / voiceLangs 条目 {url, sha256, file}（仅音频、必须 https、服务端装载时取字节、单条 ≤24 MiB），' +
      '以及 assets.mirrors[]（base 必须绝对 https 且以 / 结尾、sha256 必须等于本包容器实算摘要，客户端取 <base><容器文件名>）。' +
      'art / skins[].art / bondIcons / itemIcons / forms / i18n / notices / routes 与一切 Spine 都只接受包内相对路径、一律被改写成 /workshop-assets/<包id>/…，指向外部主机就是 404 —— 素材必须内嵌在包里。写法与实测依据见本仓 docs/INTEGRATION.md 第 6 节',
  },
];

/**
 * The published document. `base` and `token` are stamped in so a consumer that saves this file can
 * still tell which tree it describes.
 */
export function buildApiDoc({ base, token }) {
  const root = String(base || '').replace(/\/+$/, '');
  return `${JSON.stringify(
    {
      schema: API_SCHEMA,
      _how:
        '接口只有一个域名，就是这个文件的 base。其它主机名（见 /cdn/v1/mirrors.json）是素材镜像，' +
        '只镜像素材树、没有 /cdn/v1/ 这套接口文件（实测：Pages 源对接口路径 404、git 源 502）。' +
        '接口一律从 base 取；素材再按 mirrors.json + pick.js 挑最快的那个。',
      base: root,
      token,
      endpoints: API_ENDPOINTS.map((e) => ({ ...e, url: `${root}${e.path}` })),
    },
    null,
    2,
  )}\n`;
}
