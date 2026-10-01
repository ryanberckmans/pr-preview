// The deploy job's main step, the only one with the Cloudflare token. It runs
// pr-preview's own pinned Wrangler on the collected build output; none of the
// repo's code runs here.
//
// Private previews fail closed: nothing is uploaded unless the Worker's workers.dev
// address and its Preview URLs already redirect to Cloudflare Access, and the new
// link is checked again after the upload.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UserError,
  checkHostLength,
  clean,
  errorMessage,
  isMain,
  log,
  main,
  parseD1Input,
  parseVarsInput,
  patterns,
  readEnv,
  resolveUnder,
  setOutputs,
  sleep as defaultSleep,
} from './lib/common.mjs';
import { CloudflareApiError, createCloudflare, explainCloudflareError } from './lib/cloudflare.mjs';
import { probeGate } from './lib/gate.mjs';
import { parseJsonc } from './lib/jsonc.mjs';
import { buildPreviewConfig } from './lib/wrangler-config.mjs';

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKERS_DEV_URL = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\/?$/;
const PREVIEW_SUFFIX = /^-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/;
const TRANSIENT = /\b(5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|timed? ?out|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i;

export function readInputs(env) {
  const visibility = readEnv(env, 'PLAN_VISIBILITY');
  if (visibility !== 'private' && visibility !== 'public') throw new UserError('The plan step reported no visibility.');
  const worker = readEnv(env, 'PLAN_WORKER');
  const alias = readEnv(env, 'PLAN_ALIAS');
  const mainAlias = readEnv(env, 'PLAN_MAIN_ALIAS');
  if (!patterns.workerName.test(worker)) throw new UserError('The plan step reported an invalid Worker name.');
  if (!patterns.alias.test(alias) || !patterns.alias.test(mainAlias)) throw new UserError('The plan step reported an invalid alias.');
  checkHostLength(alias, worker);
  checkHostLength(mainAlias, worker);
  const sha = readEnv(env, 'PLAN_SHA');
  if (!patterns.sha.test(sha)) throw new UserError('The plan step reported an invalid commit SHA.');
  const prNumber = readEnv(env, 'PLAN_PR_NUMBER');
  if (prNumber && !patterns.prNumber.test(prNumber)) throw new UserError('The plan step reported an invalid PR number.');
  const teamDomain = readEnv(env, 'PLAN_TEAM_DOMAIN');
  if (teamDomain && !patterns.teamDomain.test(teamDomain)) throw new UserError('access-team-domain must look like <team>.cloudflareaccess.com.');
  return {
    token: readEnv(env, 'CLOUDFLARE_API_TOKEN'),
    accountId: readEnv(env, 'CLOUDFLARE_ACCOUNT_ID'),
    visibility,
    worker,
    alias,
    mainAlias,
    sha,
    prNumber,
    teamDomain,
    d1: parseD1Input(readEnv(env, 'IN_D1')),
    vars: parseVarsInput(readEnv(env, 'IN_PREVIEW_VARS')),
    bundleDir: path.resolve(readEnv(env, 'BUNDLE_DIR', { required: true })),
    tempDir: path.resolve(readEnv(env, 'RUNNER_TEMP') || path.join(TOOL_DIR, '.tmp')),
  };
}

// The artifact should hold only plain files and folders.
function checkNoLinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new UserError('The build output contains a symbolic link, which pr-preview refuses to upload.');
    if (entry.isDirectory()) checkNoLinks(full);
  }
}

export function loadBundle(bundleDir) {
  const filesDir = path.join(bundleDir, 'files');
  if (!existsSync(filesDir) || !lstatSync(filesDir).isDirectory()) throw new UserError('The build output from the build job is missing.');
  checkNoLinks(filesDir);
  const manifest = JSON.parse(readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
  const configFile = resolveUnder(filesDir, filesDir, manifest.config, 'The collected Wrangler config');
  if (!existsSync(configFile)) throw new UserError('The collected Wrangler config is missing.');
  let raw;
  try {
    raw = parseJsonc(readFileSync(configFile, 'utf8'));
  } catch (error) {
    throw new UserError(`The collected Wrangler config isn't valid JSON: ${clean(error.message)}`);
  }
  return { filesDir, configFile, raw };
}

// Runs pr-preview's pinned Wrangler with a minimal environment, from an empty
// folder (Wrangler loads .env files from its working folder) and with GitHub
// workflow commands paused, since its output echoes file and binding names.
export function createWranglerRunner({ token, accountId, tempDir }) {
  const bin = path.join(TOOL_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const cwd = path.join(tempDir, 'pr-preview-wrangler');
  mkdirSync(cwd, { recursive: true });
  const emptyEnvFile = path.join(cwd, 'empty.env');
  writeFileSync(emptyEnvFile, '');
  let counter = 0;

  return async function runWrangler(args) {
    counter += 1;
    const outputFile = path.join(cwd, `output-${counter}.ndjson`);
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? cwd,
      TMPDIR: tempDir,
      CI: 'true',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_OUTPUT_FILE_PATH: outputFile,
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    };
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const pause = randomBytes(16).toString('hex');
    console.log(`::stop-commands::${pause}`);
    let tail = '';
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args, '--env-file', emptyEnvFile], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const keep = (chunk, stream) => {
        stream.write(chunk);
        tail = (tail + chunk.toString('utf8')).slice(-20_000);
      };
      child.stdout.on('data', (chunk) => keep(chunk, process.stdout));
      child.stderr.on('data', (chunk) => keep(chunk, process.stderr));
      child.on('error', reject);
      child.on('close', resolve);
    }).finally(() => console.log(`::${pause}::`));
    const entries = existsSync(outputFile)
      ? readFileSync(outputFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
      : [];
    return { code, tail, entries };
  };
}

// Wrangler's own error lines, for the message on the PR.
export function wranglerError(tail) {
  const lines = tail.split('\n').map((line) => line.trim());
  const errors = lines.filter((line) => /^(✘|X) \[ERROR\]/.test(line)).map((line) => line.replace(/^(✘|X) \[ERROR\]\s*/, ''));
  return clean(errors.join(' ') || lines.filter(Boolean).slice(-1)[0] || 'unknown error', 300);
}

async function wranglerOrThrow(runWrangler, args, what, { retries = 0, retryIf = () => true, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await runWrangler(args);
    if (result.code === 0) return result;
    if (attempt < retries && retryIf(result.tail)) {
      log.warning(`Wrangler failed while ${what}; trying again.`);
      await sleep(10_000);
      continue;
    }
    throw new UserError(`Wrangler failed while ${what}: ${wranglerError(result.tail)}`);
  }
}

function hostUrl(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

export async function deploy(inputs, { fetch = globalThis.fetch, sleep = defaultSleep, runWrangler } = {}) {
  const { worker, visibility, teamDomain, alias, mainAlias } = inputs;
  const isPrivate = visibility === 'private';
  const bundle = loadBundle(inputs.bundleDir);
  const configDir = path.dirname(bundle.configFile);
  const outDir = inputs.bundleDir;
  const d1Paths = (ids) =>
    Object.fromEntries(
      Object.entries(inputs.d1).map(([binding, spec]) => [
        binding,
        {
          database_name: spec.database_name,
          database_id: ids[binding],
          migrations_dir: spec.migrations_dir
            ? resolveUnder(bundle.filesDir, bundle.filesDir, spec.migrations_dir, `d1.${binding}.migrations_dir`)
            : undefined,
        },
      ]),
    );
  const configOptions = { name: worker, root: bundle.filesDir, configDir, outDir, vars: inputs.vars };

  // Check the config before touching Cloudflare.
  const { dropped } = buildPreviewConfig(bundle.raw, { ...configOptions, d1: d1Paths({}) });
  if (dropped.length > 0) log.info(`Not carried into the preview: ${dropped.map((key) => clean(key, 40)).join(', ')}.`);
  for (const [binding, spec] of Object.entries(d1Paths({}))) {
    if (spec.migrations_dir && !(existsSync(spec.migrations_dir) && statSync(spec.migrations_dir).isDirectory())) {
      throw new UserError(`The migrations folder for d1.${binding} wasn't in the build output.`);
    }
  }

  const cf = createCloudflare({ token: inputs.token, accountId: inputs.accountId, fetch, sleep });
  const step = async (what, fn) => {
    try {
      return await fn();
    } catch (error) {
      throw explainCloudflareError(error, what);
    }
  };

  const subdomain = await step('reading the workers.dev subdomain', () => cf.accountSubdomain());
  if (!subdomain) {
    throw new UserError('This Cloudflare account has no workers.dev subdomain yet. Open Workers & Pages in the Cloudflare dashboard once to choose one, then re-run.');
  }

  let info = await step(`looking up the Worker ${worker}`, () => cf.worker(worker));
  if (!info) {
    log.info(`Creating the Worker ${worker} with a placeholder that answers 404.`);
    await wranglerOrThrow(
      runWrangler,
      ['deploy', '--config', path.join(TOOL_DIR, 'placeholder', 'wrangler.json'), '--name', worker],
      `creating the Worker ${worker}`,
      { retries: 1, retryIf: (tail) => TRANSIENT.test(tail), sleep },
    );
    for (let attempt = 0; attempt < 6 && !info; attempt += 1) {
      if (attempt > 0) await sleep(2000);
      info = await step(`looking up the Worker ${worker}`, () => cf.worker(worker));
    }
    if (!info) throw new UserError(`Created the Worker ${worker}, but Cloudflare doesn't list it yet. Re-run in a minute.`);
    if (isPrivate) {
      throw new UserError(
        `pr-preview created the Worker ${worker} on Cloudflare. Turn on Cloudflare Access for its workers.dev and Preview URLs and allow only your email, then re-run this workflow.`,
        { status: 'needs-access' },
      );
    }
  }
  if (!info.enabled || !info.previewsEnabled) {
    log.info(`Turning on workers.dev and Preview URLs for ${worker}.`);
    await step(`turning on Preview URLs for ${worker}`, () => cf.enableSubdomain(worker));
    info = (await step(`looking up the Worker ${worker}`, () => cf.worker(worker))) ?? info;
  }

  const suffix = info.previewUrlSuffix && PREVIEW_SUFFIX.test(info.previewUrlSuffix) ? info.previewUrlSuffix : `-${worker}.${subdomain}.workers.dev`;
  const workersDevUrl = info.url && WORKERS_DEV_URL.test(info.url) ? hostUrl(info.url) : `https://${worker}.${subdomain}.workers.dev/`;
  const aliasUrl = `https://${alias}${suffix}/`;
  const mainUrl = `https://${mainAlias}${suffix}/`;

  const requireGate = async (url, label, attempts) => {
    const verdict = await probeGate(url, { teamDomain, fetch, sleep, attempts });
    log.info(`Sign-in check, ${label}: ${verdict.reason}.`);
    if (!verdict.gated) {
      throw new UserError(`The ${label} of ${worker} ${verdict.reason}, so it isn't behind Cloudflare Access.`, { status: 'gate-off' });
    }
  };

  if (isPrivate) {
    await requireGate(workersDevUrl, 'workers.dev address', 3);
    const deployed = await step(`reading the deployments of ${worker}`, () => cf.deployedVersionId(worker));
    if (deployed && /^[0-9a-f]{8}/.test(deployed)) await requireGate(`https://${deployed.slice(0, 8)}${suffix}/`, 'Preview URLs', 3);
    else await requireGate(aliasUrl, 'Preview URLs', 3);
  }

  const ids = {};
  for (const [binding, spec] of Object.entries(inputs.d1)) {
    if (spec.database_id) {
      ids[binding] = spec.database_id;
      continue;
    }
    const found = await step(`looking up the D1 database ${spec.database_name}`, () => cf.findD1(spec.database_name));
    const db = found ?? (await step(`creating the D1 database ${spec.database_name}`, () => cf.createD1(spec.database_name)));
    if (!db || !patterns.uuid.test(db.uuid ?? '')) throw new UserError(`Couldn't find or create the D1 database ${spec.database_name}.`);
    if (!found) log.info(`Created the D1 database ${spec.database_name}.`);
    ids[binding] = db.uuid;
  }

  const { config } = buildPreviewConfig(bundle.raw, { ...configOptions, d1: d1Paths(ids) });
  const configPath = path.join(outDir, 'wrangler.pr-preview.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  for (const entry of config.d1_databases) {
    if (!entry.migrations_dir) continue;
    await wranglerOrThrow(
      runWrangler,
      ['d1', 'migrations', 'apply', entry.binding, '--remote', '--config', configPath],
      `applying D1 migrations to ${entry.database_name}`,
      { retries: 1, sleep },
    );
  }

  const label = inputs.prNumber ? `PR #${inputs.prNumber}` : mainAlias;
  const upload = await wranglerOrThrow(
    runWrangler,
    ['versions', 'upload', '--config', configPath, '--preview-alias', alias, '--message', `${label} at ${inputs.sha.slice(0, 7)}`],
    'uploading the preview',
    { retries: 1, retryIf: (tail) => TRANSIENT.test(tail), sleep },
  );
  const result = upload.entries.filter((entry) => entry?.type === 'version-upload').pop();
  const versionId = result?.version_id;
  if (typeof versionId !== 'string' || !/^[0-9a-f-]{8,}$/.test(versionId)) throw new UserError('Wrangler finished without reporting the new version.');
  const versionUrl = typeof result.preview_url === 'string' && WORKERS_DEV_URL.test(result.preview_url) ? hostUrl(result.preview_url) : undefined;
  if (!result.preview_alias_url) {
    throw new UserError(`Cloudflare didn't create a preview link for version ${versionId.slice(0, 8)}. Check that Preview URLs are on for ${worker}.`);
  }
  if (hostUrl(result.preview_alias_url) !== aliasUrl) {
    log.warning(`Wrangler reported the link ${clean(result.preview_alias_url)} instead of ${aliasUrl}; using Wrangler's.`);
  }
  const url = WORKERS_DEV_URL.test(result.preview_alias_url) ? hostUrl(result.preview_alias_url) : aliasUrl;

  if (isPrivate) {
    await requireGate(url, 'new preview link', 6);
    if (versionUrl) await requireGate(versionUrl, 'new version link', 6);
  }

  return { status: 'deployed', url, 'main-url': mainUrl, 'version-id': versionId, 'version-url': versionUrl ?? '', worker, visibility };
}

if (isMain(import.meta.url)) {
  await main(async () => {
    let inputs;
    try {
      inputs = readInputs(process.env);
      const runWrangler = createWranglerRunner(inputs);
      const outputs = await deploy(inputs, { runWrangler });
      setOutputs(outputs);
      log.info(`Preview ready: ${outputs.url} (${outputs.visibility}).`);
    } catch (error) {
      const status = error instanceof UserError ? error.status : 'error';
      const message = error instanceof UserError || error instanceof CloudflareApiError ? error.message : `Unexpected error: ${errorMessage(error)}`;
      setOutputs({ status, message: clean(message, 600) });
      throw error;
    }
  });
}
