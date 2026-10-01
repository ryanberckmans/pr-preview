import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { LEGACY_MARKER } from '../scripts/lib/comment.mjs';
import { report } from '../scripts/report.mjs';
import { fakeFetch, jsonResponse, tempDir } from './helpers.mjs';

const sha = 'c'.repeat(40);
const url = 'https://pr-7-app-preview.acme.workers.dev/';

function env(t, overrides = {}) {
  return {
    GITHUB_TOKEN: 'gh-token',
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_REPOSITORY: 'ryan/app',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '42',
    GITHUB_STEP_SUMMARY: path.join(tempDir(t), 'summary.md'),
    TOOL_REPOSITORY: 'ryanberckmans/pr-preview',
    IN_WORKER_NAME: 'app-preview',
    PLAN_STATUS: 'ok',
    PLAN_CONFIGURED: 'true',
    PLAN_VISIBILITY: 'private',
    PLAN_SHA: sha,
    PLAN_PR_NUMBER: '7',
    BUILD_RESULT: 'success',
    DEPLOY_RESULT: 'success',
    DEPLOY_STATUS: 'deployed',
    DEPLOY_URL: url,
    DEPLOY_MAIN_URL: 'https://main-app-preview.acme.workers.dev/',
    ...overrides,
  };
}

function github(comments) {
  return fakeFetch([
    ['GET', '/repos/ryan/app/issues/7/comments', () => jsonResponse(200, comments)],
    ['POST', '/repos/ryan/app/issues/7/comments', ({ body }) => jsonResponse(201, { id: 99, ...body })],
    ['PATCH', /\/repos\/ryan\/app\/issues\/comments\/(\d+)$/, ({ body }) => jsonResponse(200, body)],
  ]);
}

test('posts one comment, then updates it in place', async (t) => {
  const first = github([{ id: 1, user: { login: 'ryan' }, body: '<!-- pr-preview:app-preview -->\nquoting the bot' }]);
  const created = await report(env(t), { fetch: first.fetch, now: '2026-10-01T10:00:00.000Z' });
  assert.equal(created.action, 'created');
  assert.equal(first.calls.at(-1).method, 'POST');
  assert.equal(first.calls[0].headers.authorization, 'Bearer gh-token');

  const second = github([{ id: 5, user: { login: 'github-actions[bot]' }, body: created.body }]);
  const updated = await report(env(t, { DEPLOY_RESULT: 'failure', DEPLOY_STATUS: 'error', DEPLOY_MESSAGE: 'boom', PLAN_SHA: 'd'.repeat(40) }), { fetch: second.fetch });
  assert.equal(updated.action, 'updated');
  assert.match(second.calls.at(-1).url, /\/issues\/comments\/5$/);
  assert.match(updated.body, /couldn't deploy `ddddddd`: boom/);
  assert.match(updated.body, /The link still serves `ccccccc` from 2026-10-01 10:00 UTC/);
});

test('a second app in the same repo gets its own comment, and an older comment is taken over', async (t) => {
  const other = github([{ id: 3, user: { login: 'github-actions[bot]' }, body: '<!-- pr-preview:docs-preview -->\n**Preview:** docs' }]);
  assert.equal((await report(env(t), { fetch: other.fetch })).action, 'created');
  const legacy = github([{ id: 4, user: { login: 'github-actions[bot]' }, body: `${LEGACY_MARKER}\n**Preview:** not set up yet.` }]);
  const updated = await report(env(t), { fetch: legacy.fetch });
  assert.equal(updated.action, 'updated');
  assert.match(legacy.calls.at(-1).url, /\/issues\/comments\/4$/);
  assert.ok(updated.body.startsWith('<!-- pr-preview:app-preview -->\n'));
});

test('writes the run summary without the hidden markers', async (t) => {
  const e = env(t);
  const { fetch } = github([]);
  await report(e, { fetch });
  const summary = readFileSync(e.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /\*\*Preview:\*\* https:\/\/pr-7-app-preview/);
  assert.doesNotMatch(summary, /<!--/);
});

test('pushes to the default branch only write the summary', async (t) => {
  const { fetch, calls } = github([]);
  const result = await report(env(t, { PLAN_PR_NUMBER: '' }), { fetch });
  assert.equal(result.action, 'summary');
  assert.equal(calls.length, 0);
});

test('a superseded run leaves the comment alone', async (t) => {
  const { fetch, calls } = github([]);
  const result = await report(env(t, { DEPLOY_STATUS: 'stale' }), { fetch });
  assert.equal(result.action, 'none');
  assert.equal(calls.length, 0);
});
