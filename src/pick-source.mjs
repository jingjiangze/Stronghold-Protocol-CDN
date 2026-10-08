// The mirror picker has one source of truth: src/pick.js. It is published to the CDN
// (cdn/v1/pick.js) and shipped inside the drop-in zip, so both must be the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PICK_SOURCE = fs.readFileSync(path.join(HERE, 'pick.js'), 'utf8');
