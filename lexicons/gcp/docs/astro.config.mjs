// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/gcp/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/gcp/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'GCP Config Connector',
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
                              "label": "Deploying to GKE",
                              "slug": "gke-kubernetes"
                        },
                        {
                              "label": "Examples: Composites",
                              "slug": "composite-examples"
                        },
                        {
                              "label": "Examples: Resources",
                              "slug": "examples"
                        },
                        {
                              "label": "Importing Existing YAML",
                              "slug": "importing-yaml"
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
                              "label": "Lint Rules",
                              "slug": "lint-rules"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Config Connector Concepts",
                              "slug": "config-connector-concepts"
                        }
                  ]
            }
      ],
    }),
  ],
});
