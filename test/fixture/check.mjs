// The fixture's check-command: confirms the build wrote what pr-preview needs.
import { existsSync } from 'node:fs';

const missing = ['dist/worker/index.js', 'dist/worker/wrangler.json', 'dist/assets/index.html'].filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`Missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('Fixture check passed.');
