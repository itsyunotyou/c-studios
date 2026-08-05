import { handlePublishLibrary } from './publish-library.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/publish-library' && request.method === 'POST') {
      try {
        return await handlePublishLibrary(request, env);
      } catch (e) {
        // Without this, an uncaught exception here (e.g. a GitHub API call
        // rejecting, or the subrequest-per-invocation cap being hit) shows
        // up to the Apps Script caller as Cloudflare's own opaque "error
        // code: 1101" page instead of anything actionable.
        return new Response(`Internal error: ${e.message}`, { status: 500 });
      }
    }

    // Everything else is the static Astro site.
    return env.ASSETS.fetch(request);
  },
};
