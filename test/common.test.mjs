import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  UserError,
  branchAlias,
  checkHostLength,
  clean,
  parseD1Input,
  parseVarsInput,
  resolveUnder,
  setOutputs,
} from '../scripts/lib/common.mjs';
import { parseJsonc } from '../scripts/lib/jsonc.mjs';
import { tempDir } from './helpers.mjs';

test('branchAlias makes valid preview aliases', () => {
  assert.equal(branchAlias('main'), 'main');
  assert.equal(branchAlias('Release/2026.10'), 'release-2026-10');
  assert.equal(branchAlias('2026-hotfix'), 'b-2026-hotfix');
  assert.equal(branchAlias('---'), 'b');
  assert.ok(branchAlias('x'.repeat(80)).length <= 30);
});

test('checkHostLength enforces the 63-character label', () => {
  checkHostLength('pr-12', 'map-of-ethereum-preview');
  assert.throws(() => checkHostLength('pr-12345', 'w'.repeat(55)), UserError);
});

test('resolveUnder keeps paths inside the root', () => {
  const root = path.resolve('/project');
  assert.equal(resolveUnder(root, root, 'dist/server', 'p'), path.join(root, 'dist/server'));
  assert.equal(resolveUnder(root, path.join(root, 'dist/server'), '../client', 'p'), path.join(root, 'dist/client'));
  assert.throws(() => resolveUnder(root, root, '../etc', 'p'), /outside the project/);
  assert.throws(() => resolveUnder(root, root, '/etc/passwd', 'p'), /relative path/);
  assert.throws(() => resolveUnder(root, root, '', 'p'), /non-empty/);
  assert.throws(() => resolveUnder(root, root, 'C:\\x', 'p'), /relative path/);
});

test('parseD1Input validates bindings and fields', () => {
  assert.deepEqual(parseD1Input('{"DB":{"database_name":"app-preview","migrations_dir":"drizzle"}}'), {
    DB: { database_name: 'app-preview', database_id: undefined, migrations_dir: 'drizzle' },
  });
  assert.deepEqual(parseD1Input(''), {});
  assert.throws(() => parseD1Input('[]'), /JSON object/);
  assert.throws(() => parseD1Input('{nope'), /valid JSON/);
  assert.throws(() => parseD1Input('{"1DB":{"database_name":"x"}}'), /binding name/);
  assert.throws(() => parseD1Input('{"DB":{"database_name":"bad name"}}'), /database_name/);
  assert.throws(() => parseD1Input('{"DB":{"database_name":"x","database_id":"nope"}}'), /database_id/);
  assert.throws(() => parseD1Input('{"DB":{"database_name":"x","migrations_dir":"../up"}}'), /outside/);
  assert.throws(() => parseD1Input('{"DB":{"database_name":"x","remote":true}}'), /unknown field/);
});

test('parseVarsInput accepts plain values only', () => {
  assert.deepEqual(parseVarsInput('{"A":"1","B":2,"C":false}'), { A: '1', B: 2, C: false });
  assert.throws(() => parseVarsInput('{"A":{"nested":1}}'), /string, number or boolean/);
  assert.throws(() => parseVarsInput('{"a-b":"1"}'), /variable name/);
});

test('clean removes line breaks and control characters', () => {
  assert.equal(clean('a\nb\r\u2028c\u0007'), 'a b c ');
  assert.equal(clean('x'.repeat(10), 5), 'xxxx…');
});

test('setOutputs writes values that cannot break out of their delimiter', (t) => {
  const file = path.join(tempDir(t), 'output');
  const tricky = 'line1\nsafe=no\nEOF\n';
  setOutputs({ message: tricky, empty: '', skipped: undefined }, file);
  const text = readFileSync(file, 'utf8');
  const match = /^message<<(pr_preview_[0-9a-f]{32})\n([\s\S]*?)\n\1\n/.exec(text);
  assert.ok(match);
  assert.equal(match[2], tricky);
  assert.match(text, /^empty<<pr_preview_[0-9a-f]{32}\n\npr_preview_/m);
  assert.doesNotMatch(text, /skipped/);
});

test('parseJsonc reads comments and trailing commas but not inside strings', () => {
  const text = `\ufeff{
    // a comment
    "url": "https://example.com/a//b", /* block */
    "glob": "**/*.js",
    "list": [1, 2,],
  }`;
  assert.deepEqual(parseJsonc(text), { url: 'https://example.com/a//b', glob: '**/*.js', list: [1, 2] });
  assert.deepEqual(parseJsonc('{"a": "x,}", "b": "\\" // not a comment"}'), { a: 'x,}', b: '" // not a comment' });
  assert.throws(() => parseJsonc('{ /* open'), /Unterminated/);
});
