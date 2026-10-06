import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEGACY_MARKER, decide, inline, isPreviewComment, markerFor, readLastGood, renderComment } from '../scripts/lib/comment.mjs';

const sha = 'b'.repeat(40);
const oldSha = 'a'.repeat(40);
const url = 'https://pr-12-app-preview.acme.workers.dev/';
const mainUrl = 'https://main-app-preview.acme.workers.dev/';
const MARKER = markerFor('app-preview');
const context = {
  workerName: 'app-preview',
  sha,
  visibility: 'private',
  now: '2026-10-01T12:34:56.000Z',
  runUrl: 'https://github.com/ryan/app/actions/runs/1',
  setupUrl: 'https://github.com/ryanberckmans/pr-preview#setup',
};
const lastGood = { sha: oldSha, url, at: '2026-09-30T08:00:00.000Z', visibility: 'private' };
const success = { planStatus: 'ok', configured: 'true', buildResult: 'success', deployResult: 'success', deployStatus: 'deployed', url, mainUrl };

test('decide maps job results to one state', () => {
  assert.deepEqual(decide(success), { kind: 'deployed', url, mainUrl });
  assert.equal(decide({ planStatus: 'invalid', planMessage: 'bad' }).kind, 'invalid');
  assert.equal(decide({ planStatus: 'ok', configured: 'false', missing: 'CLOUDFLARE_API_TOKEN' }).kind, 'not-configured');
  assert.equal(decide({ ...success, buildResult: 'failure', installOutcome: 'failure', deployResult: 'skipped', deployStatus: '' }).stage, 'install');
  assert.equal(decide({ ...success, buildResult: 'failure', buildOutcome: 'failure', deployResult: 'skipped', deployStatus: '' }).stage, 'build');
  assert.equal(decide({ ...success, buildResult: 'failure', deployResult: 'skipped', deployStatus: '' }).stage, 'collect');
  assert.equal(decide({ ...success, deployResult: 'failure', deployStatus: 'gate-off', deployMessage: 'm' }).kind, 'gate-off');
  assert.equal(decide({ ...success, deployResult: 'failure', deployStatus: 'needs-access', deployMessage: 'm' }).kind, 'needs-access');
  assert.equal(decide({ ...success, deployResult: 'failure', deployStatus: 'error', deployMessage: 'm' }).kind, 'deploy-failed');
  assert.equal(decide({ ...success, deployResult: 'failure', deployStatus: '' }).kind, 'deploy-failed');
  assert.equal(decide({ ...success, deployStatus: 'stale' }), null);
  assert.equal(decide({ ...success, buildResult: 'cancelled' }), null);
  assert.equal(decide({ ...success, deployResult: 'cancelled' }), null);
  // A deployed status with a link that isn't a workers.dev preview is not trusted.
  assert.equal(decide({ ...success, url: 'https://evil.example/' }).kind, 'deploy-failed');
});

test('decide maps a closed PR\'s cleanup to removed or failed, with no build', () => {
  const closed = { planStatus: 'ok', configured: 'true', cleanup: 'true', buildResult: 'skipped', deployResult: 'skipped' };
  assert.deepEqual(decide({ ...closed, cleanupResult: 'success', cleanupStatus: 'removed' }), { kind: 'removed' });
  assert.deepEqual(decide({ ...closed, cleanupResult: 'success', cleanupStatus: 'absent' }), { kind: 'removed' });
  assert.deepEqual(decide({ ...closed, cleanupResult: 'failure', cleanupStatus: 'error', cleanupMessage: 'm' }), { kind: 'remove-failed', message: 'm' });
  assert.equal(decide({ ...closed, cleanupResult: 'skipped' }).kind, 'remove-failed');
  assert.equal(decide({ ...closed, cleanupResult: 'cancelled' }), null);
});

test('a deleted preview leaves no link behind', () => {
  const { body, lastGood: saved } = renderComment({ kind: 'removed' }, { ...context, lastGood });
  assert.equal(body, `${MARKER}\n**Preview:** deleted when this pull request closed.`);
  assert.equal(saved, undefined);
  const failed = renderComment({ kind: 'remove-failed', message: 'Cloudflare API error while deleting the preview pr-12: boom.' }, { ...context, lastGood });
  assert.match(failed.body, /this pull request is closed, but its preview couldn't be deleted: Cloudflare API error while deleting the preview pr-12: boom\. \(\[run\]/);
  assert.match(failed.body, /The link still serves `aaaaaaa`/);
  assert.deepEqual(failed.lastGood, lastGood);
});

test('a private preview comment links the preview, main and the commit', () => {
  const { body, lastGood: saved } = renderComment(decide(success), { ...context, check: { command: 'npm test', status: 'passed' } });
  assert.ok(body.startsWith('<!-- pr-preview:app-preview -->\n'));
  assert.match(body, /\*\*Preview:\*\* https:\/\/pr-12-app-preview\.acme\.workers\.dev\//);
  assert.match(body, /Private: it asks you to sign in\./);
  assert.match(body, /Built from `bbbbbbb` at 2026-10-01 12:34 UTC\./);
  assert.match(body, /Compare with \[main\]\(https:\/\/main-app-preview\.acme\.workers\.dev\/\)/);
  assert.match(body, /Check `npm test` passed\./);
  assert.deepEqual(saved, { sha, url, at: context.now, visibility: 'private' });
  assert.deepEqual(readLastGood(body), saved);
});

test('a public preview says so', () => {
  const { body } = renderComment(decide(success), { ...context, visibility: 'public' });
  assert.match(body, /Public: anyone with the link can open it\./);
});

test('a failed check shows its last lines without letting them out of the code block', () => {
  const tail = 'Desktop overview level 5: 54.7 ms exceeds 50 ms\n```\n<img src=x> @ryan';
  const { body } = renderComment(decide(success), { ...context, check: { command: 'node gate.mjs', status: 'failed', tail } });
  assert.match(body, /Check `node gate\.mjs` failed \(\[run\]\(https:\/\/github\.com\/ryan\/app\/actions\/runs\/1\)\)\. The preview is up anyway\./);
  assert.match(body, /````text\nDesktop overview level 5: 54\.7 ms exceeds 50 ms\n```\n<img src=x> @ryan\n````/);
});

test('failures keep pointing at the last good preview', () => {
  const { body, lastGood: saved } = renderComment({ kind: 'build-failed', stage: 'build' }, { ...context, lastGood });
  assert.match(body, /the build for `bbbbbbb` failed/);
  assert.match(body, /The link still serves `aaaaaaa` from 2026-09-30 08:00 UTC: https:\/\/pr-12-app-preview/);
  assert.deepEqual(saved, lastGood);
  const failed = renderComment({ kind: 'deploy-failed', message: 'Wrangler failed while uploading the preview: boom' }, { ...context, lastGood });
  assert.match(failed.body, /couldn't deploy `bbbbbbb`: Wrangler failed while uploading the preview: boom/);
});

test('an open gate posts no link and forgets the old one', () => {
  const { body, lastGood: saved } = renderComment({ kind: 'gate-off', message: 'The workers.dev address of app-preview answered 200 without sign-in.' }, { ...context, lastGood });
  assert.match(body, /blocked, so no link was posted/);
  assert.doesNotMatch(body, /workers\.dev\//);
  assert.equal(saved, undefined);
  assert.equal(readLastGood(body), null);
});

test('setup states explain what to do next', () => {
  assert.match(
    renderComment({ kind: 'not-configured', missing: 'CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID' }, context).body,
    /not set up yet\. Add the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets/,
  );
  assert.match(renderComment({ kind: 'not-configured', missing: 'CLOUDFLARE_ACCOUNT_ID' }, context).body, /`CLOUDFLARE_ACCOUNT_ID` repository secret,/);
  assert.match(renderComment({ kind: 'needs-access', message: 'pr-preview created the Worker app-preview.' }, context).body, /almost set up/);
  assert.match(renderComment({ kind: 'invalid', message: 'worker-name must be lowercase' }, context).body, /need fixing: worker-name must be lowercase/);
});

test('messages from a run cannot add links, HTML or mentions', () => {
  assert.equal(inline('[click](https://evil) <b> @ryan `x`'), '\\[click\\](https:\u200b//evil) \\<b\\> @\u200bryan \\`x\\`');
  assert.equal(inline('Sign in again at www.evil.example/cf or WWW.evil.example'), 'Sign in again at www\u200b.evil.example/cf or WWW\u200b.evil.example');
});

test('each Worker has its own comment, and older comments are taken over', () => {
  assert.equal(markerFor('app-preview'), '<!-- pr-preview:app-preview -->');
  assert.equal(markerFor('Not A Name'), LEGACY_MARKER);
  assert.ok(isPreviewComment('<!-- pr-preview:app-preview -->\n**Preview:** x', 'app-preview'));
  assert.ok(isPreviewComment(`${LEGACY_MARKER}\n**Preview:** x`, 'app-preview'));
  assert.equal(isPreviewComment('<!-- pr-preview:docs-preview -->\n**Preview:** x', 'app-preview'), false);
  assert.equal(isPreviewComment('<!-- pr-preview:app-preview-old -->\n**Preview:** x', 'app-preview'), false);
  assert.equal(isPreviewComment(undefined, 'app-preview'), false);
});

test('a preview saved under the other visibility is never offered', () => {
  const publicGood = { ...lastGood, visibility: 'public' };
  const { body, lastGood: saved } = renderComment({ kind: 'build-failed', stage: 'build' }, { ...context, lastGood: publicGood });
  assert.doesNotMatch(body, /still serves/);
  assert.equal(saved, undefined);
});

test('readLastGood ignores anything it did not write', () => {
  assert.equal(readLastGood(undefined), null);
  assert.equal(readLastGood(`${MARKER}\n<!-- pr-preview:data {"sha":"x","url":"https://a.workers.dev/","at":"2026-01-01","visibility":"private"} -->`), null);
  assert.equal(readLastGood(`${MARKER}\n<!-- pr-preview:data {"sha":"${sha}","url":"https://evil.example/","at":"2026-01-01","visibility":"private"} -->`), null);
});

test('a check that prints a saved-preview line cannot plant a link', () => {
  const planted = `<!-- pr-preview:data {"sha":"${sha}","url":"https://planted.workers.dev/","at":"2026-01-01T00:00:00.000Z","visibility":"private"} -->`;
  const failed = renderComment(decide(success), { ...context, check: { command: 'npm test', status: 'failed', tail: planted } });
  assert.equal(readLastGood(failed.body).url, url);
  const bare = renderComment({ kind: 'build-failed', stage: 'build' }, { ...context, check: { command: 'npm test', status: 'failed', tail: planted } });
  assert.equal(readLastGood(bare.body), null);
  assert.equal(readLastGood(`${MARKER}\n${planted}\ntext after`), null);
});
