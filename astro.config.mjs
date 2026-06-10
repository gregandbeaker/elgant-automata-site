// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://elegantautomata.ai',
  // Cloudflare Pages was trying to auto-provision an Astro SESSION KV namespace
  // even though this is a static site. Disable Astro sessions explicitly so
  // deploys do not attempt to create/recreate elegant-automata-site-session.
  session: {
    driver: {
      entrypoint: 'unstorage/drivers/null',
    },
  },
  build: {
    format: 'directory',
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
