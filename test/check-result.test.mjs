import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkResult, tailOf } from '../scripts/check-result.mjs';
import { tempDir } from './helpers.mjs';

test('the outcome maps to passed, failed or none', (t) => {
  const log = path.join(tempDir(t), 'check.log');
  writeFileSync(log, 'all good\n');
  assert.deepEqual(checkResult('success', log), { status: 'passed', tail: '' });
  assert.deepEqual(checkResult('skipped', log), { status: 'none', tail: '' });
  assert.deepEqual(checkResult('', ''), { status: 'none', tail: '' });
  assert.deepEqual(checkResult('failure', path.join(path.dirname(log), 'missing.log')), { status: 'failed', tail: '' });
});

test('a failed check keeps the last lines of its log, without colors', (t) => {
  const log = path.join(tempDir(t), 'check.log');
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  writeFileSync(log, `${lines.join('\r\n')}\n\u001b[31mDesktop overview level 5: 54.7 ms exceeds 50 ms\u001b[0m\n\n`);
  const { status, tail } = checkResult('failure', log);
  assert.equal(status, 'failed');
  const kept = tail.split('\n');
  assert.equal(kept.length, 40);
  assert.equal(kept[0], 'line 22');
  assert.equal(kept.at(-1), 'Desktop overview level 5: 54.7 ms exceeds 50 ms');
});

test('a long tail is cut from the front', () => {
  const tail = tailOf('x'.repeat(5000));
  assert.equal(tail.length, 3001);
  assert.ok(tail.startsWith('…'));
});
