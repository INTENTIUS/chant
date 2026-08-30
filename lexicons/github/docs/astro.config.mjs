// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/github/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/github/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'GitHub Actions',
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
                              "label": "Examples",
                              "slug": "examples"
                        },
                        {
                              "label": "Matrix Strategies",
                              "slug": "matrix"
                        },
                        {
                              "label": "Multiple Workflows",
                              "slug": "multi-workflow"
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
                              "label": "Actions & Composites",
                              "slug": "actions"
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
                              "label": "Expressions",
                              "slug": "expressions"
                        },
                        {
                              "label": "Lint Rules",
                              "slug": "lint-rules"
                        },
                        {
                              "label": "Variables",
                              "slug": "variables"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Workflow Concepts",
                              "slug": "workflow-concepts"
                        },
                        {
                              "label": "Workflows",
                              "slug": "workflows"
                        }
                  ]
            }
      ],
    }),
  ],
});
