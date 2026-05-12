// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from '../../../packages/core/src/codegen/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/slurm/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/slurm/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Slurm',
      sidebar: [
        { label: 'Overview', slug: '' },
        { label: 'Getting Started', slug: 'getting-started' },
        { label: 'Resources', slug: 'resources' },
        { label: 'Composites', slug: 'composites' },
        { label: 'Lint Rules', slug: 'lint-rules' },
        { label: 'Importing', slug: 'importing' },
        { label: 'Serialization', slug: 'serialization' },
        { label: 'AI Skills', slug: 'skills' },
        { label: 'Examples', slug: 'examples' },
      ],
    }),
  ],
});
