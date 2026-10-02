// First step of the build job, before any of the repo's code runs. Works out which
// preview this run makes or, when a pull request closes, deletes, whether it is
// private, and whether Cloudflare is set up.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  UserError,
  branchAlias,
  checkHostLength,
  checkRelativePath,
  clean,
  isMain,
  log,
  main,
  parseBoolean,
  parseD1Input,
  parseVarsInput,
  patterns,
  readEnv,
  setOutputs,
} from './lib/common.mjs';

export function plan(env) {
  const event = JSON.parse(readFileSync(readEnv(env, 'GITHUB_EVENT_PATH', { required: true }), 'utf8'));
  const eventName = readEnv(env, 'GITHUB_EVENT_NAME', { required: true });
  const repository = readEnv(env, 'GITHUB_REPOSITORY', { required: true });
  const repo = event.repository ?? {};
  const defaultBranch = typeof repo.default_branch === 'string' && repo.default_branch ? repo.default_branch : 'main';

  let alias;
  let sha;
  let prNumber = '';
  let cleanup = false;
  const pullRequest = eventName === 'pull_request' || eventName === 'pull_request_target';
  if (pullRequest) {
    const pr = event.pull_request ?? {};
    if (pr.head?.repo?.full_name !== repository) return { run: 'false', reason: 'Pull requests from forks get no preview.' };
    // pull_request_target runs even for a pull request with merge conflicts, which
    // gets no pull_request runs, but it has the repo's secrets, so it only ever
    // deletes a closed pull request's preview and never builds one.
    if (eventName === 'pull_request_target' && event.action !== 'closed') {
      return { run: 'false', reason: 'pr-preview only deletes previews on pull_request_target, when a pull request closes. Use pull_request for the other types.' };
    }
    prNumber = String(pr.number ?? '');
    sha = pr.head?.sha;
    alias = `pr-${prNumber}`;
    cleanup = event.action === 'closed';
  } else if (eventName === 'push' || eventName === 'workflow_dispatch') {
    if (readEnv(env, 'GITHUB_REF') !== `refs/heads/${defaultBranch}`) {
      return { run: 'false', reason: `Only the default branch (${defaultBranch}) gets a preview outside pull requests.` };
    }
    sha = readEnv(env, 'GITHUB_SHA');
    alias = branchAlias(defaultBranch);
  } else {
    return { run: 'false', reason: `pr-preview doesn't handle ${clean(eventName, 40)} events. Use pull_request, push and, for closed pull requests, pull_request_target.` };
  }

  // Public only when GitHub says the repo is public; force-private can keep it private.
  const isPublic = repo.private === false && (repo.visibility === undefined || repo.visibility === 'public');
  let forcePrivate = true;
  let forceError;
  try {
    forcePrivate = parseBoolean(readEnv(env, 'IN_FORCE_PRIVATE'), 'force-private');
  } catch (error) {
    forceError = error;
  }
  const visibility = isPublic && !forcePrivate ? 'public' : 'private';

  const base = { run: 'true', 'pr-number': prNumber, sha: sha ?? '', visibility, 'default-branch': defaultBranch };
  try {
    if (forceError) throw forceError;
    if (!patterns.prNumber.test(prNumber) && pullRequest) throw new UserError('The pull request number is missing from the event.');
    if (!patterns.sha.test(sha ?? '')) throw new UserError('The commit SHA is missing from the event.');

    const workerName = readEnv(env, 'IN_WORKER_NAME');
    if (!patterns.workerName.test(workerName)) {
      throw new UserError('worker-name must be lowercase letters, digits and dashes, starting and ending with a letter or digit.');
    }
    const worker = visibility === 'public' ? `${workerName}-public` : workerName;
    const mainAlias = branchAlias(defaultBranch);
    checkHostLength(alias, worker);
    checkHostLength(mainAlias, worker);
    checkHostLength('00000000', worker);

    const teamDomain = readEnv(env, 'IN_ACCESS_TEAM_DOMAIN').toLowerCase();
    if (teamDomain && !patterns.teamDomain.test(teamDomain)) {
      throw new UserError('access-team-domain must look like <team>.cloudflareaccess.com.');
    }
    const workingDirectory = readEnv(env, 'IN_WORKING_DIRECTORY') || '.';
    checkRelativePath(workingDirectory, 'working-directory');
    checkRelativePath(readEnv(env, 'IN_WRANGLER_CONFIG', { required: true }), 'wrangler-config');
    parseD1Input(readEnv(env, 'IN_D1'));
    parseVarsInput(readEnv(env, 'IN_PREVIEW_VARS'));

    const missing = [
      env.HAS_API_TOKEN === 'true' ? null : 'CLOUDFLARE_API_TOKEN',
      env.HAS_ACCOUNT_ID === 'true' ? null : 'CLOUDFLARE_ACCOUNT_ID',
    ].filter(Boolean);
    const configured = missing.length === 0;
    if (cleanup && !configured) return { run: 'false', reason: 'The pull request is closed, and without the Cloudflare secrets it has no preview to delete.' };
    const workspace = readEnv(env, 'GITHUB_WORKSPACE', { required: true });
    return {
      ...base,
      status: 'ok',
      alias,
      'main-alias': mainAlias,
      worker,
      'team-domain': teamDomain,
      'app-dir': path.resolve(workspace, 'app', workingDirectory),
      configured: String(configured),
      missing: missing.join(' '),
      build: String(configured && !cleanup),
      cleanup: String(cleanup),
    };
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    if (cleanup) return { run: 'false', reason: `The pull request is closed, but its preview can't be deleted: ${error.message}` };
    return { ...base, status: 'invalid', message: error.message, build: 'false' };
  }
}

if (isMain(import.meta.url)) {
  await main(async () => {
    const outputs = plan(process.env);
    setOutputs(outputs);
    if (outputs.run !== 'true') {
      log.notice(`No preview for this run. ${outputs.reason}`);
      return;
    }
    if (outputs.status === 'invalid') throw new UserError(outputs.message);
    if (outputs.cleanup === 'true') {
      log.info(`The pull request is closed, so its preview ${outputs.alias} on Worker ${outputs.worker} will be deleted.`);
      return;
    }
    log.info(`Preview ${outputs.alias} of ${outputs.sha.slice(0, 7)} on Worker ${outputs.worker} (${outputs.visibility}).`);
    if (outputs.configured !== 'true') {
      const missing = outputs.missing.split(' ');
      log.warning(`No preview yet: add the ${missing.join(' and ')} repository secret${missing.length > 1 ? 's' : ''}. See the pr-preview README.`);
    }
  });
}
