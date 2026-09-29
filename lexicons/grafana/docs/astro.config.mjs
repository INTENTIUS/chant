// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/grafana/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/grafana/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Grafana',
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
                              "label": "Provisioning",
                              "slug": "provisioning"
                        },
                        {
                              "label": "Alerting",
                              "slug": "alerting"
                        },
                        {
                              "label": "Importing Dashboards",
                              "slug": "importing"
                        },
                        {
                              "label": "Other Panel and Datasource Plugins",
                              "slug": "custom-plugins"
                        },
                        {
                              "label": "Examples",
                              "slug": "examples"
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "Dashboards and Panels",
                              "slug": "dashboards-and-panels"
                        },
                        {
                              "label": "Queries and Datasources",
                              "slug": "queries-and-datasources"
                        },
                        {
                              "label": "Dashboards from Declarations",
                              "slug": "composites"
                        },
                        {
                              "label": "Lint Rules",
                              "slug": "lint-rules"
                        },
                        {
                              "label": "All Rules",
                              "slug": "rules"
                        },
                        {
                              "label": "Serialization",
                              "slug": "serialization"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Where the Types Come From",
                              "slug": "schema-pin"
                        }
                  ]
            }
      ],
    }),
  ],
});
