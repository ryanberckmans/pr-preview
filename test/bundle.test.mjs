import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bundle } from '../scripts/bundle.mjs';
import { tempDir } from './helpers.mjs';

const d1 = '{"DB":{"database_name":"app-preview","migrations_dir":"drizzle"}}';

// An app after its build, laid out the way the Cloudflare Vite plugin writes it.
function makeApp(t, config = {}) {
  const app = tempDir(t);
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    writeFileSync(path.join(app, file), text);
  };
  write('src/secret.ts', 'source the upload never needs');
  write('dist/server/index.js', 'export default {};\n');
  write('dist/server/ssr/chunk.js', 'export const x = 1;\n');
  write('dist/client/index.html', '<h1>app</h1>\n');
  write('dist/client/.well-known/security.txt', 'Contact: mailto:ryan@example.com\n');
  write('dist/client/_headers', '/*\n  X-Frame-Options: DENY\n');
  write('drizzle/0000_init.sql', 'CREATE TABLE t (id INTEGER);\n');
  write(
    'dist/server/wrangler.json',
    JSON.stringify({ name: 'app', main: 'index.js', no_bundle: true, assets: { directory: '../client' }, ...config }),
  );
  return app;
}

function run(t, app, overrides = {}) {
  const outDir = path.join(tempDir(t), 'bundle');
  const result = bundle({ appDir: app, wranglerConfig: 'dist/server/wrangler.json', d1Input: d1, outDir, ...overrides });
  return { outDir, result };
}

test('collects the config, the built Worker, its assets and migrations, and nothing else', (t) => {
  const { outDir, result } = run(t, makeApp(t));
  assert.equal(result.config, 'dist/server/wrangler.json');
  assert.equal(result.files, 7);
  const files = path.join(outDir, 'files');
  for (const file of ['dist/server/index.js', 'dist/server/ssr/chunk.js', 'dist/client/index.html', 'dist/client/.well-known/security.txt', 'dist/client/_headers', 'drizzle/0000_init.sql']) {
    assert.ok(existsSync(path.join(files, file)), file);
  }
  assert.equal(existsSync(path.join(files, 'src')), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8')), { version: 1, config: 'dist/server/wrangler.json' });
});

test('a TOML config is refused with a pointer to JSON', (t) => {
  const app = makeApp(t);
  writeFileSync(path.join(app, 'wrangler.toml'), 'name = "app"\n');
  assert.throws(() => run(t, app, { wranglerConfig: 'wrangler.toml' }), /TOML file/);
});

test('a missing or unreadable config is explained', (t) => {
  const app = makeApp(t);
  assert.throws(() => run(t, app, { wranglerConfig: 'dist/missing.json' }), /doesn't exist after the build/);
  writeFileSync(path.join(app, 'dist/server/wrangler.json'), '{ "name": ');
  assert.throws(() => run(t, app), /isn't valid JSON/);
});

test('paths outside the project are refused', (t) => {
  const app = makeApp(t);
  assert.throws(() => run(t, app, { wranglerConfig: '../wrangler.json' }), /wrangler-config/);
  assert.throws(() => run(t, makeApp(t, { assets: { directory: '../../../elsewhere' } })), /outside/);
  assert.throws(() => run(t, app, { d1Input: '{"DB":{"database_name":"x","migrations_dir":"../up"}}' }), /migrations_dir/);
});

test('a config that needs bundling is refused', (t) => {
  assert.throws(() => run(t, makeApp(t, { no_bundle: false })), /no_bundle/);
});

test('a missing migrations folder is explained', (t) => {
  assert.throws(() => run(t, makeApp(t), { d1Input: '{"DB":{"database_name":"x","migrations_dir":"migrations"}}' }), /isn't a folder/);
});

test('links are followed inside the project and refused outside it', (t) => {
  const inside = makeApp(t);
  symlinkSync(path.join(inside, 'dist/client/index.html'), path.join(inside, 'dist/client/copy.html'));
  const { outDir } = run(t, inside);
  assert.equal(readFileSync(path.join(outDir, 'files/dist/client/copy.html'), 'utf8'), '<h1>app</h1>\n');

  const outside = makeApp(t);
  const secret = path.join(tempDir(t), 'id_rsa');
  writeFileSync(secret, 'private key');
  symlinkSync(secret, path.join(outside, 'dist/client/key.txt'));
  assert.throws(() => run(t, outside), /link to a file outside the project/);
});

test('a link back to a parent folder does not loop', (t) => {
  const app = makeApp(t);
  symlinkSync(path.join(app, 'dist/client'), path.join(app, 'dist/client/again'));
  const { result } = run(t, app);
  assert.equal(result.files, 7);
});
