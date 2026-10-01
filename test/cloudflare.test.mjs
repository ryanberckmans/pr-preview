import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudflareApiError, createCloudflare, explainCloudflareError } from '../scripts/lib/cloudflare.mjs';
import { UserError } from '../scripts/lib/common.mjs';
import { cfError, fakeFetch, noSleep, ok } from './helpers.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const base = `/client/v4/accounts/${accountId}`;
const client = (fetch) => createCloudflare({ token: 'test-token', accountId, fetch, sleep: noSleep });

test('requires a token and a valid account ID', () => {
  assert.throws(() => createCloudflare({ token: '', accountId }), (error) => error instanceof UserError && error.status === 'not-configured');
  assert.throws(() => createCloudflare({ token: 't', accountId: 'nope' }), /32-character account ID/);
});

test('sends the token and reads the workers.dev subdomain', async () => {
  const { fetch, calls } = fakeFetch([['GET', `${base}/workers/subdomain`, () => ok({ subdomain: 'acme' })]]);
  assert.equal(await client(fetch).accountSubdomain(), 'acme');
  assert.equal(calls[0].headers.authorization, 'Bearer test-token');
});

test('a missing subdomain or Worker reads as null', async () => {
  const { fetch } = fakeFetch([
    ['GET', `${base}/workers/subdomain`, () => cfError(404, 10007, 'no subdomain')],
    ['GET', `${base}/workers/workers/app-preview`, () => cfError(404, 10007, 'not found')],
  ]);
  assert.equal(await client(fetch).accountSubdomain(), null);
  assert.equal(await client(fetch).worker('app-preview'), null);
});

test('reads a Worker\'s workers.dev settings', async () => {
  const { fetch } = fakeFetch([
    [
      'GET',
      `${base}/workers/workers/app-preview`,
      () => ok({ subdomain: { enabled: true, previews_enabled: false, url: 'https://app-preview.acme.workers.dev', preview_url_suffix: '-app-preview.acme.workers.dev' } }),
    ],
  ]);
  assert.deepEqual(await client(fetch).worker('app-preview'), {
    enabled: true,
    previewsEnabled: false,
    url: 'https://app-preview.acme.workers.dev',
    previewUrlSuffix: '-app-preview.acme.workers.dev',
  });
});

test('turns on workers.dev and Version URLs with the script API date header', async () => {
  const { fetch, calls } = fakeFetch([['POST', `${base}/workers/scripts/app-preview/subdomain`, () => ok({ enabled: true, previews_enabled: true })]]);
  await client(fetch).enableSubdomain('app-preview');
  assert.deepEqual(calls[0].body, { enabled: true, previews_enabled: true });
  assert.equal(calls[0].headers['Cloudflare-Workers-Script-Api-Date'], '2025-08-01');
});

test('picks the version with the most traffic', async () => {
  const { fetch } = fakeFetch([
    [
      'GET',
      `${base}/workers/scripts/app-preview/deployments`,
      () => ok({ deployments: [{ versions: [{ version_id: 'aaaa', percentage: 10 }, { version_id: 'bbbb', percentage: 90 }] }] }),
    ],
  ]);
  assert.equal(await client(fetch).deployedVersionId('app-preview'), 'bbbb');
});

test('finds a D1 database across pages and creates it when missing', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `db-${i}`, uuid: `u${i}` }));
  const { fetch, calls } = fakeFetch([
    ['GET', `${base}/d1/database`, ({ url }) => ok(url.searchParams.get('page') === '1' ? page1 : [{ name: 'app-preview', uuid: 'found' }])],
    ['POST', `${base}/d1/database`, () => ok({ name: 'new-db', uuid: 'created' })],
  ]);
  assert.equal((await client(fetch).findD1('app-preview')).uuid, 'found');
  assert.equal(await client(fetch).findD1('missing'), null);
  assert.equal((await client(fetch).createD1('new-db')).uuid, 'created');
  assert.deepEqual(calls.at(-1).body, { name: 'new-db' });
});

test('a database created by another run at the same time is found instead', async () => {
  const { fetch } = fakeFetch([
    ['POST', `${base}/d1/database`, () => cfError(400, 7502, 'exists')],
    ['GET', `${base}/d1/database`, () => ok([{ name: 'app-preview', uuid: 'theirs' }])],
  ]);
  assert.equal((await client(fetch).createD1('app-preview')).uuid, 'theirs');
});

test('retries rate limits and server errors', async () => {
  let n = 0;
  const { fetch, calls } = fakeFetch([['GET', `${base}/workers/subdomain`, () => (++n < 3 ? cfError(503, 10013, 'busy') : ok({ subdomain: 'acme' }))]]);
  assert.equal(await client(fetch).accountSubdomain(), 'acme');
  assert.equal(calls.length, 3);
});

test('auth failures explain which permissions the token needs', async () => {
  const { fetch } = fakeFetch([['GET', `${base}/workers/subdomain`, () => cfError(403, 10000, 'Authentication error')]]);
  const error = await client(fetch).accountSubdomain().catch((e) => e);
  assert.ok(error instanceof CloudflareApiError);
  const explained = explainCloudflareError(error, 'reading the subdomain');
  assert.ok(explained instanceof UserError);
  assert.match(explained.message, /Workers Scripts · Edit and Account · D1 · Edit/);
});
