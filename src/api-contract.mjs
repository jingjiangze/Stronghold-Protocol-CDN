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
export const API_SCHEMA = 1;

/** Endpoints of the interface, in the order they are worth reading. */
export const API_ENDPOINTS = [
  {
    path: '/cdn/v1/art.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '契约：上游版本、缓存令牌、来源列表、包列表、校验结果',
  },
  {
    path: '/cdn/v1/mirrors.json',
    contentType: 'application/json',
    cache: 'public, max-age=300',
    what: '聚合清单：全部来源与打包通道（含各源前缀 URL）',
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
    what: '打包通道：同一批字节按目录打成 ~96 MB 的包，安装期用',
  },
  {
    path: '/dl/<tag>/<file>',
    contentType: '—',
    cache: 'public, max-age=3600',
    what: 'Release 资产的自有域短链，302 到镜像（不代理，避免用请求配额换字节）',
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
