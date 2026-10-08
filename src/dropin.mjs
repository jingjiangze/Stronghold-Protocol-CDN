// Build the drop-in zip.
//
// It is the artefact for the other half of the audience: someone running the UPSTREAM server
// deployment package, which knows nothing about this repository. The zip carries a sidecar that
// proxies an unmodified deployment and answers the art manifests from the CDN, the launchers for
// both platforms, the guide and the agent hints — all stamped with this run's base and token, so
// it is correct the moment it is unzipped.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PICK_SOURCE } from './pick-source.mjs';

export const DROPIN_DIR = 'dropin';

/** Windows batch files want CRLF; everything else is safer with LF. */
const eolFor = (name) => (name.endsWith('.cmd') || name.endsWith('.bat') ? '\r\n' : '\n');

export async function buildDropin({ root, out, base, token, upstreamTag, mirrorsJson }) {
  const templateDir = path.join(root, DROPIN_DIR);
  const stage = path.join(out, 'stronghold-cdn');
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });

  const stamps = {
    __SP_CDN_BASE__: String(base).replace(/\/+$/, ''),
    __SP_CDN_TOKEN__: token,
    __SP_UPSTREAM_TAG__: upstreamTag,
  };

  for (const entry of await fsp.readdir(templateDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    let text = await fsp.readFile(path.join(templateDir, entry.name), 'utf8');
    for (const [placeholder, value] of Object.entries(stamps)) text = text.split(placeholder).join(value);
    text = text.replace(/\r?\n/g, eolFor(entry.name));
    await fsp.writeFile(path.join(stage, entry.name), text, 'utf8');
  }

  // Self-contained: the mirror list and the picker travel with the folder.
  await fsp.writeFile(path.join(stage, 'mirrors.json'), mirrorsJson, 'utf8');
  await fsp.writeFile(path.join(stage, 'pick.js'), PICK_SOURCE, 'utf8');

  const name = `stronghold-cdn-dropin-${upstreamTag}.zip`;
  const file = path.join(out, name);
  await fsp.rm(file, { force: true });
  const res = spawnSync('zip', ['-X', '-q', '-r', name, 'stronghold-cdn'], { cwd: out, encoding: 'utf8' });
  if (res.error) throw new Error(`zip could not be started (${res.error.message})`);
  if (res.status !== 0) throw new Error(`zip failed (${res.status}): ${(res.stderr || '').slice(0, 200)}`);

  return { file, name, size: fs.statSync(file).size };
}
