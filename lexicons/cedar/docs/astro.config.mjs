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
                              "label": "Importing",
                              "slug": "importing"
                        },
                        {
                              "label": "Dogwood",
                              "items": [
                                    {
                                          "label": "Replay",
                                          "slug": "dogwood-replay"
                                    }
                              ]
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "All Rules",
                              "slug": "rules"
                        },
                        {
                              "label": "Serialization",
                              "slug": "serialization"
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
                              "label": "Policies",
                              "slug": "policies"
                        },
                        {
                              "label": "Resources",
                              "slug": "resources"
                        },
                        {
                              "label": "Schema",
                              "slug": "schema"
                        },
                        {
                              "label": "Dogwood",
                              "items": [
                                    {
                                          "label": "Dogwood Validation",
                                          "slug": "dogwood-validation"
                                    },
                                    {
                                          "label": "Event Schemas",
                                          "slug": "dogwood-event-schemas"
                                    },
                                    {
                                          "label": "Temporal Policies",
                                          "slug": "dogwood-temporal-policies"
                                    }
                              ]
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Verified Permissions",
                              "slug": "avp"
                        },
                        {
                              "label": "Dogwood",
                              "items": [
                                    {
                                          "label": "The Dogwood Dialect",
                                          "slug": "dogwood"
                                    }
                              ]
                        }
                  ]
            }
      ],
    }),
  ],
});
