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
                  "label": "All Rules",
                  "slug": "rules"
            },
            {
                  "label": "Serialization",
                  "slug": "serialization"
            },
            {
                  "label": "Getting Started",
                  "slug": "getting-started"
            },
            {
                  "label": "Temporal Concepts",
                  "slug": "temporal-concepts"
            },
            {
                  "label": "Resources",
                  "slug": "resources"
            },
            {
                  "label": "Ops",
                  "slug": "ops"
            },
            {
                  "label": "Worker Profiles",
                  "slug": "worker-profiles"
            },
            {
                  "label": "Lint Rules",
                  "slug": "lint-rules"
            },
            {
                  "label": "AI Skills",
                  "slug": "skills"
            }
      ],
    }),
  ],
});
