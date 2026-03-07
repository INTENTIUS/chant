// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Fixture',
      sidebar: [
        { label: 'Overview', slug: '' },
      ],
    }),
  ],
});
