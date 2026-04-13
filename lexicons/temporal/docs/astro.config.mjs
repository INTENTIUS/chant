// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  base: '/chant/lexicons/temporal/',
  integrations: [
    starlight({
      title: 'Temporal',
      sidebar: [
        { label: '← chant docs', link: '../../' },
        { label: 'Overview', slug: 'index' },
        { label: 'Getting Started', slug: 'getting-started' },
        { label: 'Temporal Concepts', slug: 'temporal-concepts' },
        { label: 'Resources', slug: 'resources' },
        { label: 'Serialization', slug: 'serialization' },
        { label: 'Worker Profiles', slug: 'worker-profiles' },
        { label: 'AI Skills', slug: 'skills' },
        { label: 'Lint Rules', slug: 'lint-rules' },
      ],
    }),
  ],
});
