// Minimal GitHub REST client for the comment and the freshness check.
import { UserError, clean, sleep as defaultSleep } from './common.mjs';

export function createGitHub({ token, apiUrl = 'https://api.github.com', repository, fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
  if (!token) throw new UserError('GITHUB_TOKEN is empty.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new UserError('GITHUB_REPOSITORY is invalid.');

  async function call(method, path, body) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(2000 * attempt);
      let response;
      try {
        response = await fetchImpl(`${apiUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'pr-preview',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      if (response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        let message = text;
        try {
          message = JSON.parse(text).message ?? text;
        } catch {
          // Keep the raw text.
        }
        throw new UserError(`GitHub API ${method} ${path.split('?')[0]} failed with ${response.status}: ${clean(message, 200)}`);
      }
      return text ? JSON.parse(text) : null;
    }
    throw new UserError(`Couldn't reach the GitHub API: ${clean(lastError?.message ?? 'unknown error')}`);
  }

  const repo = `/repos/${repository}`;
  return {
    pullRequest: (number) => call('GET', `${repo}/pulls/${number}`),
    branch: (name) => call('GET', `${repo}/branches/${encodeURIComponent(name)}`),
    async findComment(number, predicate) {
      for (let page = 1; page <= 30; page += 1) {
        const comments = await call('GET', `${repo}/issues/${number}/comments?per_page=100&page=${page}`);
        const match = comments.find(predicate);
        if (match) return match;
        if (comments.length < 100) return null;
      }
      return null;
    },
    createComment: (number, body) => call('POST', `${repo}/issues/${number}/comments`, { body }),
    updateComment: (id, body) => call('PATCH', `${repo}/issues/comments/${id}`, { body }),
  };
}
