// Helpers shared by the pr-preview scripts. Everything here runs on Node 18 or later,
// because some steps use the runner's preinstalled Node.
import { appendFileSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An expected failure, with a message written for the person who has to fix it.
// `status` travels to the PR comment so it can say what happened.
export class UserError extends Error {
  constructor(message, { status = 'error' } = {}) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

export const patterns = {
  // A Worker name becomes a DNS label: lowercase letters, digits and dashes.
  workerName: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  // Cloudflare's rule for preview aliases.
  alias: /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/,
  accountId: /^[0-9a-f]{32}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  teamDomain: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/,
  bindingName: /^[A-Za-z_][A-Za-z0-9_]*$/,
  d1Name: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  sha: /^[0-9a-f]{40}$/,
  prNumber: /^[1-9][0-9]{0,8}$/,
};

// DNS labels are at most 63 characters, and every preview host is "<alias>-<worker>".
export const MAX_LABEL = 63;

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Makes text from a build or a PR safe to print on one log line: no control
// characters (so nothing can start a new line that GitHub reads as a command) and
// a bounded length.
export function clean(value, max = 200) {
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Escapes data for a GitHub workflow command such as ::error::.
export function escapeCommandData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export const log = {
  info(message) {
    for (const line of String(message).split('\n')) {
      console.log(line.trimStart().startsWith('::') ? ` ${line}` : line);
    }
  },
  notice(message) {
    console.log(`::notice::${escapeCommandData(message)}`);
  },
  warning(message) {
    console.log(`::warning::${escapeCommandData(message)}`);
  },
  error(message) {
    console.log(`::error::${escapeCommandData(message)}`);
  },
};

// Writes step outputs. Each value gets its own random delimiter, so no value can
// end early and smuggle in another output.
export function setOutputs(outputs, file = process.env.GITHUB_OUTPUT) {
  let text = '';
  for (const [key, raw] of Object.entries(outputs)) {
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    const delimiter = `pr_preview_${randomBytes(16).toString('hex')}`;
    text += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  if (!text) return;
  if (file) appendFileSync(file, text);
  else for (const [key, value] of Object.entries(outputs)) if (value != null) log.info(`${key}=${value}`);
}

export function appendSummary(markdown, file) {
  if (file) appendFileSync(file, `${markdown}\n`);
}

export function readEnv(env, name, { required = false } = {}) {
  const value = (env[name] ?? '').trim();
  if (required && !value) throw new UserError(`${name} is empty.`);
  return value;
}

export function parseBoolean(value, label) {
  if (value === '' || value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new UserError(`${label} must be true or false.`);
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Resolves `relative` against `from` and requires the result to stay inside `root`.
export function resolveUnder(root, from, relative, label) {
  if (typeof relative !== 'string' || relative.trim() === '') {
    throw new UserError(`${label} must be a non-empty relative path.`);
  }
  if (path.isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative)) {
    throw new UserError(`${label} must be a relative path, not ${clean(relative)}.`);
  }
  const resolved = path.resolve(from, relative);
  if (!isInside(root, resolved)) throw new UserError(`${label} (${clean(relative)}) points outside the project.`);
  return resolved;
}

// A path from a workflow input, relative to the project and inside it.
export function checkRelativePath(value, label) {
  resolveUnder('/project', '/project', value, label);
  return value;
}

export function parseJsonObject(text, label) {
  let value;
  try {
    value = JSON.parse(text === undefined || text.trim() === '' ? '{}' : text);
  } catch {
    throw new UserError(`${label} must be a JSON object, and it isn't valid JSON.`);
  }
  if (!isPlainObject(value)) throw new UserError(`${label} must be a JSON object.`);
  return value;
}

// The `d1` input: {"BINDING": {"database_name": "...", "database_id"?: "...", "migrations_dir"?: "..."}}.
export function parseD1Input(text) {
  const raw = parseJsonObject(text, 'The d1 input');
  const result = {};
  for (const [binding, spec] of Object.entries(raw)) {
    if (!patterns.bindingName.test(binding)) throw new UserError(`d1: "${clean(binding, 60)}" isn't a valid binding name.`);
    if (!isPlainObject(spec)) throw new UserError(`d1.${binding} must be an object.`);
    for (const key of Object.keys(spec)) {
      if (!['database_name', 'database_id', 'migrations_dir'].includes(key)) {
        throw new UserError(`d1.${binding} has an unknown field "${clean(key, 60)}". Use database_name, database_id and migrations_dir.`);
      }
    }
    const { database_name: name, database_id: id, migrations_dir: migrations } = spec;
    if (typeof name !== 'string' || !patterns.d1Name.test(name)) {
      throw new UserError(`d1.${binding}.database_name must be letters, digits, dashes or underscores (up to 64).`);
    }
    if (id !== undefined && (typeof id !== 'string' || !patterns.uuid.test(id))) {
      throw new UserError(`d1.${binding}.database_id must be a D1 database ID (a lowercase UUID).`);
    }
    if (migrations !== undefined) checkRelativePath(migrations, `d1.${binding}.migrations_dir`);
    result[binding] = { database_name: name, database_id: id, migrations_dir: migrations };
  }
  return result;
}

// The `preview-vars` input: the only plain-text variables previews get.
export function parseVarsInput(text) {
  const raw = parseJsonObject(text, 'The preview-vars input');
  for (const [name, value] of Object.entries(raw)) {
    if (!patterns.bindingName.test(name)) throw new UserError(`preview-vars: "${clean(name, 60)}" isn't a valid variable name.`);
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new UserError(`preview-vars.${name} must be a string, number or boolean.`);
    }
  }
  return raw;
}

// Turns a branch name into a preview alias, such as "main".
export function branchAlias(branch) {
  let alias = String(branch).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!/^[a-z]/.test(alias)) alias = `b-${alias}`;
  return alias.slice(0, 30).replace(/-+$/, '');
}

// Preview hosts are "<alias>-<worker>.<subdomain>.workers.dev", and the first label
// can't be longer than 63 characters. Version links use 8 characters instead of an alias.
export function checkHostLength(alias, worker) {
  const label = `${alias}-${worker}`;
  if (label.length > MAX_LABEL) {
    throw new UserError(
      `The preview host "${label}" is ${label.length} characters, over Cloudflare's limit of ${MAX_LABEL}. Pick a shorter worker-name.`,
    );
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// True when the module at `url` is the script Node was started with.
export function isMain(url) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// Runs a script's main function: expected failures print their message, and
// anything else prints a stack. Either way the step fails.
export async function main(fn) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof UserError) log.error(error.message);
    else {
      log.error(`Unexpected error: ${clean(errorMessage(error), 500)}`);
      if (error instanceof Error && error.stack) log.info(error.stack);
    }
    process.exitCode = 1;
  }
}
