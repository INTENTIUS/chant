// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/temporal/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/temporal/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Temporal',
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
                  "label": "How-to guides",
                  "items": [
                        {
                              "label": "Ops",
                              "slug": "ops"
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
                              "label": "AI Skills",
                              "slug": "skills"
                        },
                        {
                              "label": "Lint Rules",
                              "slug": "lint-rules"
                        },
                        {
                              "label": "Resources",
                              "slug": "resources"
                        },
                        {
                              "label": "Worker Profiles",
                              "slug": "worker-profiles"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Temporal Concepts",
                              "slug": "temporal-concepts"
                        }
                  ]
            }
      ],
    }),
  ],
});
