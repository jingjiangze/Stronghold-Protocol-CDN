// How much one promote round is allowed to do.
//
// This is worth a test because the number is duplicated across three places that cannot read each
// other: the promote script's own defaults, the workflow input `default:`s, and the shell fallbacks
// the chained re-dispatch actually uses (it passes no inputs, so it gets the fallbacks). Editing one
// and not the others silently changes how fast a backlog drains, which is exactly the bug this
// change set out to fix -- a round of 20 with a ~65 s fixed cost per round.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseArgs } from '../src/promote-uploads.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'promote-uploads.yml'), 'utf8');

/** The single value matched by `re`, or a failure that says how many it found. */
const one = (re, what) => {
  // matchAll needs /g; /m because some patterns are anchored per line.
  const found = [...WORKFLOW.matchAll(new RegExp(re.source, 'gm'))].map((m) => m[1]);
  assert.equal(found.length, 1, `expected exactly one ${what} in the workflow, found ${found.length}`);
  return Number(found[0]);
};

/**
 * The `default:` of a `workflow_dispatch` input, found by indentation rather than a fixed number of
 * spaces so an editor re-indenting the block does not silently stop the check from matching.
 */
const inputDefault = (name) => {
  const lines = WORKFLOW.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^\\s{2,}${name}:\\s*$`).test(l));
  assert.ok(at >= 0, `no \`${name}:\` input found in the workflow`);
  const indent = lines[at].match(/^\s*/)[0].length;
  for (let j = at + 1; j < lines.length; j++) {
    const indentJ = lines[j].match(/^\s*/)[0].length;
    if (lines[j].trim() && indentJ <= indent) break; // left the input's block
    const m = lines[j].match(/^(\s*)default:\s*(\d+)\s*$/);
    if (m && m[1].length > indent) return Number(m[2]);
  }
  throw new Error(`no \`default:\` under the \`${name}\` input`);
};

const scriptDefaults = parseArgs([]);
const inputDefaults = { max: inputDefault('max'), budget_seconds: inputDefault('budget_seconds') };
// `inputs.max || 2000` and `inputs.budget_seconds || 1200` in the promote step's run block.
const shellFallbacks = {
  max: one(/\$\{\{ inputs\.max \|\| (\d+) \}\}/, 'max shell fallback'),
  budget_seconds: one(/\$\{\{ inputs\.budget_seconds \|\| (\d+) \}\}/, 'budget_seconds shell fallback'),
};

test('the script, the workflow inputs and the shell fallbacks agree', () => {
  assert.deepEqual(
    { max: scriptDefaults.max, budget_seconds: scriptDefaults.budgetSeconds },
    inputDefaults,
    'promote-uploads.mjs defaults must match the workflow input defaults',
  );
  assert.deepEqual(
    shellFallbacks,
    inputDefaults,
    'the shell fallbacks are what the chained re-dispatch uses, so they must match the input defaults',
  );
});

// A round is bounded by a clock first, because the real constraint is the job's 30-minute timeout and
// the cost per file depends on what was uploaded. The count is only a backstop, so it must be far
// above what fits in the budget rather than an independent throttle.
test('the budget is the binding limit, and it leaves room inside the 30-minute job', () => {
  assert.equal(scriptDefaults.budgetSeconds, 1200);
  assert.ok(
    scriptDefaults.max >= 1000,
    'the count must not be the throttle again; the clock is what should stop a round',
  );
  const jobTimeoutMinutes = one(/^\s{4}timeout-minutes: (\d+)$/m, 'job timeout');
  assert.ok(
    jobTimeoutMinutes * 60 - scriptDefaults.budgetSeconds >= 300,
    'leave at least 5 minutes of the job for checkout, tests, the commit and the interface republish',
  );
});

test('the arguments parse, and nonsense is refused', () => {
  assert.deepEqual(parseArgs(['--dry']), { dry: true, max: 2000, budgetSeconds: 1200 });
  assert.deepEqual(parseArgs(['--max=7', '--budget-seconds=30']), { dry: false, max: 7, budgetSeconds: 30 });
  // A budget of 0 means "no budget", which is how a caller says "finish the backlog regardless".
  assert.equal(parseArgs(['--budget-seconds=0']).budgetSeconds, 0);
  // A bad count must fall back to the default rather than becoming zero files: a round that
  // publishes nothing yet reports success looks exactly like a healthy run.
  assert.equal(parseArgs(['--max=abc']).max, 2000);
  assert.equal(parseArgs(['--max=0']).max, 2000);
  assert.equal(parseArgs(['--budget-seconds=-5']).budgetSeconds, 1200);
  assert.throws(() => parseArgs(['--max']), /未知参数/);
});
