// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/prometheus/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/prometheus/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Prometheus',
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
                              "label": "On Kubernetes",
                              "slug": "kubernetes"
                        },
                        {
                              "label": "Checking with promtool and amtool",
                              "slug": "upstream-tools"
                        },
                        {
                              "label": "Examples",
                              "slug": "examples"
                        },
                        {
                              "label": "Importing Rule Files and alertmanager.yml",
                              "slug": "importing"
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "Rule Groups",
                              "slug": "rule-groups"
                        },
                        {
                              "label": "Alertmanager",
                              "slug": "alertmanager"
                        },
                        {
                              "label": "SLOs",
                              "slug": "slos"
                        },
                        {
                              "label": "Lint Rules",
                              "slug": "lint-rules"
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
                              "label": "How Prometheus Maps to Chant",
                              "slug": "design"
                        }
                  ]
            }
      ],
    }),
  ],
});
