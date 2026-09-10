// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/augur/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/augur/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'augur',
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
                  "label": "Tutorials",
                  "items": [
                        {
                              "label": "Getting Started",
                              "slug": "getting-started"
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "All Rules",
                              "slug": "rules"
                        },
                        {
                              "label": "Serialization",
                              "slug": "serialization"
                        },
                        {
                              "label": "The coverage table",
                              "slug": "coverage"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Predicting",
                              "slug": "predicting"
                        }
                  ]
            }
      ],
    }),
  ],
});
