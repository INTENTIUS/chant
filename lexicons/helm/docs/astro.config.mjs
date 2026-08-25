// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/helm/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/helm/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Helm',
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
                              "label": "Best Practices",
                              "slug": "best-practices"
                        },
                        {
                              "label": "chant helm",
                              "slug": "cli"
                        },
                        {
                              "label": "Examples",
                              "slug": "examples"
                        },
                        {
                              "label": "Security",
                              "slug": "security"
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "Intrinsics",
                              "slug": "intrinsics"
                        },
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
                              "label": "Composites",
                              "slug": "composites"
                        },
                        {
                              "label": "Intrinsics Reference",
                              "slug": "intrinsics-guide"
                        },
                        {
                              "label": "Lint Rules",
                              "slug": "lint-rules"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Helm Concepts",
                              "slug": "helm-concepts"
                        },
                        {
                              "label": "Live Observation",
                              "slug": "observation"
                        }
                  ]
            }
      ],
    }),
  ],
});
