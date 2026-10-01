// Runs pr-preview's pinned Wrangler on collected build output, as a dry run: it
// checks the config pr-preview writes is one Wrangler accepts, with only the
// bindings a preview should have. Needs `npm ci` first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

async function dryRun(t, { appDir, wranglerConfig, d1Input, vars }) {
  const work = tempDir(t);
  const bundleDir = path.join(work, 'bundle');
  bundle({ appDir, wranglerConfig, d1Input, outDir: bundleDir });
  const loaded = loadBundle(bundleDir);
  const d1 = Object.fromEntries(
    Object.entries(JSON.parse(d1Input)).map(([binding, spec]) => [
      binding,
      {
        database_name: spec.database_name,
        database_id: '11111111-2222-4333-8444-555555555555',
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
  const outDir = path.join(work, 'out');
  const runWrangler = createWranglerRunner({ token: '', accountId: '', tempDir: work });
  const result = await runWrangler(['versions', 'upload', '--config', configPath, '--preview-alias', 'pr-1', '--message', 'PR #1 at abc1234', '--dry-run', '--outdir', outDir]);
  return { ...result, config, dropped, outDir };
}

test('the fixture uploads with only the preview bindings', { skip, timeout: 120_000 }, async (t) => {
  const app = path.join(tempDir(t), 'fixture');
  cpSync(path.join(here, 'fixture'), app, { recursive: true, filter: (source) => !source.includes(`${path.sep}dist`) });
  execFileSync(process.execPath, ['build.mjs'], { cwd: app, env: { ...process.env, GITHUB_SHA: 'abc1234def' }, stdio: 'ignore' });

  const run = await dryRun(t, {
    appDir: app,
    wranglerConfig: 'dist/worker/wrangler.json',
    d1Input: '{"DB":{"database_name":"pr-preview-self-test","migrations_dir":"migrations"}}',
    vars: { GREETING: 'from the preview' },
  });
  assert.equal(run.code, 0, run.tail);
  const upload = run.entries.find((entry) => entry.type === 'version-upload');
  assert.equal(upload?.worker_name, 'pr-preview-self-test');
  assert.match(run.tail, /env\.DB \(pr-preview-self-test\)/);
  assert.match(run.tail, /env\.ASSETS/);
  assert.match(run.tail, /env\.GREETING \("from the preview"\)/);
  assert.doesNotMatch(run.tail, /which previews must not get|example\.com|this must never run/);
  assert.deepEqual(run.dropped.sort(), ['build.command', 'routes']);
  assert.match(readFileSync(path.join(run.outDir, 'index.js'), 'utf8'), /env\.ASSETS\.fetch/);
});

test('a config written by the Cloudflare Vite plugin for vinext uploads too', { skip, timeout: 120_000 }, async (t) => {
  const app = tempDir(t);
  mkdirSync(path.join(app, 'dist/server'), { recursive: true });
  mkdirSync(path.join(app, 'dist/client'), { recursive: true });
  mkdirSync(path.join(app, 'drizzle'), { recursive: true });
  cpSync(path.join(here, 'data', 'vinext-wrangler.json'), path.join(app, 'dist/server/wrangler.json'));
  writeFileSync(path.join(app, 'dist/server/index.js'), 'export default { fetch: (request, env) => env.ASSETS.fetch(request) };\n');
  writeFileSync(path.join(app, 'dist/client/index.html'), '<h1>app</h1>\n');
  writeFileSync(path.join(app, 'drizzle/0000_init.sql'), 'CREATE TABLE t (id INTEGER);\n');

  const run = await dryRun(t, {
    appDir: app,
    wranglerConfig: 'dist/server/wrangler.json',
    d1Input: '{"DB":{"database_name":"app-preview","migrations_dir":"drizzle"}}',
    vars: {},
  });
  assert.equal(run.code, 0, run.tail);
  assert.match(run.tail, /env\.DB \(app-preview\)/);
  assert.deepEqual(run.dropped, []);
});
