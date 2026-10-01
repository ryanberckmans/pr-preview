// What a preview Worker serves at its bare workers.dev address. pr-preview deploys
// this once, when it creates the Worker; previews are separate versions, reached
// through their own links.
export default {
  fetch() {
    return new Response('No preview here. Each pull request has its own link.\n', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    });
  },
};
