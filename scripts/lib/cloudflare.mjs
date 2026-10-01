// The few Cloudflare API calls pr-preview makes itself. Uploads and migrations go
// through Wrangler; these calls find or create the Worker and D1 databases, and
// delete previews.
import { UserError, clean, patterns, sleep as defaultSleep } from './common.mjs';

const API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareApiError extends Error {
  constructor(status, errors, path) {
    const list = Array.isArray(errors) ? errors : [];
    const detail = list.map((e) => `${clean(e?.message ?? 'error', 200)} (code ${e?.code})`).join('; ');
    super(detail || `HTTP ${status}`);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.errors = list;
    this.path = path;
  }

  hasCode(...codes) {
    return this.errors.some((e) => codes.includes(e?.code));
  }
}

// Rewrites API errors that need a person into messages that say what to change.
export function explainCloudflareError(error, what) {
  if (!(error instanceof CloudflareApiError)) return error;
  if (error.status === 401 || error.status === 403 || error.hasCode(10000, 9106, 9109)) {
    return new UserError(
      `Cloudflare refused the API token while ${what} (${error.message}). The token needs Account · Workers Scripts · Edit and Account · D1 · Edit for the account in CLOUDFLARE_ACCOUNT_ID.`,
    );
  }
  return new UserError(`Cloudflare API error while ${what}: ${error.message}.`);
}

export function createCloudflare({ token, accountId, fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep, retries = 3 }) {
  if (!token) throw new UserError('CLOUDFLARE_API_TOKEN is empty.', { status: 'not-configured' });
  if (!patterns.accountId.test(accountId ?? '')) {
    throw new UserError('CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID shown under Account details on the Workers & Pages page.');
  }
  const account = `/accounts/${accountId}`;

  async function call(method, path, { body, query, headers } = {}) {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 10000));
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      let json = null;
      try {
        json = await response.json();
      } catch {
        // Not JSON; handled below.
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new CloudflareApiError(response.status, json?.errors, path);
        continue;
      }
      if (response.status === 204) return {};
      if (!response.ok || !json || json.success === false) throw new CloudflareApiError(response.status, json?.errors, path);
      return json;
    }
    if (lastError instanceof CloudflareApiError) throw lastError;
    throw new UserError(`Couldn't reach the Cloudflare API: ${clean(lastError?.message ?? 'unknown error')}.`);
  }

  return {
    // The account's workers.dev subdomain, or null if none is registered yet.
    async accountSubdomain() {
      try {
        const { result } = await call('GET', `${account}/workers/subdomain`);
        return typeof result?.subdomain === 'string' && result.subdomain ? result.subdomain : null;
      } catch (error) {
        if (error instanceof CloudflareApiError && error.hasCode(10007)) return null;
        throw error;
      }
    },

    // A Worker's workers.dev settings, or null if the Worker doesn't exist.
    async worker(name) {
      try {
        const { result } = await call('GET', `${account}/workers/workers/${name}`);
        const subdomain = result?.subdomain ?? {};
        return {
          enabled: subdomain.enabled === true,
          previewsEnabled: subdomain.previews_enabled === true,
          url: typeof subdomain.url === 'string' ? subdomain.url : undefined,
          previewUrlSuffix: typeof subdomain.preview_url_suffix === 'string' ? subdomain.preview_url_suffix : undefined,
        };
      } catch (error) {
        if (error instanceof CloudflareApiError && (error.status === 404 || error.hasCode(10007, 10090))) return null;
        throw error;
      }
    },

    async enableSubdomain(name) {
      await call('POST', `${account}/workers/scripts/${name}/subdomain`, {
        body: { enabled: true, previews_enabled: true },
        headers: { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' },
      });
    },

    // The version that serves the Worker's workers.dev address, if it has a deployment.
    async deployedVersionId(name) {
      const { result } = await call('GET', `${account}/workers/scripts/${name}/deployments`);
      const versions = result?.deployments?.[0]?.versions ?? [];
      const top = [...versions].sort((a, b) => (b?.percentage ?? 0) - (a?.percentage ?? 0))[0];
      return typeof top?.version_id === 'string' ? top.version_id : null;
    },

    // Deletes a Worker Preview with all its deployments. False when there was none.
    async deletePreview(worker, name) {
      try {
        await call('DELETE', `${account}/workers/workers/${worker}/previews/${encodeURIComponent(name)}`);
        return true;
      } catch (error) {
        if (error instanceof CloudflareApiError && (error.status === 404 || error.hasCode(10007, 10025, 10090))) return false;
        throw error;
      }
    },

    async findD1(name) {
      const perPage = 100;
      for (let page = 1; page <= 50; page += 1) {
        const { result } = await call('GET', `${account}/d1/database`, { query: { per_page: perPage, page } });
        const list = Array.isArray(result) ? result : [];
        const match = list.find((db) => db?.name === name);
        if (match) return match;
        if (list.length < perPage) return null;
      }
      return null;
    },

    async createD1(name) {
      try {
        const { result } = await call('POST', `${account}/d1/database`, { body: { name } });
        return result;
      } catch (error) {
        // Another run created it first.
        if (error instanceof CloudflareApiError && error.hasCode(7502)) return this.findD1(name);
        if (error instanceof CloudflareApiError && error.hasCode(7406)) {
          throw new UserError(`This Cloudflare account has reached its limit of D1 databases, so ${name} couldn't be created.`);
        }
        throw error;
      }
    },
  };
}
