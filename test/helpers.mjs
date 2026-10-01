// Test doubles for the Cloudflare and GitHub APIs and for Wrangler.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function tempDir(t, prefix = 'pr-preview-test-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function redirect(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

// A fetch double. Each route is [method, pattern, handler]; the first match wins.
// Every request is recorded in `calls`.
export function fakeFetch(routes) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: url.toString(), path: url.pathname, query: url.searchParams, headers: init.headers ?? {}, body, redirect: init.redirect });
    for (const [m, pattern, handler] of routes) {
      if (m !== method) continue;
      const match = typeof pattern === 'string' ? url.toString() === pattern || url.pathname === pattern : url.toString().match(pattern);
      if (match) return handler({ url, body, match, calls });
    }
    throw new Error(`No fake route for ${method} ${url}`);
  };
  return { fetch, calls };
}

export const ok = (result, extra = {}) => jsonResponse(200, { success: true, errors: [], result, ...extra });
export const cfError = (status, code, message = 'error') => jsonResponse(status, { success: false, errors: [{ code, message }], result: null });

// A Wrangler double: records each run and answers with `handler(args)`.
export function fakeWrangler(handler = () => ({ code: 0, tail: '', entries: [] })) {
  const runs = [];
  const run = async (args) => {
    const configIndex = args.indexOf('--config');
    const config = configIndex >= 0 && args[configIndex + 1]?.endsWith('wrangler.pr-preview.json') ? JSON.parse(readFileSync(args[configIndex + 1], 'utf8')) : undefined;
    runs.push({ args, config });
    return handler(args, runs.length);
  };
  return { run, runs };
}

export const noSleep = async () => {};
