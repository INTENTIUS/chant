// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Cedar',
      sidebar: [
        { label: 'Overview', slug: '' },
      ],
    }),
  ],
});
