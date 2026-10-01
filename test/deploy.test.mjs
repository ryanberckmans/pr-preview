import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { UserError } from '../scripts/lib/common.mjs';
import { deploy, disableLocalRuntime, readInputs, wranglerError } from '../scripts/deploy.mjs';
import { cfError, fakeFetch, fakeWrangler, noSleep, ok, redirect, tempDir } from './helpers.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const api = `/client/v4/accounts/${accountId}`;
const sha = 'e'.repeat(40);
const deploymentId = 'abcdef12-3456-4789-8abc-def012345678';
const dbId = '99999999-8888-4777-8666-555555555555';
const login = (host) => `https://acme.cloudflareaccess.com/cdn-cgi/access/login/${host}?kid=1&redirect_url=%2F`;

function makeBundle(t, config = {}) {
  const dir = tempDir(t);
  const files = path.join(dir, 'files');
  mkdirSync(path.join(files, 'dist/server'), { recursive: true });
  mkdirSync(path.join(files, 'dist/client'), { recursive: true });
  mkdirSync(path.join(files, 'drizzle'), { recursive: true });
  writeFileSync(path.join(files, 'dist/server/index.js'), 'export default { fetch() { return new Response("ok"); } };\n');
  writeFileSync(path.join(files, 'dist/client/index.html'), '<h1>app</h1>\n');
  writeFileSync(path.join(files, 'drizzle/0000_init.sql'), 'CREATE TABLE t (id INTEGER);\n');
  writeFileSync(
    path.join(files, 'dist/server/wrangler.json'),
    JSON.stringify({
      name: 'app',
      main: 'index.js',
      no_bundle: true,
      legacy_env: true,
      compatibility_date: '2026-05-15',
      assets: { directory: '../client' },
      d1_databases: [{ binding: 'DB', database_name: 'prod', database_id: '00000000-0000-4000-8000-000000000000' }],
      vars: { SECRET_MODE: 'production' },
      ...config,
    }),
  );
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, config: 'dist/server/wrangler.json' }));
  return dir;
}

function inputs(bundleDir, overrides = {}) {
  return {
    token: 'cf-token',
    accountId,
    visibility: 'private',
    worker: 'app-preview',
    alias: 'pr-12',
    mainAlias: 'main',
    sha,
    prNumber: '12',
    teamDomain: 'acme.cloudflareaccess.com',
    d1: { DB: { database_name: 'app-preview-db', migrations_dir: 'drizzle' } },
    vars: { MODE: 'preview' },
    bundleDir,
    tempDir: bundleDir,
    ...overrides,
  };
}

// A Cloudflare account where everything is set up, unless told otherwise.
// `previewExists` says whether pr-12 has a preview from an earlier push.
function cloudflare({
  worker = 'app-preview',
  exists = true,
  previews = true,
  gate = 'on',
  afterUpload = 'on',
  previewExists = false,
  databases = [{ name: 'app-preview-db', uuid: dbId }],
} = {}) {
  let uploaded = false;
  let preview = previewExists;
  let created = !exists;
  const host = (h) => `https://${h}-${worker}.acme.workers.dev/`;
  const gated = (h, state) => (state === 'on' ? redirect(login(h)) : new Response('open', { status: 200 }));
  const routes = [
    ['GET', `${api}/workers/subdomain`, () => ok({ subdomain: 'acme' })],
    [
      'GET',
      `${api}/workers/workers/${worker}`,
      () =>
        exists || created === 'done'
          ? ok({ subdomain: { enabled: true, previews_enabled: previews, url: `https://${worker}.acme.workers.dev`, preview_url_suffix: `-${worker}.acme.workers.dev` } })
          : cfError(404, 10007, 'not found'),
    ],
    ['POST', `${api}/workers/scripts/${worker}/subdomain`, () => ok({ enabled: true, previews_enabled: true })],
    [
      'DELETE',
      `${api}/workers/workers/${worker}/previews/pr-12`,
      () => {
        const had = preview;
        preview = false;
        return had ? ok(null) : cfError(404, 10025, 'Preview not found');
      },
    ],
    ['GET', `${api}/workers/scripts/${worker}/deployments`, () => ok({ deployments: [{ versions: [{ version_id: '11112222-0000-4000-8000-000000000000', percentage: 100 }] }] })],
    ['GET', `${api}/d1/database`, () => ok(databases)],
    ['POST', `${api}/d1/database`, ({ body }) => ok({ name: body.name, uuid: dbId })],
    ['GET', `https://${worker}.acme.workers.dev/`, () => gated(`${worker}.acme.workers.dev`, gate)],
    ['GET', host('11112222'), () => gated('11112222', gate)],
    ['GET', host('pr-12'), () => gated('pr-12', uploaded ? afterUpload : gate)],
    ['GET', host(deploymentId), () => gated(deploymentId, afterUpload)],
  ];
  const fake = fakeFetch(routes);
  const wrangler = fakeWrangler((args) => {
    if (args[0] === 'deploy') created = 'done';
    if (args[0] === 'preview') {
      uploaded = true;
      preview = true;
      return {
        code: 0,
        tail: '',
        entries: [
          { type: 'wrangler-session' },
          {
            type: 'preview',
            version: 1,
            worker_name: worker,
            preview_id: 'f00d',
            preview_name: 'pr-12',
            preview_slug: 'pr-12',
            preview_urls: [`https://pr-12-${worker}.acme.workers.dev`],
            deployment_id: deploymentId,
            deployment_urls: [`https://${deploymentId}-${worker}.acme.workers.dev`],
          },
        ],
      };
    }
    return { code: 0, tail: '', entries: [] };
  });
  return { ...fake, wrangler };
}

const probes = (calls) => calls.filter((call) => call.url.includes('.workers.dev'));
const deletes = (calls) => calls.filter((call) => call.method === 'DELETE');

test('a private preview is uploaded only after the gate is proven, then checked again', async (t) => {
  const bundleDir = makeBundle(t);
  const cf = cloudflare();
  const result = await deploy(inputs(bundleDir), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run });
  assert.deepEqual(result, {
    status: 'deployed',
    url: 'https://pr-12-app-preview.acme.workers.dev/',
    'main-url': 'https://main-app-preview.acme.workers.dev/',
    'deployment-id': deploymentId,
    'deployment-url': `https://${deploymentId}-app-preview.acme.workers.dev/`,
    worker: 'app-preview',
    visibility: 'private',
  });

  const [migrate, upload] = cf.wrangler.runs;
  assert.deepEqual(migrate.args.slice(0, 5), ['d1', 'migrations', 'apply', 'DB', '--remote']);
  assert.equal(upload.args[0], 'preview');
  assert.equal(upload.args[upload.args.indexOf('--name') + 1], 'pr-12');
  assert.equal(upload.args[upload.args.indexOf('--message') + 1], 'PR #12 at eeeeeee');
  assert.ok(upload.args.includes('--ignore-base-config'));
  assert.equal(upload.config.name, 'app-preview');
  // Previews take their variables and bindings from the previews block only.
  assert.deepEqual(upload.config.vars, {});
  assert.deepEqual(upload.config.previews, {
    vars: { MODE: 'preview' },
    d1_databases: [{ binding: 'DB', database_name: 'app-preview-db', database_id: dbId }],
  });
  assert.deepEqual(upload.config.d1_databases, [{ binding: 'DB', database_name: 'app-preview-db', database_id: dbId, migrations_dir: 'files/drizzle' }]);
  assert.equal('legacy_env' in upload.config, false);

  // Two probes before the upload (workers.dev and the deployed version), two after.
  const hosts = probes(cf.calls).map((call) => new URL(call.url).hostname.split('.')[0]);
  assert.deepEqual(hosts, ['app-preview', '11112222-app-preview', 'pr-12-app-preview', `${deploymentId}-app-preview`]);
  const uploadIndex = cf.calls.findIndex((call) => call.url.includes('pr-12-'));
  assert.ok(uploadIndex > cf.calls.findIndex((call) => call.url.includes('11112222-')));
  assert.equal(deletes(cf.calls).length, 0);
});

test('a missing private Worker is created as a placeholder, and nothing is uploaded until Access is on', async (t) => {
  const cf = cloudflare({ exists: false, gate: 'off' });
  const error = await deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run }).catch((e) => e);
  assert.ok(error instanceof UserError);
  assert.equal(error.status, 'needs-access');
  assert.match(error.message, /workers\.dev address answered 200 without sign-in\. Put it behind Cloudflare Access \(Workers & Pages → app-preview → Access → All traffic\)/);
  assert.equal(cf.wrangler.runs.length, 1);
  const args = cf.wrangler.runs[0].args;
  assert.equal(args[0], 'deploy');
  assert.equal(args[args.indexOf('--name') + 1], 'app-preview');
  assert.ok(args[args.indexOf('--config') + 1].endsWith(path.join('placeholder', 'wrangler.json')));
  assert.equal(probes(cf.calls).length, 1);
  assert.equal(cf.calls.filter((call) => call.path.endsWith('/d1/database')).length, 0);
  assert.equal(deletes(cf.calls).length, 0);
});

test('a new private Worker in an account that protects all Workers gets its preview on the first run', async (t) => {
  const cf = cloudflare({ exists: false });
  const result = await deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run });
  assert.equal(result.status, 'deployed');
  assert.equal(result.url, 'https://pr-12-app-preview.acme.workers.dev/');
  assert.deepEqual(cf.wrangler.runs.map((run) => run.args[0]), ['deploy', 'd1', 'preview']);
  const hosts = probes(cf.calls).map((call) => new URL(call.url).hostname.split('.')[0]);
  assert.deepEqual(hosts, ['app-preview', '11112222-app-preview', 'pr-12-app-preview', `${deploymentId}-app-preview`]);
});

test('a new private Worker whose new link opens without sign-in still fails as blocked', async (t) => {
  const cf = cloudflare({ exists: false, afterUpload: 'off' });
  const error = await deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run }).catch((e) => e);
  assert.equal(error.status, 'gate-off');
  assert.match(error.message, /new preview link/);
});

test('an open private Worker stops everything before the upload', async (t) => {
  const cf = cloudflare({ gate: 'off' });
  const error = await deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run }).catch((e) => e);
  assert.ok(error instanceof UserError);
  assert.equal(error.status, 'gate-off');
  assert.match(error.message, /workers\.dev address of app-preview answered 200 without sign-in, so it isn't behind Cloudflare Access\.$/);
  assert.equal(cf.wrangler.runs.length, 0);
  assert.equal(cf.calls.filter((call) => call.path.endsWith('/d1/database')).length, 0);
  // This PR had no preview yet, so there was nothing to delete.
  assert.equal(deletes(cf.calls).length, 1);
});

test('an open private Worker loses this PR\'s preview from an earlier push', async (t) => {
  const cf = cloudflare({ gate: 'off', previewExists: true });
  const error = await deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run }).catch((e) => e);
  assert.equal(error.status, 'gate-off');
  assert.match(error.message, /pr-preview deleted the preview pr-12 so it doesn't stay open\.$/);
  assert.equal(deletes(cf.calls)[0].path, `${api}/workers/workers/app-preview/previews/pr-12`);
  assert.equal(cf.wrangler.runs.length, 0);
});

test('a new link that answers without sign-in fails the run, and the new preview is deleted', async (t) => {
  const cf = cloudflare({ afterUpload: 'off' });
  const error = await deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run }).catch((e) => e);
  assert.equal(error.status, 'gate-off');
  assert.match(error.message, /new preview link of app-preview answered 200 without sign-in.*pr-preview deleted the preview pr-12/);
  assert.equal(deletes(cf.calls).length, 1);
});

test('a failed delete is reported along with the open link', async (t) => {
  const cf = cloudflare({ afterUpload: 'off' });
  const failing = async (input, init) => (init?.method === 'DELETE' ? cfError(403, 10000, 'Authentication error') : cf.fetch(input, init));
  const error = await deploy(inputs(makeBundle(t)), { fetch: failing, sleep: noSleep, runWrangler: cf.wrangler.run }).catch((e) => e);
  assert.equal(error.status, 'gate-off');
  assert.match(error.message, /Deleting the preview pr-12 failed too: Authentication error/);
});

test('a preview without a workers.dev link is an error', async (t) => {
  const cf = cloudflare();
  const noLink = async (args) => {
    const result = await cf.wrangler.run(args);
    if (args[0] !== 'preview') return result;
    const entry = result.entries.find((e) => e.type === 'preview');
    return { ...result, entries: [{ ...entry, preview_urls: [], deployment_urls: [] }] };
  };
  await assert.rejects(deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: noLink }), /didn't give the preview pr-12 a workers\.dev link/);
  await assert.rejects(
    deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: async (args) => ({ ...(await cf.wrangler.run(args)), entries: [] }) }),
    /without reporting the new preview deployment/,
  );
});

test('Access for another team does not count', async (t) => {
  const cf = cloudflare();
  const error = await deploy(inputs(makeBundle(t), { teamDomain: 'other.cloudflareaccess.com' }), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run }).catch((e) => e);
  assert.equal(error.status, 'gate-off');
  assert.equal(cf.wrangler.runs.length, 0);
});

test('a public preview goes to the -public Worker, created on first use, with no gate checks', async (t) => {
  const cf = cloudflare({ worker: 'app-preview-public', exists: false, databases: [] });
  const result = await deploy(inputs(makeBundle(t), { visibility: 'public', worker: 'app-preview-public' }), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run });
  assert.equal(result.status, 'deployed');
  assert.equal(result.url, 'https://pr-12-app-preview-public.acme.workers.dev/');
  assert.equal(probes(cf.calls).length, 0);
  assert.deepEqual(cf.wrangler.runs.map((run) => run.args[0]), ['deploy', 'd1', 'preview']);
  assert.deepEqual(cf.calls.find((call) => call.method === 'POST' && call.path.endsWith('/d1/database')).body, { name: 'app-preview-db' });
});

test('a private Worker with Version URLs off is left alone', async (t) => {
  const cf = cloudflare({ previews: false });
  const error = await deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run }).catch((e) => e);
  assert.equal(error.status, 'gate-off');
  assert.match(error.message, /never turns them on for a private Worker/);
  assert.equal(cf.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(probes(cf.calls).length, 0);
  assert.equal(cf.wrangler.runs.length, 0);
});

test('a public Worker gets Version URLs turned on', async (t) => {
  const cf = cloudflare({ worker: 'app-preview-public', previews: false });
  const result = await deploy(inputs(makeBundle(t), { visibility: 'public', worker: 'app-preview-public' }), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run });
  assert.equal(result.status, 'deployed');
  assert.ok(cf.calls.some((call) => call.method === 'POST' && call.path.endsWith('/scripts/app-preview-public/subdomain')));
});

test('a binding the preview cannot have fails before any Cloudflare call', async (t) => {
  const cf = cloudflare();
  const bundleDir = makeBundle(t, { kv_namespaces: [{ binding: 'CACHE', id: 'prod-kv' }] });
  await assert.rejects(deploy(inputs(bundleDir), { fetch: cf.fetch, sleep: noSleep, runWrangler: cf.wrangler.run }), /kv_namespaces/);
  assert.equal(cf.calls.length, 0);
});

test('an account without a workers.dev subdomain gets a clear message', async (t) => {
  const { fetch } = fakeFetch([['GET', `${api}/workers/subdomain`, () => cfError(404, 10007, 'none')]]);
  await assert.rejects(deploy(inputs(makeBundle(t)), { fetch, sleep: noSleep, runWrangler: fakeWrangler().run }), /no workers\.dev subdomain/);
});

test('a transient upload failure is retried once', async (t) => {
  const cf = cloudflare();
  let attempts = 0;
  const flaky = async (args) => {
    if (args[0] === 'preview' && attempts++ === 0) return { code: 1, tail: '✘ [ERROR] A request to the Cloudflare API failed: 503 Service Unavailable', entries: [] };
    return cf.wrangler.run(args);
  };
  const result = await deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: flaky });
  assert.equal(result.status, 'deployed');
  assert.equal(attempts, 2);
});

test('a lasting upload failure reports Wrangler\'s error', async (t) => {
  const cf = cloudflare();
  const failing = async (args) =>
    args[0] === 'preview' ? { code: 1, tail: 'Uploading...\n✘ [ERROR] Your Worker exceeded the size limit of 3 MiB.\n', entries: [] } : cf.wrangler.run(args);
  await assert.rejects(deploy(inputs(makeBundle(t)), { fetch: cf.fetch, sleep: noSleep, runWrangler: failing }), /uploading the preview: Your Worker exceeded the size limit of 3 MiB\./);
});

test('links in the build output are refused', async (t) => {
  const bundleDir = makeBundle(t);
  symlinkSync('/etc/passwd', path.join(bundleDir, 'files/dist/client/passwd'));
  await assert.rejects(deploy(inputs(bundleDir), { fetch: cloudflare().fetch, sleep: noSleep, runWrangler: fakeWrangler().run }), /symbolic link/);
});

test('readInputs re-checks everything the build job handed over', () => {
  const env = {
    CLOUDFLARE_API_TOKEN: 't',
    CLOUDFLARE_ACCOUNT_ID: accountId,
    PLAN_VISIBILITY: 'private',
    PLAN_WORKER: 'app-preview',
    PLAN_ALIAS: 'pr-12',
    PLAN_MAIN_ALIAS: 'main',
    PLAN_SHA: sha,
    PLAN_PR_NUMBER: '12',
    PLAN_TEAM_DOMAIN: '',
    IN_D1: '{}',
    IN_PREVIEW_VARS: '{}',
    BUNDLE_DIR: '/tmp/bundle',
  };
  assert.equal(readInputs(env).worker, 'app-preview');
  assert.throws(() => readInputs({ ...env, PLAN_VISIBILITY: '' }), /visibility/);
  assert.throws(() => readInputs({ ...env, PLAN_WORKER: 'x/../../y' }), /Worker name/);
  assert.throws(() => readInputs({ ...env, PLAN_ALIAS: 'pr-12; rm -rf /' }), /alias/);
  assert.throws(() => readInputs({ ...env, PLAN_SHA: 'main' }), /SHA/);
  assert.throws(() => readInputs({ ...env, PLAN_TEAM_DOMAIN: 'evil.example' }), /cloudflareaccess/);
});

test('wranglerError picks out Wrangler\'s error lines', () => {
  assert.equal(wranglerError('a\n✘ [ERROR] first\nb\n✘ [ERROR] second\n'), 'first second');
  assert.equal(wranglerError('just a line\n'), 'just a line');
  // Wrangler colors its errors whatever NO_COLOR says.
  const colored = '\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mYour Worker exceeded the size limit.\u001b[0m\n\n🪵  Logs were written to "/tmp/x.log"\n';
  assert.equal(wranglerError(colored), 'Your Worker exceeded the size limit.');
});

test('disableLocalRuntime turns workerd into a stub that fails', (t) => {
  const toolDir = tempDir(t);
  const pkg = path.join(toolDir, 'node_modules', 'workerd');
  mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  writeFileSync(path.join(toolDir, 'package.json'), '{"name":"tool","private":true}');
  writeFileSync(path.join(pkg, 'package.json'), '{"name":"workerd","main":"lib/main.js"}');
  writeFileSync(path.join(pkg, 'lib', 'main.js'), "module.exports = { default: require('path').join(__dirname, '..', 'bin', 'workerd-binary') };\n");
  const binary = path.join(pkg, 'bin', 'workerd-binary');
  writeFileSync(binary, '#!/bin/sh\necho real\n', { mode: 0o755 });
  assert.equal(disableLocalRuntime(toolDir), binary);
  const run = spawnSync(binary, ['serve'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /turned off/);
  assert.throws(() => disableLocalRuntime(tempDir(t)), /Couldn't find workerd/);
});
