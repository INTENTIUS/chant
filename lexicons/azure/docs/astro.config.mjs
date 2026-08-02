// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/azure/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/azure/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Azure Resource Manager',
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
                  "label": "Intrinsics",
                  "slug": "intrinsics"
            },
            {
                  "label": "Pseudo-Parameters",
                  "slug": "pseudo-parameters"
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
                  "label": "Resources",
                  "slug": "resources"
            },
            {
                  "label": "Parameters & Outputs",
                  "slug": "parameters-outputs"
            },
            {
                  "label": "Composites",
                  "slug": "composites"
            },
            {
                  "label": "Linked Templates",
                  "slug": "linked-templates"
            },
            {
                  "label": "Lint Rules",
                  "slug": "lint-rules"
            },
            {
                  "label": "Importing ARM Templates",
                  "slug": "importing"
            },
            {
                  "label": "Deploying to AKS",
                  "slug": "aks-kubernetes"
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
