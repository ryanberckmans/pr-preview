import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyGateResponse, probeGate } from '../scripts/lib/gate.mjs';
import { fakeFetch, noSleep, redirect } from './helpers.mjs';

const url = 'https://pr-1-app-preview.acme.workers.dev/';
const login = 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/pr-1-app-preview.acme.workers.dev?kid=abc&redirect_url=%2F';

test('a redirect to Cloudflare Access sign-in counts as gated', () => {
  assert.equal(classifyGateResponse(302, login, { url }).gated, true);
  assert.equal(classifyGateResponse(302, login, { url, teamDomain: 'acme.cloudflareaccess.com' }).gated, true);
});

test('anything else counts as open', () => {
  const cases = [
    [200, null],
    [204, null],
    [302, 'https://evil.example/cdn-cgi/access/login/x'],
    [302, 'http://acme.cloudflareaccess.com/cdn-cgi/access/login/x'],
    [302, 'https://acme.cloudflareaccess.com.evil.example/cdn-cgi/access/login/x'],
    [302, 'https://acme.cloudflareaccess.com/somewhere-else'],
    [302, '/cdn-cgi/access/login/x'],
    [302, null],
    [401, null],
    [403, null],
  ];
  for (const [status, location] of cases) {
    const verdict = classifyGateResponse(status, location, { url });
    assert.equal(verdict.gated, false, `${status} ${location}`);
    assert.equal(verdict.final, true, `${status} ${location}`);
  }
});

test('the team domain must match exactly when given', () => {
  const verdict = classifyGateResponse(302, 'https://other.cloudflareaccess.com/cdn-cgi/access/login/x', { url, teamDomain: 'acme.cloudflareaccess.com' });
  assert.equal(verdict.gated, false);
  assert.match(verdict.reason, /instead of Cloudflare Access at acme\.cloudflareaccess\.com/);
});

test('404 and 5xx are retried, then fail closed', async () => {
  const { fetch, calls } = fakeFetch([['GET', url, () => new Response('nothing here', { status: 404 })]]);
  const verdict = await probeGate(url, { fetch, sleep: noSleep, attempts: 3 });
  assert.equal(verdict.gated, false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].redirect, 'manual');
});

test('a host that turns gated after propagating passes', async () => {
  let n = 0;
  const { fetch } = fakeFetch([['GET', url, () => (++n < 3 ? new Response('', { status: 522 }) : redirect(login))]]);
  const verdict = await probeGate(url, { fetch, sleep: noSleep, attempts: 4 });
  assert.equal(verdict.gated, true);
});

test('an open answer stops the probe at once', async () => {
  const { fetch, calls } = fakeFetch([['GET', url, () => new Response('hello', { status: 200 })]]);
  const verdict = await probeGate(url, { fetch, sleep: noSleep, attempts: 5 });
  assert.equal(verdict.gated, false);
  assert.equal(calls.length, 1);
  assert.match(verdict.reason, /answered 200 without sign-in/);
});

test('network errors fail closed', async () => {
  const fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const verdict = await probeGate(url, { fetch, sleep: noSleep, attempts: 2 });
  assert.equal(verdict.gated, false);
  assert.match(verdict.reason, /couldn't be reached/);
});
