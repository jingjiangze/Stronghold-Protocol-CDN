// The measured mainland-carrier table, read from `network.json` for publication.
//
// This is the one thing in the interface that is not derived from the asset tree: it is a record of
// what the network actually did on a given day, measured with Globalping from mainland carriers.
// It exists so that "which origins are runtime candidates" is a decision with evidence behind it,
// rather than an opinion -- and so a source that failed 40% of requests cannot quietly stay listed.
//
// It is published, not consumed: a browser cannot detect its own carrier, so no client can apply
// this table directly. Clients measure for themselves (see src/pick.js).
import fs from 'node:fs';
import path from 'node:path';

export const NETWORK_TABLE = 'network.json';

/** Parse and sanity-check the table. Throws with a specific reason so a rotted file is obvious. */
export function parseNetworkTable(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${NETWORK_TABLE} is not valid JSON: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object') throw new Error(`${NETWORK_TABLE} must be an object`);
  if (typeof doc.measuredAt !== 'string' || !doc.measuredAt) throw new Error(`${NETWORK_TABLE} needs a measuredAt date`);
  if (!Array.isArray(doc.sources) || !doc.sources.length) throw new Error(`${NETWORK_TABLE} needs a non-empty sources array`);

  const ids = new Set();
  for (const s of doc.sources) {
    if (!s || typeof s.id !== 'string' || !s.id) throw new Error(`${NETWORK_TABLE}: every source needs an id`);
    if (ids.has(s.id)) throw new Error(`${NETWORK_TABLE}: duplicate source id ${s.id}`);
    ids.add(s.id);
    if (typeof s.host !== 'string' || !s.host) throw new Error(`${NETWORK_TABLE}: ${s.id} needs a host`);
    // An origin with no probe path cannot be measured by any client, so it cannot be a candidate.
    if (typeof s.probe !== 'string' || !s.probe.startsWith('/')) throw new Error(`${NETWORK_TABLE}: ${s.id} needs a probe path starting with /`);
  }

  // Every excluded id must name a source that is actually listed: an exclusion for something that
  // is not in the table is a stale edit, and it reads as if a source were dropped when it was not.
  for (const ex of doc.excluded || []) {
    if (!ex || typeof ex.id !== 'string') throw new Error(`${NETWORK_TABLE}: every exclusion needs an id`);
    if (!ids.has(ex.id)) throw new Error(`${NETWORK_TABLE}: excluded "${ex.id}" is not one of the sources`);
  }
  // The default hint may only name listed, non-excluded sources, or a client seeding from it would
  // start on something the same file says not to use.
  const excluded = new Set((doc.excluded || []).map((e) => e.id));
  for (const id of doc.defaultOrderHint || []) {
    if (!ids.has(id)) throw new Error(`${NETWORK_TABLE}: defaultOrderHint names unknown source ${id}`);
    if (excluded.has(id)) throw new Error(`${NETWORK_TABLE}: defaultOrderHint names excluded source ${id}`);
  }
  return doc;
}

/** Read, validate and return the table text verbatim (so the published bytes match the repo). */
export function readNetworkTable(root) {
  const file = path.join(root, NETWORK_TABLE);
  const text = fs.readFileSync(file, 'utf8');
  parseNetworkTable(text);
  return text;
}
