// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  base: '/chant/lexicons/azure/',
  integrations: [
    starlight({
      title: 'Azure',
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
          "label": "Resources",
          "slug": "resources"
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
          "label": "Composites",
          "slug": "composites"
        },
        {
          "label": "Parameters & Outputs",
          "slug": "parameters-outputs"
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
          "label": "Linked Templates",
          "slug": "linked-templates"
        },
        {
          "label": "Examples",
          "slug": "examples"
        },
        {
          "label": "Deploying to AKS",
          "slug": "aks-kubernetes"
        }
      ],
    }),
  ],
});
