// The report job: posts or updates the one pr-preview comment on the PR and
// writes the run summary. It reads job results only; no build output reaches it
// except the check's last lines, which it shows as plain text.
import { appendSummary, isMain, log, main, patterns, readEnv } from './lib/common.mjs';
import { decide, isPreviewComment, readLastGood, renderComment } from './lib/comment.mjs';
import { createGitHub } from './lib/github.mjs';

const BOT_LOGIN = 'github-actions[bot]';

export function results(env) {
  const get = (name) => readEnv(env, name);
  return {
    planStatus: get('PLAN_STATUS'),
    planMessage: get('PLAN_MESSAGE'),
    configured: get('PLAN_CONFIGURED'),
    missing: get('PLAN_MISSING'),
    buildResult: get('BUILD_RESULT'),
    installOutcome: get('INSTALL_OUTCOME'),
    buildOutcome: get('BUILD_OUTCOME'),
    deployResult: get('DEPLOY_RESULT'),
    deployStatus: get('DEPLOY_STATUS'),
    deployMessage: get('DEPLOY_MESSAGE'),
    url: get('DEPLOY_URL'),
    mainUrl: get('DEPLOY_MAIN_URL'),
  };
}

export async function report(env, { fetch, now = new Date().toISOString() } = {}) {
  const workerName = readEnv(env, 'IN_WORKER_NAME');
  const sha = readEnv(env, 'PLAN_SHA');
  const prNumber = readEnv(env, 'PLAN_PR_NUMBER');
  const visibility = readEnv(env, 'PLAN_VISIBILITY') === 'public' ? 'public' : 'private';
  const server = readEnv(env, 'GITHUB_SERVER_URL') || 'https://github.com';
  const repository = readEnv(env, 'GITHUB_REPOSITORY');
  const runUrl = `${server}/${repository}/actions/runs/${readEnv(env, 'GITHUB_RUN_ID')}`;
  const toolRepository = readEnv(env, 'TOOL_REPOSITORY') || 'ryanberckmans/pr-preview';
  const setupUrl = `${server}/${toolRepository}#setup`;
  const checkCommand = readEnv(env, 'CHECK_COMMAND');
  const check = checkCommand
    ? { command: checkCommand, status: readEnv(env, 'CHECK_STATUS') || 'none', tail: env.CHECK_TAIL ?? '' }
    : undefined;

  const state = decide(results(env));
  if (!state) {
    log.info('This run was cancelled or superseded by a newer commit, so the comment stays as it is.');
    return { action: 'none' };
  }

  let github;
  let existing = null;
  if (prNumber && patterns.prNumber.test(prNumber)) {
    github = createGitHub({ token: readEnv(env, 'GITHUB_TOKEN'), apiUrl: readEnv(env, 'GITHUB_API_URL') || undefined, repository, fetch });
    existing = await github.findComment(prNumber, (comment) => comment?.user?.login === BOT_LOGIN && isPreviewComment(comment.body, workerName));
  }
  const { body } = renderComment(state, {
    workerName,
    sha,
    visibility,
    check,
    lastGood: readLastGood(existing?.body),
    now,
    runUrl,
    setupUrl,
  });
  appendSummary(body.replace(/<!--[^>]*-->\n?/g, ''), readEnv(env, 'GITHUB_STEP_SUMMARY'));

  if (!github) return { action: 'summary', body };
  if (existing) {
    await github.updateComment(existing.id, body);
    log.info(`Updated the preview comment on PR #${prNumber}.`);
    return { action: 'updated', body };
  }
  await github.createComment(prNumber, body);
  log.info(`Posted the preview comment on PR #${prNumber}.`);
  return { action: 'created', body };
}

if (isMain(import.meta.url)) {
  await main(() => report(process.env));
}
