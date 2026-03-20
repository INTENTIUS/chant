// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  base: '/chant/lexicons/docker/',
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
                  "label": "Services & Volumes",
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
                  "label": "Serialization",
                  "slug": "serialization"
            }
      ],
    }),
  ],
});
