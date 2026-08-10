// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/cedar/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/cedar/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Cedar',
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
                  "label": "Schema",
                  "slug": "schema"
            },
            {
                  "label": "Resources",
                  "slug": "resources"
            },
            {
                  "label": "Policies",
                  "slug": "policies"
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
                  "label": "Importing",
                  "slug": "importing"
            },
            {
                  "label": "Verified Permissions",
                  "slug": "avp"
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
                  "label": "Dogwood",
                  "items": [
                        {
                              "label": "The Dialect",
                              "slug": "dogwood"
                        },
                        {
                              "label": "Temporal Policies",
                              "slug": "dogwood-temporal-policies"
                        },
                        {
                              "label": "Event Schemas",
                              "slug": "dogwood-event-schemas"
                        },
                        {
                              "label": "Validation",
                              "slug": "dogwood-validation"
                        },
                        {
                              "label": "Replay",
                              "slug": "dogwood-replay"
                        }
                  ]
            }
      ],
    }),
  ],
});
