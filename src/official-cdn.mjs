// Build the "official latest package, CDN swapped to ours" variant.
//
// The drop-in zip and this variant answer two different players:
//   · drop-in (13 KB)      — already runs an upstream deployment, wants the art off its uplink;
//   · this one (~23 MB)    — has no deployment yet, wants to run one without ever downloading
//                            505 MB of art, or 481 MB of packs.
// It is the upstream LITE package (`Stronghold-Protocol-<tag>-lite.zip`) with the art manifests
// repointed at our CDN and nothing else touched.
//
// Two properties of the upstream package make this work, and both are asserted below rather than
// assumed — if either stops holding, the build must fail instead of shipping a broken zip:
//
//   1. `data/assets.json` is NOT in MANIFEST.json. server/update.js `isSetupArt()` treats it as
//      setup-managed (like public/assets/), so `checkInstall`/`applyPendingUpdate` neither verify
//      nor replace it. Rewriting it therefore cannot break an install check.
//   2. `data/emotes.json` IS in MANIFEST.json — it is a normal shipped file. Rewriting it without
//      also correcting its digest would make `npm run doctor` report a mismatch and would make a
//      later upstream update refuse to apply. So its manifest entry is rewritten with it, and the
//      result is verified against the bytes we actually ship.
//
// The zip is edited entry by entry (src/zip-edit.mjs) rather than unpacked and repacked: the
// package is 23 MB / 7,005 files, and repacking would rewrite every entry to change three. The
// editor is pure Node, so the build needs neither `zip` nor `unzip` on the machine running it.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { officialCdnZipName } from './names.mjs';
import { rewriteManifestText } from './rewrite-manifest.mjs';
import { editZip, readZipEntry, listZipEntries } from './zip-edit.mjs';

/** Art manifests to repoint, in the order they are read. */
const MANIFESTS = ['data/assets.json', 'data/emotes.json'];
/** Present only in the full package; rewritten when it happens to exist. */
const OPTIONAL_MANIFEST = 'data/local-assets.json';

const NOTE_FILE = 'CDN-MIRROR-README.txt';

const NOTE = (base, tag) => `这个包是什么
============

上游官方 v${tag.replace(/^v/, '')} 的「lite」包，原样未改，只把素材清单（data/assets.json
与 data/emotes.json）里的图片、字体地址改指向镜像 CDN：

    ${base}

所以它不含素材：public/assets 与 public/fonts 是空的，整个包只有二十几 MB，
不用下 505 MB 的完整包，也不用下 481 MB 的素材包。首次进游戏时素材按需从 CDN 拉取。

怎么跑
------

    node server/index.js          # 或者 npm start

依赖（node_modules）已经打包在里面，不需要 npm install。
需要能访问上面那个 CDN —— 素材全在它那里，断网时图片会加载不出来。

与官方包的区别
--------------

* 只改了 data/assets.json 与 data/emotes.json 两个文件里的素材地址；
  代码、数据、node_modules、启动脚本与官方包完全一致。
* 因为改了 emotes.json，MANIFEST.json 里对应的 sha256 也同步更新了，
  \`npm run doctor\` 的文件校验是自洽的。
* 上游发新版后请回到下载页重新下这个变体（它跟着最新版滚动更新），
  不要用官方的 update 增量包升级 —— 那个会把你带回需要本地素材的状态。

想换成别的镜像 / 想用本地素材
-----------------------------

清单里是绝对地址，直接全局替换 ${base} 即可换成任何同构的镜像根。
想完全不要 CDN：删掉 data/assets.json 与 data/emotes.json，改用官方完整包里的同名文件，
再把 public/assets、public/fonts 复制过来。
`;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.error) throw new Error(`${cmd} could not be started (${res.error.message})`);
  if (res.status !== 0) throw new Error(`${cmd} failed (${res.status}): ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  return res.stdout || '';
};

/**
 * Get the upstream lite zip, reusing a cached copy of the same size.
 *
 * 23 MB per run is not much, but the sync runs every six hours whether or not the upstream tag
 * moved, and a cached file also makes a local rebuild repeatable without touching the network.
 */
async function obtainLite({ release, cacheDir, log }) {
  const cached = path.join(cacheDir, release.lite.name);
  try {
    const st = await fsp.stat(cached);
    if (st.size === release.lite.size) {
      log(`lite zip: reusing ${release.lite.name} (${(st.size / 1048576).toFixed(1)} MB)`);
      return cached;
    }
    log(`lite zip: cached copy is ${st.size} B, expected ${release.lite.size} B — re-downloading`);
  } catch { /* not cached yet */ }

  await fsp.mkdir(cacheDir, { recursive: true });
  log(`lite zip: downloading ${release.lite.name} (${(release.lite.size / 1048576).toFixed(1)} MB)`);
  run('gh', ['release', 'download', release.tag, '-R', release.repo, '-p', release.lite.name, '-D', cacheDir, '--clobber']);
  const st = await fsp.stat(cached);
  // A truncated download would silently become a broken package, so the declared size is checked
  // the same way the full package's is.
  if (st.size !== release.lite.size) {
    throw new Error(`lite zip is ${st.size} B but the release declares ${release.lite.size} B`);
  }
  return cached;
}

/**
 * @returns {Promise<{file:string, name:string, size:number, rewritten:number, refs:number}>}
 */
export async function buildOfficialCdn({ out, base, token, release, cacheDir, log = console.log }) {
  if (!release?.lite) throw new Error(`release ${release?.tag} ships no lite zip — cannot build the official-CDN variant`);
  const name = officialCdnZipName(release.tag);
  const file = path.join(out, name);
  await fsp.mkdir(out, { recursive: true });

  const source = await obtainLite({ release, cacheDir, log });
  const zip = await fsp.readFile(source);

  const names = new Set(listZipEntries(zip));
  const prefix = 'Stronghold-Protocol/';
  const manifestPath = `${prefix}MANIFEST.json`;
  if (!names.has(manifestPath)) {
    throw new Error('the lite zip has no MANIFEST.json — refusing to build a package whose install check cannot be kept consistent');
  }
  // The variant exists because the package has no art. If a full package were fed in here the
  // rewrite would point at art that is also shipped, i.e. a much bigger package for no reason.
  const artEntries = [...names].filter((n) => n.startsWith(`${prefix}public/assets/`) || n.startsWith(`${prefix}public/fonts/`));
  if (artEntries.length) {
    throw new Error(`expected the lite package but it holds ${artEntries.length} art file(s), e.g. ${artEntries[0]}`);
  }

  const doc = JSON.parse(readZipEntry(zip, manifestPath).toString('utf8'));
  const replace = {};
  let refs = 0;
  const changed = [];

  for (const rel of [...MANIFESTS, OPTIONAL_MANIFEST]) {
    const entryName = `${prefix}${rel}`;
    if (!names.has(entryName)) continue;
    const before = readZipEntry(zip, entryName).toString('utf8');
    const { text, count } = rewriteManifestText(before, { base, version: token });
    refs += count;
    if (text === before) throw new Error(`${rel}: nothing was rewritten — the manifest layout changed`);
    replace[entryName] = Buffer.from(text, 'utf8');
    changed.push({ rel, entryName, buf: replace[entryName] });
  }
  if (!changed.length) throw new Error('no art manifest was rewritten');

  // The gate the whole scheme rests on: a file upstream manages cannot be changed without
  // correcting its MANIFEST entry, or the install stops verifying (npm run doctor → mismatch,
  // and a later upstream update refuses to apply). data/assets.json is setup-managed and absent
  // from the manifest; data/emotes.json is a normal shipped file and is not.
  let manifestTouched = false;
  for (const { rel, buf } of changed) {
    const entry = doc.files?.[rel];
    if (!entry) continue;
    entry.size = buf.length;
    entry.sha256 = sha256(buf);
    manifestTouched = true;
    log(`manifest entry corrected for the managed file ${rel}`);
  }
  if (manifestTouched) replace[manifestPath] = Buffer.from(JSON.stringify(doc), 'utf8');
  replace[`${prefix}${NOTE_FILE}`] = Buffer.from(NOTE(base, release.tag), 'utf8');

  const edited = editZip(zip, { replace });
  await fsp.writeFile(file, edited);

  const st = await fsp.stat(file);
  log(`official-cdn: ${name} (${(st.size / 1048576).toFixed(1)} MB, ${refs} art refs repointed)`);
  return { file, name, size: st.size, rewritten: changed.length, refs };
}

/** Verify a built variant: refs absolute, no bare art path left, and MANIFEST consistent. */
export async function verifyOfficialCdn(file) {
  const zip = await fsp.readFile(file);
  const names = new Set(listZipEntries(zip));
  const prefix = 'Stronghold-Protocol/';
  const problems = [];
  let absoluteRefs = 0;

  for (const rel of MANIFESTS) {
    const entryName = `${prefix}${rel}`;
    if (!names.has(entryName)) { problems.push(`${rel}: missing`); continue; }
    const text = readZipEntry(zip, entryName).toString('utf8');
    const bare = text.match(/"(?:\/assets\/|\/fonts\/)[^"]*"/g) || [];
    absoluteRefs += (text.match(/"https:\/\/[^"]*\/(?:assets|fonts)\/[^"]*"/g) || []).length;
    if (bare.length) problems.push(`${rel}: ${bare.length} art path(s) still relative, e.g. ${bare[0]}`);
  }

  const manifestPath = `${prefix}MANIFEST.json`;
  if (names.has(manifestPath)) {
    const doc = JSON.parse(readZipEntry(zip, manifestPath).toString('utf8'));
    for (const rel of [...MANIFESTS, OPTIONAL_MANIFEST]) {
      const entry = doc.files?.[rel];
      if (!entry) continue;
      const entryName = `${prefix}${rel}`;
      if (!names.has(entryName)) { problems.push(`${rel}: in MANIFEST but not in the zip`); continue; }
      const buf = readZipEntry(zip, entryName);
      if (buf.length !== entry.size || sha256(buf) !== entry.sha256) {
        problems.push(`${rel}: MANIFEST says ${entry.size}B/${entry.sha256.slice(0, 8)} but the zip holds ${buf.length}B/${sha256(buf).slice(0, 8)}`);
      }
    }
  } else {
    problems.push('MANIFEST.json missing');
  }

  return { ok: problems.length === 0, absoluteRefs, problems };
}
