// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from '../../../packages/core/src/codegen/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/docker/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/docker/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Docker',
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
                  "label": "Compose Resources",
                  "slug": "compose-resources"
            },
            {
                  "label": "Dockerfiles",
                  "slug": "dockerfiles"
            },
            {
                  "label": "Variable Interpolation",
                  "slug": "interpolation"
            },
            {
                  "label": "Default Labels",
                  "slug": "default-labels"
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
                  "label": "Importing",
                  "slug": "importing"
            },
            {
                  "label": "Serialization",
                  "slug": "serialization"
            },
            {
                  "label": "Operational Playbook",
                  "slug": "operational-playbook"
            },
            {
                  "label": "AI Skills",
                  "slug": "skills"
            }
      ],
    }),
  ],
});
