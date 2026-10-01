// Runs in the build job after the build. Copies what the upload needs (the
// Wrangler config, the built Worker, its assets and D1 migrations) into one folder
// that is handed to the deploy job, which never runs the repo's code.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UserError, clean, isInside, isMain, log, main, parseD1Input, readEnv, resolveUnder, toPosix } from './lib/common.mjs';
import { parseJsonc } from './lib/jsonc.mjs';
import { buildOutputPaths } from './lib/wrangler-config.mjs';

const MAX_FILES = 30_000;
const MAX_BYTES = 300 * 1024 * 1024;

export function readWranglerConfig(file, label) {
  if (/\.toml$/i.test(file)) {
    throw new UserError(`${label} is a TOML file. pr-preview reads JSON configs (wrangler.json or wrangler.jsonc), such as the one the Cloudflare Vite plugin writes.`);
  }
  try {
    return parseJsonc(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UserError(`${label} isn't valid JSON: ${clean(error.message, 200)}`);
  }
}

// Copies `source` (a file or folder inside `root`) to the same relative place under
// `dest`. Symlinks are followed only when they stay inside `root`.
function copyInto(root, source, dest, totals) {
  const stack = [source];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    let stat = lstatSync(current);
    let real = current;
    if (stat.isSymbolicLink()) {
      real = realpathSync(current);
      if (!isInside(root, real)) throw new UserError(`${toPosix(path.relative(root, current))} is a link to a file outside the project.`);
      stat = statSync(real);
    }
    const target = path.join(dest, path.relative(root, current));
    if (stat.isDirectory()) {
      const key = realpathSync(real);
      if (seen.has(key)) continue;
      seen.add(key);
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(real)) stack.push(path.join(current, entry));
    } else if (stat.isFile()) {
      // The config file usually sits in the Worker's folder, so it comes up twice.
      if (totals.copied.has(target)) continue;
      totals.copied.add(target);
      totals.files += 1;
      totals.bytes += stat.size;
      if (totals.files > MAX_FILES || totals.bytes > MAX_BYTES) {
        throw new UserError(`The build output is over ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB; check that wrangler-config points at the build output.`);
      }
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(real, target);
    }
  }
}

export function bundle({ appDir, wranglerConfig, d1Input, outDir }) {
  const root = realpathSync(appDir);
  const configFile = resolveUnder(root, root, wranglerConfig, 'wrangler-config');
  if (!existsSync(configFile)) {
    throw new UserError(`wrangler-config (${clean(wranglerConfig)}) doesn't exist after the build. Check build-command and the path.`);
  }
  const raw = readWranglerConfig(configFile, `wrangler-config (${clean(wranglerConfig)})`);
  const paths = buildOutputPaths(raw, { root, configDir: path.dirname(configFile) });
  const sources = [configFile, paths.baseDir, paths.assets];
  for (const [binding, spec] of Object.entries(parseD1Input(d1Input))) {
    if (!spec.migrations_dir) continue;
    const dir = resolveUnder(root, root, spec.migrations_dir, `d1.${binding}.migrations_dir`);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UserError(`d1.${binding}.migrations_dir (${clean(spec.migrations_dir)}) isn't a folder.`);
    sources.push(dir);
  }

  rmSync(outDir, { recursive: true, force: true });
  const filesDir = path.join(outDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  const totals = { files: 0, bytes: 0, copied: new Set() };
  for (const source of sources.filter(Boolean)) {
    if (!existsSync(source)) throw new UserError(`${toPosix(path.relative(root, source))}, named in the Wrangler config, doesn't exist after the build.`);
    copyInto(root, source, filesDir, totals);
  }
  const manifest = { version: 1, config: toPosix(path.relative(root, configFile)) };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, files: totals.files, bytes: totals.bytes };
}

if (isMain(import.meta.url)) {
  await main(async () => {
    const result = bundle({
      appDir: readEnv(process.env, 'APP_DIR', { required: true }),
      wranglerConfig: readEnv(process.env, 'IN_WRANGLER_CONFIG', { required: true }),
      d1Input: readEnv(process.env, 'IN_D1'),
      outDir: readEnv(process.env, 'BUNDLE_DIR', { required: true }),
    });
    log.info(`Collected ${result.files} files (${(result.bytes / 1024 / 1024).toFixed(1)} MB) for the upload, with config ${result.config}.`);
  });
}
