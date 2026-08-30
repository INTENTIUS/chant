// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/gitlab/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/gitlab/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'GitLab CI/CD',
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
                              "label": "Examples",
                              "slug": "examples"
                        },
                        {
                              "label": "Migration",
                              "slug": "migration"
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
                              "label": "Intrinsics Guide",
                              "slug": "intrinsics-guide"
                        },
                        {
                              "label": "Lint Rules",
                              "slug": "lint-rules"
                        },
                        {
                              "label": "Predefined Variables",
                              "slug": "variables"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Pipeline Concepts",
                              "slug": "pipeline-concepts"
                        }
                  ]
            }
      ],
    }),
  ],
});
