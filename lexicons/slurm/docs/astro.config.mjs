// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Slurm',
      sidebar: [
        { label: 'Overview', slug: '' },
      ],
    }),
  ],
});
