// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'K3d',
      sidebar: [
        { label: 'Overview', slug: '' },
      ],
    }),
  ],
});
