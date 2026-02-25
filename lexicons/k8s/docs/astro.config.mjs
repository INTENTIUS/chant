// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  base: '/chant/lexicons/k8s/',
  integrations: [
    starlight({
      title: 'Kubernetes',
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
                  "label": "Kubernetes Concepts",
                  "slug": "kubernetes-concepts"
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
                  "label": "Testing & Validation",
                  "slug": "testing"
            },
            {
                  "label": "AI Skills",
                  "slug": "skills"
            },
            {
                  "label": "Serialization",
                  "slug": "serialization"
            }
      ],
    }),
  ],
});
