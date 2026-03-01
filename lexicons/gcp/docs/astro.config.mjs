// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  base: '/chant/lexicons/gcp/',
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
                  "label": "Getting Started",
                  "slug": "getting-started"
            },
            {
                  "label": "Config Connector Concepts",
                  "slug": "config-connector-concepts"
            },
            {
                  "label": "Lint Rules",
                  "slug": "lint-rules"
            },
            {
                  "label": "Examples: Resources",
                  "slug": "examples"
            },
            {
                  "label": "Examples: Composites",
                  "slug": "composite-examples"
            },
            {
                  "label": "Operational Playbook",
                  "slug": "operational-playbook"
            },
            {
                  "label": "Importing Existing YAML",
                  "slug": "importing-yaml"
            },
            {
                  "label": "AI Skills",
                  "slug": "skills"
            },
            {
                  "label": "Pseudo-Parameters",
                  "slug": "pseudo-parameters"
            },
            {
                  "label": "Serialization",
                  "slug": "serialization"
            }
      ],
    }),
  ],
});
