// Runs in the deploy job before the upload. Skips the upload when a newer commit
// has landed on the PR or branch, so a slow or re-run job never replaces a newer
// preview with an older one.
import { clean, errorMessage, isMain, log, main, readEnv, setOutputs } from './lib/common.mjs';
import { createGitHub } from './lib/github.mjs';

export async function freshness(env, { fetch, sleep } = {}) {
  const sha = readEnv(env, 'PLAN_SHA', { required: true });
  const prNumber = readEnv(env, 'PLAN_PR_NUMBER');
  try {
    const github = createGitHub({
      token: readEnv(env, 'GITHUB_TOKEN'),
      apiUrl: readEnv(env, 'GITHUB_API_URL') || undefined,
      repository: readEnv(env, 'GITHUB_REPOSITORY'),
      fetch,
      sleep,
    });
    if (prNumber) {
      const pr = await github.pullRequest(prNumber);
      if (pr.state === 'closed') return { fresh: 'false', status: 'stale', message: 'The pull request was closed.' };
      if (pr.head?.sha && pr.head.sha !== sha) {
        return { fresh: 'false', status: 'stale', message: `A newer commit (${String(pr.head.sha).slice(0, 7)}) is on the pull request.` };
      }
    } else {
      const branch = await github.branch(readEnv(env, 'PLAN_DEFAULT_BRANCH', { required: true }));
      if (branch.commit?.sha && branch.commit.sha !== sha) {
        return { fresh: 'false', status: 'stale', message: `A newer commit (${String(branch.commit.sha).slice(0, 7)}) is on the branch.` };
      }
    }
  } catch (error) {
    // Not knowing is no reason to block the preview.
    log.warning(`Couldn't check for newer commits: ${clean(errorMessage(error), 300)}`);
  }
  return { fresh: 'true' };
}

if (isMain(import.meta.url)) {
  await main(async () => {
    const result = await freshness(process.env);
    setOutputs(result);
    if (result.fresh !== 'true') log.notice(`Skipping the upload. ${result.message}`);
  });
}
