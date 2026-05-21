import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://c-studios.co.uk',
  build: {
    inlineStylesheets: 'auto',
  },
  compressHTML: true,
});
