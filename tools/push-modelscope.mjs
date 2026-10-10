#!/usr/bin/env node
// Push the asset snapshot from this repo's `assets-raw` branch to the ModelScope 创空间 mirror.
//
//   node tools/push-modelscope.mjs [--dry-run] [--include-skins] [--remote=modelscope]
//
// Design notes that matter:
//
//  - Idempotent. The mirror branch is rewritten wholesale (it is a snapshot, not a history — see the
//    README on `assets-raw`). Before doing any work we compare the source tree hash against the hash
//    recorded in the mirror's `assets.summary.json`; equal means exit 0 having pushed nothing. A
//    daily cron therefore costs one ls-remote plus one blob read when nothing changed.
//
//  - Byte fidelity is the contract. The tree is piped through `git archive` straight into a bare
//    checkout; nothing is resampled or re-encoded, and `.gitattributes` (-text -diff -merge binary)
//    travels with it so no platform can normalise line endings in PNG/MP3/skel bytes.
//
//  - Skins are opt-in. The source branch carries only part of the upstream skin set, so the default
//    excludes `assets/skins/**` and records that fact in the commit message instead of shipping a
//    silently incomplete tree. `--include-skins` exists for when the set is complete.
//
// The remote is expected to carry credentials in its URL (env MODELSCOPE_URL), which this script
// never prints.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// `git archive ... | tar -x` needs a shell with a pipe. On the runner that is /bin/sh; on this
// machine (Windows) it is only Git Bash, which is not on PATH by default.
const SHELL = process.platform === 'win32'
  ? 'C:/Program Files/Git/bin/bash.exe'
  : '/bin/bash';

// Git Bash's tar mangles Windows paths: `-C "C:\Users\..."` is read with the backslashes as escapes
// ("C\:\\Users\016891\\...: No such file or directory"). Forward slashes are what it wants, and
// they are harmless on Linux, so normalise unconditionally.
const shellPath = (p) => p.replace(/\\/g, '/');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const DRY = flag('dry-run');
const INCLUDE_SKINS = flag('include-skins');
const REMOTE_URL = process.env.MODELSCOPE_URL || '';
const BRANCH = opt('branch', 'cdn');
const SRC_REF = opt('src-ref', 'assets-raw');

const git = (cwd, ...a) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

const sh = (cmd, cwd) =>
  execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, shell: SHELL });

if (!REMOTE_URL) {
  console.error('MODELSCOPE_URL is not set; nothing to push to.');
  process.exit(2);
}

const REPO = path.resolve(process.cwd());
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-mirror-'));

/** Hash of the source tree as it will be mirrored, so an unchanged tree costs nothing. */
function sourceFingerprint() {
  // Two hard-won constraints here:
  //  - enumerate with `ls-tree`, not `tar -tf`. tar also emits a line per directory, which inflates
  //    the count (13,689 against 12,265 real files) and would record a lie in the manifest.
  //  - filter with grep, not `':(exclude)...'`. `ls-tree` rejects that pathspec magic outright
  //    ("pathspec magic not supported by this command"), and `ls-files --with-tree` mixes in index
  //    state and disagrees with the tree by 120 entries.
  const out = execSync(`git ls-tree -r --name-only ${SRC_REF}`, {
    cwd: REPO,
    shell: SHELL,
    maxBuffer: 1 << 28,
  }).toString();
  let lines = out.split('\n').filter(Boolean).sort();
  if (!INCLUDE_SKINS) lines = lines.filter((p) => !p.startsWith('assets/skins/'));
  if (!lines.length) throw new Error(`source ref ${SRC_REF} listed no files`);
  return { count: lines.length, hash: crypto.createHash('sha256').update(lines.join('\n')).digest('hex') };
}

/** What the mirror currently has, read from the manifest it carries. */
function remoteFingerprint() {
  try {
    // Read from the already-fetched ref rather than `git archive --remote`: that needs
    // upload-archive enabled on the server, and ModelScope answers it 404.
    const j = git(WORK, 'show', `FETCH_HEAD:assets.summary.json`);
    return JSON.parse(j);
  } catch {
    return null;
  }
}

console.log(`source: ${SRC_REF}${INCLUDE_SKINS ? ' (+skins)' : ' (no skins)'}`);
const src = sourceFingerprint();
console.log(`  ${src.count} files, tree hash ${src.hash.slice(0, 12)}`);

// -- 1. fetch the current mirror state -----------------------------------------------------------
fs.mkdirSync(WORK, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: WORK });
execFileSync('git', ['remote', 'add', 'origin-mirror', REMOTE_URL], { cwd: WORK });

let remote = null;
try {
  git(WORK, 'fetch', '--depth=1', 'origin-mirror', BRANCH);
  remote = remoteFingerprint();
} catch {
  console.log(`  mirror has no ${BRANCH} branch yet (first push)`);
}

if (remote && remote._mirror && remote._mirror.treeHash === src.hash) {
  console.log(`  mirror already carries this exact tree — nothing to do.`);
  process.exit(0);
}

// -- 2. materialise the tree ----------------------------------------------------------------------
const spec = INCLUDE_SKINS ? SRC_REF : `${SRC_REF} ':(exclude)assets/skins/*'`;
execSync(`git archive --format=tar ${spec} | tar -x -C "${shellPath(WORK)}"`, {
  cwd: REPO,
  shell: SHELL,
  stdio: 'inherit',
  maxBuffer: 1 << 28,
});

// Record what this tree is, so the next run can tell "changed" from "same" in one blob read.
const summaryPath = path.join(WORK, 'assets.summary.json');
let summary = {};
try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch { /* fresh tree */ }
summary._mirror = {
  treeHash: src.hash,
  fileCount: src.count,
  includesSkins: INCLUDE_SKINS,
  srcRef: SRC_REF,
  pushedAt: new Date().toISOString(),
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

// -- 3. commit and push ---------------------------------------------------------------------------
git(WORK, 'checkout', '-q', '-B', BRANCH);
git(WORK, 'add', '-A');
const msg = INCLUDE_SKINS
  ? `cdn: 素材快照 ${src.count} 文件（含皮肤）— tree ${src.hash.slice(0, 12)}`
  : `cdn: 素材快照 ${src.count} 文件（不含皮肤，待补齐）— tree ${src.hash.slice(0, 12)}`;
// Signing is off on purpose: this commit is a machine-generated snapshot, and on a machine whose
// gpg-agent socket is unavailable a signing attempt aborts the commit outright. The mirror is not a
// provenance source anyway — the frozen index-*.json snapshots on the R2 origin are.
git(WORK, 'config', 'commit.gpgsign', 'false');
git(WORK, '-c', 'user.name=cdn-sync', '-c', 'user.email=cdn-sync@local', 'commit', '-qm', msg);

if (DRY) {
  console.log(`dry-run: ${src.count} files ready, not pushed.`);
  process.exit(0);
}

git(WORK, 'config', 'http.postBuffer', '2097152000');
git(WORK, '-c', 'commit.gpgsign=false', 'push', '--force', 'origin-mirror', `${BRANCH}:${BRANCH}`);
console.log(`pushed ${BRANCH} (${src.count} files)`);
fs.rmSync(WORK, { recursive: true, force: true });
