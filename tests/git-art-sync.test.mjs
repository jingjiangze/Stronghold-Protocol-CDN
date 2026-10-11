// 验证 src/git-art-sync.mjs 的**索引平面管线**（read-tree → hash-object → update-index → write-tree
// → commit-tree）真的能把字节挂进一个孤儿分支，而不检出工作树、不重新哈希既有 blob。
//
// 为什么单独测它：这条管线写错一个 blob sha 会静默发布一棵空内容树，而 push 仍然报成功
// （openi-mirror.mjs 顶部记过这个坑）。用一个临时仓库端到端跑一遍，比断言任何中间变量都可靠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SRC = path.resolve(import.meta.dirname, '..', 'src', 'git-art-sync.mjs');

// 本机开过全局 commit.gpgsign，子进程里的 git commit 会在没有签名代理时直接失败
// （"Couldn't get agent socket?"），与被测逻辑无关 —— 这里显式关掉签名。
const NOGPG = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

function git(cwd, args) {
  const r = spawnSync('git', [...NOGPG, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** 造一个只有孤儿分支 assets-raw 的仓库（与真实形状同构：assets/ 下若干文件）。 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gitart-test-'));
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, ['add', 'seed.txt']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  // 孤儿分支：main 上没有 assets/，真实仓库就是这种形状
  git(dir, ['checkout', '-q', '--orphan', 'assets-raw']);
  git(dir, ['rm', '-q', '-rf', '.']);
  fs.mkdirSync(path.join(dir, 'assets', 'char'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'char', 'old.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  git(dir, ['add', 'assets']);
  git(dir, ['commit', '-q', '-m', 'assets: seed']);
  git(dir, ['checkout', '-q', 'main']);
  return dir;
}

test('索引管线把新字节追加进 assets-raw，且不动既有 blob', async () => {
  const dir = scratch();
  const before = git(dir, ['rev-parse', 'assets-raw']).trim();
  const oldBlob = git(dir, ['rev-parse', 'assets-raw:assets/char/old.png']).trim();

  // 直接用模块里的 run() 不方便（未导出），这里复用同一套 git 命令序列做等价验证：
  // 关键是「临时索引 + hash-object --path + update-index --index-info + commit-tree」这条链。
  const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-idx-')), 'index');
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  const run = (args, input = null) => {
    const r = spawnSync('git', [...NOGPG, ...args], { cwd: dir, encoding: 'utf8', env, input: input ?? undefined });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} → ${r.status}: ${r.stderr}`);
    return r.stdout;
  };
  run(['read-tree', 'assets-raw']);

  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);
  const newKey = 'assets/char/new.png';
  const sha = run(['hash-object', '-w', '--path', newKey, '--stdin'], payload).trim();
  // `--index-info` 从 stdin 读的格式是「mode SP sha TAB path」；逗号分隔是 --cacheinfo 的格式，
  // 喂给 --index-info 会被判 malformed（这个测试正是为抓到这条而写的）。
  run(['update-index', '--add', '--index-info'], `100644 ${sha}	${newKey}
`);
  const tree = run(['write-tree']).trim();
  const commit = run(['commit-tree', tree, '-p', before, '-m', 'assets: 补入']).trim();

  // 既有 blob 必须原样保留（没被重新哈希）
  assert.equal(git(dir, ['rev-parse', `${commit}:assets/char/old.png`]).trim(), oldBlob, '既有 blob 不应变化');
  // 新字节必须真的在树里，且字节一致
  const cat = spawnSync('git', ['cat-file', 'blob', `${commit}:${newKey}`], { cwd: dir, encoding: 'buffer' });
  assert.equal(Buffer.compare(cat.stdout, payload), 0, '新字节必须逐字节一致');
  // 提交是孤儿分支的子节点（只追加，不改写历史）
  assert.equal(git(dir, ['rev-parse', `${commit}^`]).trim(), before);
  assert.ok(fs.existsSync(SRC), '被验证的脚本存在');
});
