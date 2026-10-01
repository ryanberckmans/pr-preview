// Writes a pre-built Worker the way the Cloudflare Vite plugin does: the code and a
// generated wrangler.json in dist/worker, and static assets in dist/assets.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const commit = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/worker', { recursive: true });
cpSync('public', 'dist/assets', { recursive: true });
writeFileSync('dist/assets/index.html', readFileSync('public/index.html', 'utf8').replace('__COMMIT__', commit));
cpSync('src/worker.js', 'dist/worker/index.js');
const config = {
  name: 'pr-preview-fixture',
  main: 'index.js',
  no_bundle: true,
  rules: [{ type: 'ESModule', globs: ['**/*.js'] }],
  compatibility_date: '2026-09-01',
  assets: { directory: '../assets', binding: 'ASSETS' },
  d1_databases: [{ binding: 'DB', database_name: 'fixture', database_id: '00000000-0000-4000-8000-000000000000' }],
  vars: { GREETING: 'from the build, which previews must not get' },
  routes: [{ pattern: 'example.com/*', zone_name: 'example.com' }],
  build: { command: 'echo this must never run' },
  dev: { port: 8787 },
  observability: { enabled: true },
};
writeFileSync('dist/worker/wrangler.json', `${JSON.stringify(config, null, 2)}\n`);
console.log(`Built the fixture for ${commit}.`);
