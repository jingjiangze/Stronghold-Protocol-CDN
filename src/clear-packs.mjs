// 一次性：清空 R2 上的 packs/ 前缀（2026-10-14 用户指令「打包通道确保是只有 github 镜像，r2 和其他镜像不存」）。
//
// 为什么不是复用 prune-packs.mjs：它按「最新一档 + 被引用者永远保留」的语义工作，而那两条例外正是
// 本次要删掉的东西 —— 用户要的是 packs 通道整体从 R2 消失，不是继续保留一档最新包。两者的成功判据
// 相反，所以写在这里而不是给 prune 加个 flag。
//
//   node src/clear-packs.mjs          干跑：只列清单，不删
//   node src/clear-packs.mjs --apply  真删（不可逆）
//
// 三道闸，缺一不可：
//   1. 只碰 packs/assets-<tag>/ 这一种形状（与 prune-packs 同一道 PACKS_RE）；
//   2. 干跑与实删走同一个 plan，实删时逐个键再过一次 PACKS_RE 才 delete；
//   3. 没有环境变量时不猜凭据 —— r2Config 拿不到就退出，不往默认桶写。
import fs from 'node:fs';
import path from 'node:path';
import { r2Config, listKeys, deleteObject } from './r2.mjs';

const PACKS_RE = /^packs\/assets-([^/]+)\/(.+)$/;

async function main() {
  const apply = process.argv.includes('--apply');
  const config = r2Config(process.env);
  if (!config?.bucket) {
    console.error('R2 凭据不完整（需要 R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET），退出。');
    process.exit(2);
  }

  const rows = (await listKeys(config, 'packs/')).filter((r) => PACKS_RE.test(r.key));
  const other = (await listKeys(config, 'packs/')).filter((r) => !PACKS_RE.test(r.key));
  const bytes = rows.reduce((a, r) => a + (r.size || 0), 0);
  const tags = [...new Set(rows.map((r) => PACKS_RE.exec(r.key)[1]))];

  console.log(`packs/assets-* 对象：${rows.length} 个 / ${(bytes / 1048576).toFixed(1)} MB`);
  console.log(`tag 档：${tags.map((t) => `${t}`).join(', ') || '(无)'}`);
  if (other.length) {
    console.log(`⚠ packs/ 下另有 ${other.length} 个非 assets-<tag> 形状的键，本脚本不动，需人工确认：`);
    for (const r of other) console.log(`  ? ${r.key}  ${(r.size / 1024).toFixed(0)} KB`);
  }
  if (!rows.length) {
    console.log('没有可删的 packs/assets-* 对象。');
    return;
  }

  // 写一份清单，删完还能对账。落在工作区 _tmp/<task>-*/，不污染仓库树。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve('C:/DDDD/Agent Work/_tmp', `cdn-clear-packs-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'packs-before-delete.json');
  fs.writeFileSync(outFile, `${JSON.stringify({ at: stamp, count: rows.length, bytes, tags, rows }, null, 2)}\n`);
  console.log(`清单已写：${outFile}`);

  if (!apply) {
    console.log('干跑结束（未删除）。加 --apply 才真删。');
    return;
  }

  let gone = 0;
  for (const r of rows) {
    if (!PACKS_RE.test(r.key)) throw new Error(`越界键，拒绝删除：${r.key}`);
    await deleteObject(config, r.key);
    gone++;
    if (gone % 50 === 0) console.log(`  已删 ${gone}/${rows.length}`);
  }
  const left = (await listKeys(config, 'packs/')).filter((r) => PACKS_RE.test(r.key));
  console.log(`已删 ${gone} 个对象；复核剩余 packs/assets-* = ${left.length}`);
  if (left.length) {
    console.error('复核未通过：仍有残留，逐条列出于下');
    for (const r of left) console.error(`  ! ${r.key}`);
    process.exit(1);
  }
  console.log(`PASS：packs/assets-* 已从 R2 清空（${(bytes / 1048576).toFixed(1)} MB）。`);
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
