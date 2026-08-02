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
                  "label": "Getting Started",
                  "slug": "getting-started"
            },
            {
                  "label": "Intrinsics Reference",
                  "slug": "intrinsics-guide"
            },
            {
                  "label": "Composites",
                  "slug": "composites"
            },
            {
                  "label": "Security",
                  "slug": "security"
            },
            {
                  "label": "Best Practices",
                  "slug": "best-practices"
            },
            {
                  "label": "AI Skills",
                  "slug": "skills"
            },
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
                  "label": "Helm Concepts",
                  "slug": "helm-concepts"
            },
            {
                  "label": "Lint Rules",
                  "slug": "lint-rules"
            },
            {
                  "label": "Examples",
                  "slug": "examples"
            }
      ],
    }),
  ],
});
