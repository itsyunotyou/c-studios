import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://c-studios.co.uk',
  build: {
    inlineStylesheets: 'auto',
  },
  compressHTML: true,
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  image: {
    service: { entrypoint: 'astro/assets/services/sharp' },
  },
});
