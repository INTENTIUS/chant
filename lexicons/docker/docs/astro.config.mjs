// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

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
                              "label": "Importing",
                              "slug": "importing"
                        },
                        {
                              "label": "Operational Playbook",
                              "slug": "operational-playbook"
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
                              "label": "Compose Resources",
                              "slug": "compose-resources"
                        },
                        {
                              "label": "Default Labels",
                              "slug": "default-labels"
                        },
                        {
                              "label": "Dockerfiles",
                              "slug": "dockerfiles"
                        },
                        {
                              "label": "Lint Rules",
                              "slug": "lint-rules"
                        },
                        {
                              "label": "Variable Interpolation",
                              "slug": "interpolation"
                        }
                  ]
            }
      ],
    }),
  ],
});
