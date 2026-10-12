import fs from 'node:fs';
import crypto from 'node:crypto';

const idx = JSON.parse(fs.readFileSync(new URL('./wscdn-index.json', import.meta.url), 'utf8'));
const p = 'assets/char/avatar/char_1016_agoat2.png';
const want = idx.files[p];
console.log('index.json 里的期望条目:', JSON.stringify(want));

const buf = fs.readFileSync(new URL('./ms-ds-probe.bin', import.meta.url));
console.log('实际下载字节数:', buf.length);
console.log('PNG magic:', buf.subarray(0, 8).toString('hex'));
const got = crypto.createHash('sha256').update(buf).digest('hex');
console.log('实际 sha256:', got);
console.log('一致?', want && want.sha256 === got ? 'YES ✅' : 'NO ❌');
