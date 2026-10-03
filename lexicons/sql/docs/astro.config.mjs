// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/sql/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/sql/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'SQL',
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
                              "label": "Declaring Tables and Views",
                              "slug": "clickhouse-ddl"
                        },
                        {
                              "label": "Importing a Live Server",
                              "slug": "importing"
                        },
                        {
                              "label": "Applying to a Server",
                              "slug": "applying"
                        },
                        {
                              "label": "Rebuilding a Table",
                              "slug": "rebuild"
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "Planning and the Change Classifier",
                              "slug": "change-classifier"
                        },
                        {
                              "label": "Composites",
                              "slug": "composites"
                        },
                        {
                              "label": "Postgres Locks and the Change Classifier",
                              "slug": "postgres-change-classifier"
                        },
                        {
                              "label": "Lint Rules and Checks",
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
                              "label": "References and Lineage",
                              "slug": "references-and-lineage"
                        },
                        {
                              "label": "Where the Types Come From",
                              "slug": "clickhouse-catalog"
                        }
                  ]
            }
      ],
    }),
  ],
});
