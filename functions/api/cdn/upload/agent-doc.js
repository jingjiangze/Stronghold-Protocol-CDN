// GET /api/cdn/upload/agent-doc —— 把「接入说明」连同密钥一起交给调用方。
//
// 为什么由边缘拼、而不是页面自己拼：文档里那句 `x-admin-key: <直连后台密钥>` 必须换成真钥匙，
// 而这把钥匙本来就已经在这个请求里（口令就是它）。页面拼也能做，但那样同一件事有两份实现，
// 而「复制出来的说明少了钥匙」是一种**静默**失败 —— 粘出来的文本看起来完全正常，
// 直到调用方发出一个空 x-admin-key 才失败，而那时的报错不会提到复制不完整。
//
// 路径不写死：读部署时生成的 /data/docs.json，取「所有文档里提到上传通道的最新一份」。
// 这样换文档名、新写一份接入说明都不需要改代码。
//
// 只读、无副作用；返回体带密钥，所以是 no-store，且和别的后台端点一样只接受同源调用。
import { injectAdminKey, pickAgentDoc } from '../../../../src/docs-index.mjs';
import { checkAuth, deny, json, sameOriginOrNone } from './_http.js';

const DOCS_INDEX = '/data/docs.json';

/**
 * 读本部署里的一个静态文件。
 *
 * `env.ASSETS` 是 Pages 给 Functions 的静态资源绑定；个别部署形态下拿不到，所以退回按自己的
 * 地址取一次（同源、同一次部署）。两条路读到的都是**这次部署的**文件，不会读到上一次的缓存。
 */
async function readAsset(env, request, pathname) {
  const url = new URL(pathname, request.url).toString();
  if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    return env.ASSETS.fetch(new Request(url, { headers: { accept: '*/*' } }));
  }
  return fetch(url, { headers: { accept: '*/*' }, cf: { cacheTtl: 0 } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const originProblem = sameOriginOrNone(request);
  if (originProblem) return deny(originProblem, 403);
  const authProblem = checkAuth(request, env);
  if (authProblem) return deny(authProblem, 401);

  let index;
  try {
    const res = await readAsset(env, request, DOCS_INDEX);
    if (!res.ok) {
      return deny(
        `读不到文档索引 ${DOCS_INDEX}（HTTP ${res.status}）—— 它由 src/site-data.mjs 在这次部署时生成`,
        502,
      );
    }
    index = await res.json();
  } catch (error) {
    return deny(`读文档索引失败：${error.message}`, 502);
  }

  // The index already decided; recomputing from its list means a hand-edited or older index still
  // answers, and it keeps the rule in one place.
  const picked = index.agentDoc
    ? { path: index.agentDoc, why: index.agentDocWhy || '' }
    : pickAgentDoc(index.docs);
  if (!picked.path) return deny('文档索引里没有任何文档', 404);

  let text;
  try {
    const res = await readAsset(env, request, `/${picked.path}`);
    if (!res.ok) return deny(`文档 ${picked.path} 读不到（HTTP ${res.status}）`, 502);
    text = await res.text();
  } catch (error) {
    return deny(`读文档失败：${error.message}`, 502);
  }

  // 口令已经过 checkAuth，用它就是「本次调用方拿到的那把」——不额外查任何存储。
  const injected = injectAdminKey(text, request.headers.get('x-admin-key') || '');

  return json({
    ok: true,
    path: picked.path,
    why: picked.why,
    injected: injected.injected,
    docsIndexGeneratedAt: index.generatedAt || null,
    text: injected.text,
  });
}

export function onRequestOptions() {
  return deny('这个端点不接受跨源调用', 405);
}
