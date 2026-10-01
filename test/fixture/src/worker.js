// The fixture Worker: an API route next to static assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      const row = env.DB ? await env.DB.prepare('SELECT count(*) AS n FROM visits').first() : null;
      return Response.json({ ok: true, greeting: env.GREETING ?? null, visits: row?.n ?? null });
    }
    return env.ASSETS.fetch(request);
  },
};
