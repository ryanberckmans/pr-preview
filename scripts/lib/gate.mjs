// Proves that a private preview host sits behind Cloudflare Access: an anonymous
// request must be redirected to the Access sign-in page. Anything else, including
// errors and timeouts, counts as not gated.
import { clean, sleep as defaultSleep } from './common.mjs';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// final: true means retrying won't change the verdict.
export function classifyGateResponse(status, location, { url, teamDomain }) {
  if (REDIRECTS.has(status)) {
    let target;
    try {
      target = new URL(location ?? '', url);
    } catch {
      return { gated: false, final: true, reason: `redirected to an unreadable location` };
    }
    const hostMatches = teamDomain ? target.hostname === teamDomain : target.hostname.endsWith('.cloudflareaccess.com');
    if (location && target.protocol === 'https:' && hostMatches && target.pathname.startsWith('/cdn-cgi/access/')) {
      return { gated: true, final: true, reason: `redirects to Cloudflare Access at ${target.hostname}` };
    }
    const expected = teamDomain ? `Cloudflare Access at ${teamDomain}` : 'Cloudflare Access';
    return {
      gated: false,
      final: true,
      reason: `redirects to ${clean(`${target.hostname}${target.pathname}`, 80)} instead of ${expected}`,
    };
  }
  if (status >= 200 && status < 300) return { gated: false, final: true, reason: `answered ${status} without sign-in` };
  if (status === 401 || status === 403) {
    return { gated: false, final: true, reason: `answered ${status} instead of redirecting to Cloudflare Access` };
  }
  // A brand-new host can answer 404 or 5xx for a few seconds.
  return { gated: false, final: false, reason: `answered ${status}` };
}

export async function probeGate(url, { teamDomain, fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep, attempts = 4, delayMs = 5000 } = {}) {
  let verdict = { gated: false, final: false, reason: 'was not checked' };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'user-agent': 'Mozilla/5.0 (compatible; pr-preview-gate-check)',
          'cache-control': 'no-cache',
        },
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel().catch(() => {});
      verdict = classifyGateResponse(response.status, response.headers.get('location'), { url, teamDomain });
      if (verdict.final) return verdict;
    } catch (error) {
      verdict = { gated: false, final: false, reason: `couldn't be reached (${clean(error?.message ?? error, 120)})` };
    }
  }
  return verdict;
}
