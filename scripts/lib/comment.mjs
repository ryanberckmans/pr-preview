// Decides what the PR comment says and renders it. Pure functions, so tests can
// cover every state.
import { clean, patterns } from './common.mjs';

export const MARKER = '<!-- pr-preview -->';
// Only the last line counts: text from a run (the check's output) comes before it.
const DATA_PATTERN = /\n<!-- pr-preview:data (\{[^<>\n]*\}) -->$/;
const PREVIEW_URL = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\/?$/;
const VISIBILITIES = new Set(['private', 'public']);

export function isPreviewUrl(value) {
  return typeof value === 'string' && PREVIEW_URL.test(value);
}

// The last successful preview, saved in a hidden line of the comment.
export function readLastGood(body) {
  const match = typeof body === 'string' ? DATA_PATTERN.exec(body) : null;
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    if (!patterns.sha.test(data.sha ?? '') || !isPreviewUrl(data.url) || !VISIBILITIES.has(data.visibility)) return null;
    if (Number.isNaN(Date.parse(data.at))) return null;
    return { sha: data.sha, url: data.url, at: data.at, visibility: data.visibility };
  } catch {
    return null;
  }
}

// Turns job results into one state. Returns null when the comment should stay as
// it is: the run was cancelled or superseded by a newer commit.
export function decide(r) {
  if (r.planStatus === 'invalid') return { kind: 'invalid', message: r.planMessage };
  if (r.configured !== 'true') return { kind: 'not-configured', missing: r.missing };
  if (r.buildResult === 'cancelled' || r.deployResult === 'cancelled') return null;
  if (r.buildResult !== 'success') {
    const stage = r.installOutcome === 'failure' ? 'install' : r.buildOutcome === 'failure' ? 'build' : 'collect';
    return { kind: 'build-failed', stage };
  }
  if (r.deployStatus === 'stale') return null;
  if (r.deployStatus === 'deployed' && isPreviewUrl(r.url)) {
    return { kind: 'deployed', url: r.url, mainUrl: isPreviewUrl(r.mainUrl) ? r.mainUrl : undefined };
  }
  if (r.deployStatus === 'needs-access') return { kind: 'needs-access', message: r.deployMessage };
  if (r.deployStatus === 'gate-off') return { kind: 'gate-off', message: r.deployMessage };
  if (r.deployResult === 'skipped' && !r.deployStatus) return null;
  return { kind: 'deploy-failed', message: r.deployMessage };
}

// Text from a run, made inert in Markdown: no HTML, links or @-mentions.
export function inline(value, max = 400) {
  return clean(value ?? '', max)
    .replace(/[\\`*_[\]<>|~]/g, (ch) => `\\${ch}`)
    .replace(/@/g, '@​');
}

// Text shown as inline code: one line, no backticks to end the span early.
export function code(value, max = 120) {
  return clean(value ?? '', max).replace(/`/g, "'");
}

function codeBlock(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

export function formatTime(iso) {
  const date = new Date(iso);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function short(sha) {
  return String(sha).slice(0, 7);
}

// Renders the comment. Returns { body, lastGood }, where lastGood is what the
// hidden line now records.
export function renderComment(state, { sha, visibility, check, lastGood, now, runUrl, setupUrl }) {
  const lines = [MARKER];
  let saved = lastGood;
  const run = `([run](${runUrl}))`;
  const stillServes = (good) => `The link still serves \`${short(good.sha)}\` from ${formatTime(good.at)}: ${good.url}`;

  switch (state.kind) {
    case 'deployed': {
      saved = { sha, url: state.url, at: now, visibility };
      lines.push(`**Preview:** ${state.url}`, '');
      const access = visibility === 'private' ? 'Private: it asks you to sign in.' : 'Public: anyone with the link can open it.';
      const compare = state.mainUrl && state.mainUrl !== state.url ? ` Compare with [main](${state.mainUrl}).` : '';
      lines.push(`${access} Built from \`${short(sha)}\` at ${formatTime(now)}.${compare}`);
      if (check?.status === 'passed') lines.push('', `Check \`${code(check.command)}\` passed.`);
      if (check?.status === 'failed') {
        lines.push('', `Check \`${code(check.command)}\` failed ${run}. The preview is up anyway.`);
        if (check.tail) lines.push('', '<details><summary>Last lines of the check</summary>', '', codeBlock(check.tail), '', '</details>');
      }
      break;
    }
    case 'build-failed':
      lines.push(`**Preview:** the ${state.stage === 'collect' ? 'build output check' : state.stage} for \`${short(sha)}\` failed ${run}.`);
      if (lastGood) lines.push('', stillServes(lastGood));
      break;
    case 'deploy-failed':
      lines.push(`**Preview:** couldn't deploy \`${short(sha)}\`: ${inline(state.message || 'see the run log.')} ${run}`);
      if (lastGood) lines.push('', stillServes(lastGood));
      break;
    case 'needs-access':
      lines.push(
        `**Preview:** almost set up. ${inline(state.message)}`,
        '',
        `No preview is posted until sign-in is enforced. [Setup steps](${setupUrl})`,
      );
      break;
    case 'gate-off':
      // An old link would be just as open, so it isn't repeated here.
      lines.push(
        `**Preview:** blocked, so no link was posted. ${inline(state.message)} ${run}`,
        '',
        `Turn Cloudflare Access back on for the preview Worker's workers.dev and Preview URLs, then re-run. [Setup steps](${setupUrl})`,
      );
      saved = undefined;
      break;
    case 'not-configured': {
      const named = (state.missing ?? '').split(/\s+/).filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
      const missing = named.length > 0 ? named : ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
      lines.push(
        `**Preview:** not set up yet. Add the ${missing.map((name) => `\`${name}\``).join(' and ')} repository secret${missing.length > 1 ? 's' : ''}, then re-run this workflow. [Setup steps](${setupUrl})`,
      );
      break;
    }
    case 'invalid':
      lines.push(`**Preview:** the preview settings in this repo's workflow need fixing: ${inline(state.message)} ${run}`);
      if (lastGood) lines.push('', stillServes(lastGood));
      break;
    default:
      throw new Error(`Unknown state ${state.kind}`);
  }

  if (saved) lines.push(`<!-- pr-preview:data ${JSON.stringify(saved)} -->`);
  return { body: lines.join('\n'), lastGood: saved };
}
