// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/cpln/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/cpln/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Control Plane',
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
                  "label": "How-to guides",
                  "items": [
                        {
                              "label": "Secrets and Identities",
                              "slug": "secrets"
                        },
                        {
                              "label": "Applying",
                              "slug": "applying"
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "Resources",
                              "slug": "resources"
                        },
                        {
                              "label": "Workload Types",
                              "slug": "workload-types"
                        },
                        {
                              "label": "Links and References",
                              "slug": "links"
                        },
                        {
                              "label": "Composites",
                              "slug": "composites"
                        },
                        {
                              "label": "Skills",
                              "slug": "skills"
                        },
                        {
                              "label": "All Rules",
                              "slug": "rules"
                        },
                        {
                              "label": "Serialization",
                              "slug": "serialization"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Drift and Ownership",
                              "slug": "adoption"
                        }
                  ]
            }
      ],
    }),
  ],
});
