// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://elegantautomata.ai',
  build: {
    format: 'file',
  },
  vite: {
    css: {
      preprocessorOptions: {
        css: {
          additionalData: '',
        },
      },
    },
  },
});
