import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanup, readCleanupInputs } from '../scripts/cleanup.mjs';
import { UserError } from '../scripts/lib/common.mjs';
import { cfError, fakeFetch, noSleep, ok } from './helpers.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const path = `/client/v4/accounts/${accountId}/workers/workers/app-preview/previews/pr-12`;
const inputs = { token: 'cf-token', accountId, worker: 'app-preview', alias: 'pr-12' };

test('deletes the closed PR\'s preview', async () => {
  const { fetch, calls } = fakeFetch([['DELETE', path, () => ok(null)]]);
  assert.deepEqual(await cleanup(inputs, { fetch, sleep: noSleep }), { status: 'removed' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, 'Bearer cf-token');
});

test('a preview that is already gone is nothing to delete', async () => {
  const { fetch } = fakeFetch([['DELETE', path, () => cfError(404, 10025, 'Preview not found')]]);
  assert.deepEqual(await cleanup(inputs, { fetch, sleep: noSleep }), { status: 'absent' });
});

test('a refused token is explained', async () => {
  const { fetch } = fakeFetch([['DELETE', path, () => cfError(403, 10000, 'Authentication error')]]);
  const error = await cleanup(inputs, { fetch, sleep: noSleep }).catch((e) => e);
  assert.ok(error instanceof UserError);
  assert.match(error.message, /while deleting the preview pr-12/);
});

test('readCleanupInputs re-checks what the build job handed over', () => {
  const env = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: accountId, PLAN_WORKER: 'app-preview', PLAN_ALIAS: 'pr-12' };
  assert.deepEqual(readCleanupInputs(env), { token: 't', accountId, worker: 'app-preview', alias: 'pr-12' });
  assert.throws(() => readCleanupInputs({ ...env, PLAN_WORKER: 'app/../x' }), /Worker name/);
  assert.throws(() => readCleanupInputs({ ...env, PLAN_ALIAS: '../pr-12' }), /preview name/);
});
