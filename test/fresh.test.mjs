import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshness } from '../scripts/fresh.mjs';
import { fakeFetch, jsonResponse, noSleep } from './helpers.mjs';

const sha = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const env = (overrides = {}) => ({
  GITHUB_TOKEN: 'gh-token',
  GITHUB_API_URL: 'https://api.github.test',
  GITHUB_REPOSITORY: 'ryan/app',
  PLAN_SHA: sha,
  PLAN_PR_NUMBER: '7',
  PLAN_DEFAULT_BRANCH: 'main',
  ...overrides,
});
const pr = (body) => fakeFetch([['GET', '/repos/ryan/app/pulls/7', () => jsonResponse(200, body)]]);
const branch = (head) => fakeFetch([['GET', '/repos/ryan/app/branches/main', () => jsonResponse(200, { commit: { sha: head } })]]);

test('the current PR head is fresh', async () => {
  assert.deepEqual(await freshness(env(), { fetch: pr({ state: 'open', head: { sha } }).fetch }), { fresh: 'true' });
});

test('a newer commit or a closed PR skips the upload', async () => {
  const moved = await freshness(env(), { fetch: pr({ state: 'open', head: { sha: newer } }).fetch });
  assert.deepEqual(moved, { fresh: 'false', status: 'stale', message: 'A newer commit (bbbbbbb) is on the pull request.' });
  const closed = await freshness(env(), { fetch: pr({ state: 'closed', head: { sha } }).fetch });
  assert.equal(closed.status, 'stale');
});

test('pushes compare against the default branch', async () => {
  const current = await freshness(env({ PLAN_PR_NUMBER: '' }), { fetch: branch(sha).fetch });
  assert.equal(current.fresh, 'true');
  const moved = await freshness(env({ PLAN_PR_NUMBER: '' }), { fetch: branch(newer).fetch });
  assert.equal(moved.message, 'A newer commit (bbbbbbb) is on the branch.');
});

test('an API failure does not block the preview', async () => {
  const { fetch, calls } = fakeFetch([['GET', '/repos/ryan/app/pulls/7', () => jsonResponse(503, { message: 'down' })]]);
  assert.deepEqual(await freshness(env(), { fetch, sleep: noSleep }), { fresh: 'true' });
  assert.equal(calls.length, 3);
});
