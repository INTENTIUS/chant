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
                              "label": "ClickHouse",
                              "items": [
                                    {
                                          "label": "Getting Started",
                                          "slug": "getting-started"
                                    }
                              ]
                        },
                        {
                              "label": "Postgres",
                              "items": [
                                    {
                                          "label": "Getting Started",
                                          "slug": "postgres-getting-started"
                                    }
                              ]
                        }
                  ]
            },
            {
                  "label": "How-to guides",
                  "items": [
                        {
                              "label": "Watching a Server for Drift",
                              "slug": "drift-watch"
                        },
                        {
                              "label": "Data Batches with Receipts",
                              "slug": "data-batches"
                        },
                        {
                              "label": "ClickHouse",
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
                              "label": "Postgres",
                              "items": [
                                    {
                                          "label": "Declaring Objects",
                                          "slug": "postgres-ddl"
                                    },
                                    {
                                          "label": "Importing a Live Server",
                                          "slug": "postgres-importing"
                                    },
                                    {
                                          "label": "Access",
                                          "slug": "postgres-access"
                                    },
                                    {
                                          "label": "Applying to a Server",
                                          "slug": "postgres-applying"
                                    },
                                    {
                                          "label": "Migrating a Column",
                                          "slug": "postgres-migration"
                                    }
                              ]
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "Composites",
                              "slug": "composites"
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
                        },
                        {
                              "label": "ClickHouse",
                              "items": [
                                    {
                                          "label": "Planning and the Change Classifier",
                                          "slug": "change-classifier"
                                    }
                              ]
                        },
                        {
                              "label": "Postgres",
                              "items": [
                                    {
                                          "label": "Locks and the Change Classifier",
                                          "slug": "postgres-change-classifier"
                                    },
                                    {
                                          "label": "Managed Providers",
                                          "slug": "postgres-providers"
                                    }
                              ]
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
                              "label": "ClickHouse",
                              "items": [
                                    {
                                          "label": "Where the Types Come From",
                                          "slug": "clickhouse-catalog"
                                    }
                              ]
                        },
                        {
                              "label": "Postgres",
                              "items": [
                                    {
                                          "label": "Pin and Supported Majors",
                                          "slug": "postgres-majors"
                                    }
                              ]
                        }
                  ]
            }
      ],
    }),
  ],
});
