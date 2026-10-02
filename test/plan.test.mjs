import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { plan } from '../scripts/plan.mjs';
import { tempDir } from './helpers.mjs';

const sha = 'a'.repeat(40);

function setup(t, { eventName = 'pull_request', event, env = {} } = {}) {
  const dir = tempDir(t);
  const eventPath = path.join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event));
  return plan({
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_REPOSITORY: 'ryan/app',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: sha,
    GITHUB_WORKSPACE: '/work',
    IN_WORKER_NAME: 'app-preview',
    IN_WRANGLER_CONFIG: 'dist/server/wrangler.json',
    IN_WORKING_DIRECTORY: '.',
    IN_D1: '{"DB":{"database_name":"app-preview","migrations_dir":"drizzle"}}',
    IN_PREVIEW_VARS: '{}',
    IN_FORCE_PRIVATE: 'false',
    HAS_API_TOKEN: 'true',
    HAS_ACCOUNT_ID: 'true',
    ...env,
  });
}

const repo = (overrides = {}) => ({ full_name: 'ryan/app', private: true, visibility: 'private', default_branch: 'main', ...overrides });
const prEvent = (overrides = {}) => ({
  action: 'synchronize',
  repository: repo(overrides.repository),
  pull_request: { number: 12, head: { sha, repo: { full_name: 'ryan/app' } }, user: { login: 'ryan' }, ...overrides.pull_request },
});

test('a PR in a private repo gets a private pr-<number> preview', (t) => {
  const out = setup(t, { event: prEvent() });
  assert.equal(out.run, 'true');
  assert.equal(out.status, 'ok');
  assert.equal(out.alias, 'pr-12');
  assert.equal(out['main-alias'], 'main');
  assert.equal(out.visibility, 'private');
  assert.equal(out.worker, 'app-preview');
  assert.equal(out.sha, sha);
  assert.equal(out['pr-number'], '12');
  assert.equal(out.configured, 'true');
  assert.equal(out.build, 'true');
  assert.equal(out.cleanup, 'false');
  assert.equal(out['app-dir'], path.resolve('/work/app'));
});

test('a public repo uses the -public Worker, unless forced private', (t) => {
  const publicEvent = prEvent({ repository: { private: false, visibility: 'public' } });
  const open = setup(t, { event: publicEvent });
  assert.equal(open.visibility, 'public');
  assert.equal(open.worker, 'app-preview-public');
  const forced = setup(t, { event: publicEvent, env: { IN_FORCE_PRIVATE: 'true' } });
  assert.equal(forced.visibility, 'private');
  assert.equal(forced.worker, 'app-preview');
});

test('internal or unknown visibility stays private', (t) => {
  assert.equal(setup(t, { event: prEvent({ repository: { private: false, visibility: 'internal' } }) }).visibility, 'private');
  assert.equal(setup(t, { event: prEvent({ repository: { private: undefined, visibility: undefined } }) }).visibility, 'private');
});

test('fork PRs get no preview', (t) => {
  assert.equal(setup(t, { event: prEvent({ pull_request: { head: { sha, repo: { full_name: 'someone/app' } } } }) }).run, 'false');
  const closedFork = { ...prEvent({ pull_request: { head: { sha, repo: null } } }), action: 'closed' };
  assert.equal(setup(t, { event: closedFork }).run, 'false');
});

test('a closed PR has its preview deleted, and nothing is built', (t) => {
  const out = setup(t, { event: { ...prEvent(), action: 'closed' } });
  assert.equal(out.run, 'true');
  assert.equal(out.cleanup, 'true');
  assert.equal(out.build, 'false');
  assert.equal(out.alias, 'pr-12');
  assert.equal(out.worker, 'app-preview');
  const publicRepo = setup(t, { event: { ...prEvent({ repository: { private: false, visibility: 'public' } }), action: 'closed' } });
  assert.equal(publicRepo.worker, 'app-preview-public');
});

test('a closed PR without secrets or with broken settings is left alone', (t) => {
  const closed = { ...prEvent(), action: 'closed' };
  const unconfigured = setup(t, { event: closed, env: { HAS_ACCOUNT_ID: 'false' } });
  assert.equal(unconfigured.run, 'false');
  assert.match(unconfigured.reason, /no preview to delete/);
  const invalid = setup(t, { event: closed, env: { IN_WORKER_NAME: 'Bad Name' } });
  assert.equal(invalid.run, 'false');
  assert.match(invalid.reason, /can't be deleted: worker-name must be/);
});

test('pushes preview the default branch only', (t) => {
  const main = setup(t, { eventName: 'push', event: { repository: repo() } });
  assert.equal(main.alias, 'main');
  assert.equal(main['pr-number'], '');
  assert.equal(main['default-branch'], 'main');
  const other = setup(t, { eventName: 'push', event: { repository: repo() }, env: { GITHUB_REF: 'refs/heads/feature' } });
  assert.equal(other.run, 'false');
  const trunk = setup(t, { eventName: 'push', event: { repository: repo({ default_branch: 'Trunk' }) }, env: { GITHUB_REF: 'refs/heads/Trunk' } });
  assert.equal(trunk.alias, 'trunk');
});

test('pull_request_target only deletes a closed PR\'s preview', (t) => {
  const closed = { ...prEvent(), action: 'closed' };
  const out = setup(t, { eventName: 'pull_request_target', event: closed });
  assert.equal(out.run, 'true');
  assert.equal(out.cleanup, 'true');
  assert.equal(out.build, 'false');
  assert.equal(out.alias, 'pr-12');
  assert.equal(out['pr-number'], '12');
  const synchronize = setup(t, { eventName: 'pull_request_target', event: prEvent() });
  assert.equal(synchronize.run, 'false');
  assert.match(synchronize.reason, /only deletes previews on pull_request_target/);
  const fork = { ...prEvent({ pull_request: { head: { sha, repo: { full_name: 'someone/app' } } } }), action: 'closed' };
  assert.equal(setup(t, { eventName: 'pull_request_target', event: fork }).run, 'false');
  assert.equal(setup(t, { eventName: 'pull_request_target', event: closed, env: { HAS_API_TOKEN: 'false' } }).run, 'false');
  const noNumber = setup(t, { eventName: 'pull_request_target', event: { ...prEvent({ pull_request: { number: undefined } }), action: 'closed' } });
  assert.equal(noNumber.run, 'false');
  assert.match(noNumber.reason, /number is missing/);
});

test('other events are ignored', (t) => {
  const out = setup(t, { eventName: 'issue_comment', event: prEvent() });
  assert.equal(out.run, 'false');
  assert.match(out.reason, /doesn't handle issue_comment events/);
});

test('missing secrets mean not configured, and nothing is built', (t) => {
  const out = setup(t, { event: prEvent(), env: { HAS_API_TOKEN: 'false' } });
  assert.equal(out.configured, 'false');
  assert.equal(out.missing, 'CLOUDFLARE_API_TOKEN');
  assert.equal(out.build, 'false');
});

test('invalid inputs are reported, not thrown', (t) => {
  const cases = {
    IN_WORKER_NAME: 'App_Preview',
    IN_ACCESS_TEAM_DOMAIN: 'acme.example.com',
    IN_WRANGLER_CONFIG: '../outside.json',
    IN_WORKING_DIRECTORY: '/abs',
    IN_D1: '{"DB":{}}',
    IN_PREVIEW_VARS: '[1]',
    IN_FORCE_PRIVATE: 'yes',
  };
  for (const [name, value] of Object.entries(cases)) {
    const out = setup(t, { event: prEvent(), env: { [name]: value } });
    assert.equal(out.status, 'invalid', name);
    assert.equal(out.build, 'false', name);
    assert.ok(out.message, name);
  }
});

test('a Worker name too long for preview hosts is refused', (t) => {
  const out = setup(t, { event: prEvent({ pull_request: { number: 12345 } }), env: { IN_WORKER_NAME: 'w'.repeat(56) } });
  assert.equal(out.status, 'invalid');
  assert.match(out.message, /over Cloudflare's limit/);
});

test('the team domain is accepted in any case', (t) => {
  assert.equal(setup(t, { event: prEvent(), env: { IN_ACCESS_TEAM_DOMAIN: 'Acme.CloudflareAccess.com' } })['team-domain'], 'acme.cloudflareaccess.com');
});
