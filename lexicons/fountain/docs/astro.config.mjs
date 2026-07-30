// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/fountain/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/fountain/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Fountain',
      sidebar: [
        { label: '← chant docs', link: '../../' },
        { label: 'Overview', slug: 'index' },
        { label: 'Resources', slug: 'resources' },
        { label: 'Lint Rules', slug: 'rules' },
        { label: 'Serialization', slug: 'serialization' },
      ],
    }),
  ],
});
