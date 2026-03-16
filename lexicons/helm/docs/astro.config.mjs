// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  base: '/chant/lexicons/helm/',
  integrations: [
    starlight({
      title: 'Helm Charts',
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
                  "label": "Helm Concepts",
                  "slug": "helm-concepts"
            },
            {
                  "label": "Composites",
                  "slug": "composites"
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
                  "label": "Skills",
                  "slug": "skills"
            },
            {
                  "label": "Intrinsics",
                  "slug": "intrinsics"
            },
            {
                  "label": "Serialization",
                  "slug": "serialization"
            }
      ],
    }),
  ],
});
