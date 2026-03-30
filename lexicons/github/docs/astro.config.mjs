// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  base: '/chant/lexicons/github/',
  integrations: [
    starlight({
      title: 'GitHub Actions',
      sidebar: [
            {
                  "label": "\u2190 chant docs",
                  "link": "../../"
            },
            {
                  "label": "Overview",
                  "slug": "index"
            },
            {
                  "label": "Getting Started",
                  "slug": "getting-started"
            },
            {
                  "label": "Workflows",
                  "slug": "workflows"
            },
            {
                  "label": "Multiple Workflows",
                  "slug": "multi-workflow"
            },
            {
                  "label": "Actions & Composites",
                  "slug": "actions"
            },
            {
                  "label": "Expressions",
                  "slug": "expressions"
            },
            {
                  "label": "Matrix Strategies",
                  "slug": "matrix"
            },
            {
                  "label": "Lint Rules",
                  "slug": "lint-rules"
            },
            {
                  "label": "Examples",
                  "slug": "examples"
            },
            {
                  "label": "AI Skills",
                  "slug": "skills"
            }
      ],
    }),
  ],
});
