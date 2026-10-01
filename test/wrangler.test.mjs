// Runs pr-preview's pinned Wrangler on collected build output against a local
// stand-in for Cloudflare's API. It checks that Wrangler accepts the config
// pr-preview writes and that a preview is given only the bindings it should have.
// Needs `npm ci` first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundle } from '../scripts/bundle.mjs';
import { createWranglerRunner, loadBundle } from '../scripts/deploy.mjs';
import { buildPreviewConfig } from '../scripts/lib/wrangler-config.mjs';
import { tempDir } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const installed = existsSync(path.join(here, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
const skip = installed ? false : 'run npm ci first';
const accountId = '0123456789abcdef0123456789abcdef';
const databaseId = '11111111-2222-4333-8444-555555555555';

// The Worker Previews calls `wrangler preview` makes, answered as Cloudflare would
// for a Worker that has no previews yet. Anything else is recorded as unexpected.
async function fakeCloudflare(t) {
  const requests = [];
  const unexpected = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://127.0.0.1');
    const request = { method: req.method, path: url.pathname, query: url.searchParams, body: Buffer.concat(chunks), contentType: req.headers['content-type'] };
    requests.push(request);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const ok = (result) => send(200, { success: true, errors: [], messages: [], result });
    const match = url.pathname.match(/^\/client\/v4\/accounts\/([0-9a-f]{32})\/workers\/(workers|scripts)\/([a-z0-9-]+)(\/.*)?$/);
    const [, account, kind, worker, rest = ''] = match ?? [];
    const host = (label) => `https://${label}-${worker}.acme.workers.dev`;
    if (account !== accountId) {
      unexpected.push(`${req.method} ${url.pathname}`);
      return send(404, { success: false, errors: [{ code: 10000, message: 'not part of the fake' }], result: null });
    }
    if (kind === 'workers' && req.method === 'GET' && rest === '') return ok({ name: worker, previews_base_config: {} });
    if (kind === 'workers' && req.method === 'GET' && /^\/previews\/[^/]+$/.test(rest)) {
      return send(404, { success: false, errors: [{ code: 10025, message: 'Preview not found' }], result: null });
    }
    if (kind === 'workers' && req.method === 'POST' && rest === '/previews') {
      const { name } = JSON.parse(request.body.toString('utf8'));
      return ok({ id: 'preview-1', name, slug: name, urls: [host(name)] });
    }
    if (kind === 'scripts' && req.method === 'POST' && rest === '/assets-upload-session') return ok({ jwt: 'assets-jwt', buckets: [] });
    if (kind === 'workers' && req.method === 'POST' && rest === '/previews/preview-1/deployments') {
      const form = await new Response(request.body, { headers: { 'content-type': request.contentType } }).formData();
      request.metadata = JSON.parse(form.get('metadata'));
      request.files = form.getAll('files').map((file) => file.name);
      return ok({ id: 'deployment-1', urls: [host('deployment-1')], env: request.metadata.env, annotations: request.metadata.annotations });
    }
    unexpected.push(`${req.method} ${url.pathname}`);
    return send(404, { success: false, errors: [{ code: 10000, message: 'not part of the fake' }], result: null });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}/client/v4`, requests, unexpected };
}

async function previewRun(t, { appDir, wranglerConfig, d1Input, vars }) {
  const work = tempDir(t);
  const bundleDir = path.join(work, 'bundle');
  bundle({ appDir, wranglerConfig, d1Input, outDir: bundleDir });
  const loaded = loadBundle(bundleDir);
  const d1 = Object.fromEntries(
    Object.entries(JSON.parse(d1Input)).map(([binding, spec]) => [
      binding,
      {
        database_name: spec.database_name,
        database_id: databaseId,
        migrations_dir: spec.migrations_dir ? path.join(loaded.filesDir, spec.migrations_dir) : undefined,
      },
    ]),
  );
  const { config, dropped } = buildPreviewConfig(loaded.raw, {
    name: 'pr-preview-self-test',
    root: loaded.filesDir,
    configDir: path.dirname(loaded.configFile),
    outDir: bundleDir,
    d1,
    vars,
  });
  const configPath = path.join(bundleDir, 'wrangler.pr-preview.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const cf = await fakeCloudflare(t);
  const local = '127.0.0.1,localhost';
  const runWrangler = createWranglerRunner({
    token: 'test-token',
    accountId,
    tempDir: work,
    extraEnv: { CLOUDFLARE_API_BASE_URL: cf.base, NO_PROXY: local, no_proxy: local },
  });
  const result = await runWrangler(['preview', '--config', configPath, '--name', 'pr-1', '--message', 'PR #1 at abc1234', '--ignore-base-config']);
  const create = cf.requests.find((request) => request.method === 'POST' && request.path.endsWith('/previews'));
  const deployment = cf.requests.find((request) => request.metadata);
  return { ...result, config, dropped, cf, create, deployment };
}

test('the fixture becomes a preview with only the preview bindings', { skip, timeout: 120_000 }, async (t) => {
  const app = path.join(tempDir(t), 'fixture');
  cpSync(path.join(here, 'fixture'), app, { recursive: true, filter: (source) => !source.includes(`${path.sep}dist`) });
  execFileSync(process.execPath, ['build.mjs'], { cwd: app, env: { ...process.env, GITHUB_SHA: 'abc1234def' }, stdio: 'ignore' });

  const run = await previewRun(t, {
    appDir: app,
    wranglerConfig: 'dist/worker/wrangler.json',
    d1Input: '{"DB":{"database_name":"pr-preview-self-test","migrations_dir":"migrations"}}',
    vars: { GREETING: 'from the preview' },
  });
  assert.equal(run.code, 0, run.tail);
  assert.deepEqual(run.cf.unexpected, []);
  assert.deepEqual(run.dropped.sort(), ['build.command', 'routes']);

  // A new Preview, created without the Previews settings from the dashboard.
  assert.equal(run.create.query.get('ignore_base_config'), 'true');
  assert.equal(JSON.parse(run.create.body.toString('utf8')).name, 'pr-1');

  // Its deployment gets the preview's variable and database, the assets and nothing else.
  const { metadata, files } = run.deployment;
  assert.deepEqual(metadata.env, {
    GREETING: { type: 'plain_text', text: 'from the preview' },
    DB: { type: 'd1', database_id: databaseId, database_name: 'pr-preview-self-test' },
    ASSETS: { type: 'assets' },
  });
  assert.equal(metadata.main_module, 'index.js');
  // Wrangler sends the assets' _headers file along with the code.
  assert.deepEqual(files, ['index.js', '_headers']);
  assert.equal(metadata.compatibility_date, '2026-09-01');
  assert.equal(metadata.assets.jwt, 'assets-jwt');
  assert.equal(metadata.annotations['workers/message'], 'PR #1 at abc1234');
  assert.doesNotMatch(JSON.stringify(metadata), /which previews must not get|example\.com|this must never run/);

  const entry = run.entries.find((e) => e.type === 'preview');
  assert.deepEqual(entry.preview_urls, ['https://pr-1-pr-preview-self-test.acme.workers.dev']);
  assert.equal(entry.deployment_id, 'deployment-1');
  assert.deepEqual(entry.deployment_urls, ['https://deployment-1-pr-preview-self-test.acme.workers.dev']);
});

test('a config written by the Cloudflare Vite plugin for vinext becomes a preview too', { skip, timeout: 120_000 }, async (t) => {
  const app = tempDir(t);
  mkdirSync(path.join(app, 'dist/server'), { recursive: true });
  mkdirSync(path.join(app, 'dist/client'), { recursive: true });
  mkdirSync(path.join(app, 'drizzle'), { recursive: true });
  cpSync(path.join(here, 'data', 'vinext-wrangler.json'), path.join(app, 'dist/server/wrangler.json'));
  writeFileSync(path.join(app, 'dist/server/index.js'), 'export default { fetch: (request, env) => env.ASSETS.fetch(request) };\n');
  writeFileSync(path.join(app, 'dist/client/index.html'), '<h1>app</h1>\n');
  writeFileSync(path.join(app, 'drizzle/0000_init.sql'), 'CREATE TABLE t (id INTEGER);\n');

  const run = await previewRun(t, {
    appDir: app,
    wranglerConfig: 'dist/server/wrangler.json',
    d1Input: '{"DB":{"database_name":"app-preview","migrations_dir":"drizzle"}}',
    vars: {},
  });
  assert.equal(run.code, 0, run.tail);
  assert.deepEqual(run.cf.unexpected, []);
  assert.deepEqual(run.dropped, []);
  assert.deepEqual(run.deployment.metadata.env, { DB: { type: 'd1', database_id: databaseId, database_name: 'app-preview' } });
});
