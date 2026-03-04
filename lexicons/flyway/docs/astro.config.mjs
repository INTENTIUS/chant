// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  base: '/chant/lexicons/flyway/',
  integrations: [
    starlight({
      title: 'Flyway',
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
                  "label": "Flyway Concepts",
                  "slug": "flyway-concepts"
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
                  "label": "Composites",
                  "slug": "composites"
            },
            {
                  "label": "Getting Started",
                  "slug": "getting-started"
            },
            {
                  "label": "Importing TOML",
                  "slug": "importing-toml"
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
