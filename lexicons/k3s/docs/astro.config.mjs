// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/k3s/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/k3s/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'K3s',
      sidebar: [
        { label: '← chant docs', link: '../../' },
        { label: 'Overview', slug: 'index' },
        {
          label: 'Reference',
          items: [{ label: 'Entities & Rules', slug: 'reference' }],
        },
      ],
    }),
  ],
});
