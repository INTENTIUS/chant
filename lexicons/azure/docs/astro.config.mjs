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
                              "label": "Deploying to AKS",
                              "slug": "aks-kubernetes"
                        },
                        {
                              "label": "Examples",
                              "slug": "examples"
                        },
                        {
                              "label": "Importing ARM Templates",
                              "slug": "importing"
                        },
                        {
                              "label": "Linked Templates",
                              "slug": "linked-templates"
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
                              "label": "AI Skills",
                              "slug": "skills"
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
                              "label": "Parameters & Outputs",
                              "slug": "parameters-outputs"
                        },
                        {
                              "label": "Resources",
                              "slug": "resources"
                        }
                  ]
            }
      ],
    }),
  ],
});
