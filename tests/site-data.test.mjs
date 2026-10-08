import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregate } from '../src/site-data.mjs';

test('aggregates the flat index into directories, biggest first', () => {
  const dirs = aggregate({
    'assets/char/a.png': { size: 100 },
    'assets/char/b.png': { size: 50 },
    'assets/audio/x.mp3': { size: 10 },
    'fonts/f.woff2': { size: 5 },
  });
  assert.deepEqual(dirs.map((d) => d.prefix), ['assets/char/', 'assets/audio/', 'fonts/']);
  assert.deepEqual(dirs[0], { prefix: 'assets/char/', files: 2, bytes: 150 });
  assert.deepEqual(dirs[2], { prefix: 'fonts/', files: 1, bytes: 5 });
});

test('an empty index aggregates to nothing rather than throwing', () => {
  assert.deepEqual(aggregate({}), []);
  assert.deepEqual(aggregate(undefined), []);
});

test('entries without a size still count', () => {
  const dirs = aggregate({ 'assets/ui/a.png': {} });
  assert.deepEqual(dirs, [{ prefix: 'assets/ui/', files: 1, bytes: 0 }]);
});
