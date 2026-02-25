// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Fixture',
      sidebar: [
        { label: 'Overview', slug: '' },
        { label: 'Getting Started', slug: 'getting-started' },
        { label: 'Serialization', slug: 'serialization' },
        { label: 'Lint Rules', slug: 'lint-rules' },
      ],
    }),
  ],
});
