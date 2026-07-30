import { handlePublishLibrary } from './publish-library.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/publish-library' && request.method === 'POST') {
      return handlePublishLibrary(request, env);
    }

    // Everything else is the static Astro site.
    return env.ASSETS.fetch(request);
  },
};
