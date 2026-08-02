// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/fly/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/fly/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Fly Machines',
      sidebar: [
            {
                  "label": "← chant docs",
                  "link": "../../"
            },
            {
                  "label": "Overview",
                  "slug": "index"
            },
            {
                  "label": "Resource Reference",
                  "slug": "resources"
            },
            {
                  "label": "Pseudo-parameters",
                  "slug": "pseudo-params"
            },
            {
                  "label": "All Rules",
                  "slug": "rules"
            },
            {
                  "label": "Serialization",
                  "slug": "serialization"
            }
      ],
    }),
  ],
});
