// Builds the Wrangler config for a preview upload from the config the build wrote.
// The preview gets the build's code and assets, the D1 databases in the `d1` input,
// the variables in `preview-vars`, and nothing else.
import path from 'node:path';
import { UserError, clean, isPlainObject, resolveUnder, toPosix } from './common.mjs';

// Kept as written: settings that shape how the Worker runs or is packaged.
const KEEP = new Set([
  'compatibility_date',
  'compatibility_flags',
  'limits',
  'placement',
  'observability',
  'cache',
  'rules',
  'find_additional_modules',
  'preserve_file_names',
  'python_modules',
  'version_metadata',
  'minify',
  'keep_names',
  'define',
  'alias',
  'jsx_factory',
  'jsx_fragment',
]);

// Set by pr-preview, whatever the build wrote.
const REPLACED = new Set([
  'name',
  'main',
  'base_dir',
  'no_bundle',
  'assets',
  'vars',
  'd1_databases',
  'workers_dev',
  'preview_urls',
  'keep_vars',
  'send_metrics',
  'dependencies_instrumentation',
  // Wrangler follows each sourceMappingURL to a file, even outside the build output.
  'upload_source_maps',
]);

// Dropped without comment: Wrangler's bookkeeping, settings for local tools, and
// fields newer Wranglers reject (generated configs still carry legacy_env).
// `build` is dropped so Wrangler never runs a build command next to the Cloudflare
// token; it is only reported when it has a command.
const SILENT = new Set([
  'configPath',
  'userConfigPath',
  'topLevelName',
  'definedEnvironments',
  'targetEnvironment',
  '$schema',
  'dev',
  'tsconfig',
  'build',
  'legacy_env',
  'node_compat',
]);

// Everything else not listed is dropped and reported when set: deploy targets,
// account settings, non-versioned settings, and keys newer than these lists.
// Dropping an unknown key can't give a preview access to anything.

// Bindings and features a preview can't be given. The upload stops if any is in use.
const UNSUPPORTED = new Set([
  'kv_namespaces',
  'r2_buckets',
  'durable_objects',
  'queues',
  'connect',
  'services',
  'analytics_engine_datasets',
  'hyperdrive',
  'vectorize',
  'ai',
  'ai_search_namespaces',
  'ai_search',
  'agent_memory',
  'artifacts',
  'browser',
  'images',
  'stream',
  'media',
  'send_email',
  'mtls_certificates',
  'dispatch_namespaces',
  'pipelines',
  'secrets_store_secrets',
  'workflows',
  'logfwdr',
  'ratelimits',
  'worker_loaders',
  'vpc_services',
  'vpc_networks',
  'unsafe_hello_world',
  'flagship',
  'unsafe',
  'migrations',
  'exports',
  'containers',
  'cloudchamber',
  'site',
  'wasm_modules',
  'text_blobs',
  'data_blobs',
  'pages_build_output_dir',
]);

export function isEmptyValue(value) {
  if (value === undefined || value === null || value === false || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.values(value).every(isEmptyValue);
  return false;
}

// Paths in the build's config are relative to the config file. `root` is the
// project folder; nothing may point outside it.
export function buildOutputPaths(raw, { root, configDir }) {
  const paths = {};
  if (raw.main !== undefined) {
    if (typeof raw.main !== 'string') throw new UserError('main in the Wrangler config must be a path.');
    if (raw.no_bundle !== true) {
      throw new UserError(
        'The Wrangler config sets main without no_bundle: true. pr-preview uploads Workers that the build has already bundled, as the Cloudflare Vite plugin does. Point wrangler-config at the generated config, or bundle in build-command and set no_bundle.',
      );
    }
    paths.main = resolveUnder(root, configDir, raw.main, 'main in the Wrangler config');
    paths.baseDir =
      raw.base_dir === undefined
        ? path.dirname(paths.main)
        : resolveUnder(root, configDir, raw.base_dir, 'base_dir in the Wrangler config');
    if (paths.baseDir === root) {
      throw new UserError("The built Worker's folder is the project root. pr-preview needs build output in its own folder, such as dist/.");
    }
  }
  if (raw.assets !== undefined && !isPlainObject(raw.assets)) throw new UserError('assets in the Wrangler config must be an object.');
  if (raw.assets?.directory !== undefined) {
    paths.assets = resolveUnder(root, configDir, raw.assets.directory, 'assets.directory in the Wrangler config');
    if (paths.assets === root) {
      throw new UserError('assets.directory is the project root. pr-preview needs build output in its own folder, such as dist/.');
    }
  }
  if (!paths.main && !paths.assets) {
    throw new UserError('The Wrangler config has neither main nor assets.directory, so there is nothing to upload.');
  }
  return paths;
}

// Returns { config, dropped }. `d1` maps each binding to { database_name,
// database_id, migrations_dir } with migrations_dir already absolute. Paths in the
// result are relative to `outDir`, where the config will be written.
export function buildPreviewConfig(raw, { name, root, configDir, outDir, d1, vars }) {
  if (!isPlainObject(raw)) throw new UserError('The Wrangler config must be a JSON object.');

  const unsupported = [];
  const dropped = [];
  const config = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'upload_source_maps' && value) dropped.push(key);
    if (REPLACED.has(key)) continue;
    if (KEEP.has(key)) config[key] = structuredClone(value);
    else if (UNSUPPORTED.has(key)) {
      if (!isEmptyValue(value)) unsupported.push(key);
    } else if (key === 'build') {
      if (typeof value?.command === 'string' && value.command.trim()) dropped.push('build.command');
    } else if (!SILENT.has(key) && !isEmptyValue(value)) {
      dropped.push(key);
    }
  }
  if (unsupported.length > 0) {
    throw new UserError(
      `The Wrangler config uses ${unsupported.map((k) => clean(k, 40)).join(', ')}, which pr-preview can't give a preview. Previews get only the D1 databases in the d1 input and the variables in preview-vars.`,
    );
  }

  const configured = Array.isArray(raw.d1_databases) ? raw.d1_databases : [];
  for (const entry of configured) {
    if (!isPlainObject(entry) || typeof entry.binding !== 'string') throw new UserError('d1_databases in the Wrangler config has an entry without a binding.');
    if (!d1[entry.binding]) {
      throw new UserError(
        `The Wrangler config binds the D1 database ${clean(entry.binding, 40)}, but the d1 input doesn't map it to a preview database.`,
      );
    }
  }

  const paths = buildOutputPaths(raw, { root, configDir });
  const rel = (abs) => toPosix(path.relative(outDir, abs)) || '.';

  config.name = name;
  if (paths.main) {
    config.main = rel(paths.main);
    config.base_dir = rel(paths.baseDir);
    config.no_bundle = true;
  }
  if (raw.assets !== undefined) {
    config.assets = structuredClone(raw.assets);
    if (paths.assets) config.assets.directory = rel(paths.assets);
  }
  config.vars = { ...vars };
  config.d1_databases = Object.entries(d1).map(([binding, spec]) => {
    const original = configured.find((entry) => entry.binding === binding);
    return {
      binding,
      database_name: spec.database_name,
      database_id: spec.database_id,
      ...(spec.migrations_dir ? { migrations_dir: rel(spec.migrations_dir) } : {}),
      ...(typeof original?.migrations_table === 'string' ? { migrations_table: original.migrations_table } : {}),
    };
  });
  config.workers_dev = true;
  config.preview_urls = true;
  config.keep_vars = false;
  config.upload_source_maps = false;
  config.send_metrics = false;
  config.dependencies_instrumentation = { enabled: false };
  return { config, dropped, paths };
}
